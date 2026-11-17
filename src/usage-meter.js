// Medidor de uso por loja: quanto cada loja usa do servidor e do banco, para ratear os custos.
//  - Cada requisição ganha um contexto (AsyncLocalStorage). As consultas ao banco feitas nela somam
//    tempo e quantidade nesse contexto; no fim da resposta, tudo vai para a loja dona da requisição.
//  - Dono: loja do usuário logado (lojista/operador), loja do computador (agente), loja do pedido
//    (links públicos, deduzida da primeira linha com tenant_id) ou 'platform' (central, rotinas).
//  - O Neon cobra pelo tempo em que o banco fica ACORDADO, não pelo tempo de cada consulta. Por isso
//    o rateio principal usa janelas de 5 min: cada janela em que o banco foi usado é dividida entre
//    quem o usou nela (slot_share).
// Os totais ficam em memória e são gravados por dia em tenant_usage_daily junto com uma consulta
// de verdade (o banco já está acordado), no máximo a cada 10 min, e quando o servidor desliga.
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const als = new AsyncLocalStorage();
const SLOT = 5 * 60000, FLUSH_EVERY = Number(process.env.USAGE_FLUSH_MS) || 10 * 60000, TZ_OFFSET = 3 * 3600000; // Fortaleza = UTC-3, sem horário de verão
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC = /^\/(api\/public\/|api\/edge\/|p\/|demo\/|[a-z0-9-]{3,60}\/\d{4,5}\/?(\?|$))/;
const enabled = () => process.env.USAGE_METER !== 'off';

const days = new Map();   // 'YYYY-MM-DD|subject' -> { requests, bytes_out, db_queries, db_ms }
const slots = new Map();  // início da janela (ms) -> Set(subject)
let lastFlush = Date.now(), flushing = null, pool = null;

const dayOf = t => new Date(t - TZ_OFFSET).toISOString().slice(0, 10);
function bucket(subject, t = Date.now()) {
  const k = dayOf(t) + '|' + subject;
  let b = days.get(k); if (!b) days.set(k, b = { requests: 0, bytes_out: 0, db_queries: 0, db_ms: 0 });
  return b;
}
function touch(subject, t) {
  const s = Math.floor(t / SLOT) * SLOT;
  let set = slots.get(s); if (!set) slots.set(s, set = new Set());
  set.add(subject);
}

// Chamado pelo wrapper do pg depois de cada consulta.
function recordQuery(ms, result, ctx = als.getStore()) {
  if (!enabled() || flushing) return;
  const now = Date.now();
  if (ctx?.internal) return;
  if (!ctx) { const b = bucket('platform', now); b.db_queries++; b.db_ms += ms; touch('platform', now); maybeFlush(); return; }
  ctx.queries++; ctx.ms += ms; ctx.slots.add(Math.floor(now / SLOT) * SLOT);
  const row = result?.rows?.[0];
  if (!ctx.guess && row && typeof row.tenant_id === 'string' && UUID.test(row.tenant_id)) ctx.guess = row.tenant_id;
}

function subjectOf(req, res, ctx) {
  const u = req.user;
  if (u) return u.tenant_id && ['owner', 'operator'].includes(u.role) ? u.tenant_id : 'platform';
  if (req.device?.tenant_id) return req.device.tenant_id;
  if (res.locals?.meterTenant) return res.locals.meterTenant;
  // Sem login: só rotas públicas da loja (link do cliente, vídeo, fotos). Rotas internas são da plataforma.
  if (ctx.guess && PUBLIC.test(req.originalUrl)) return ctx.guess;
  return 'platform';
}

export function meterMiddleware(req, res, next) {
  if (!enabled()) return next();
  const ctx = { queries: 0, ms: 0, slots: new Set(), guess: null, bytes: 0 };
  const write = res.write, end = res.end;
  const count = chunk => { if (chunk && typeof chunk !== 'function') ctx.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length || 0; };
  res.write = function (chunk, ...rest) { count(chunk); return write.call(this, chunk, ...rest); };
  res.end = function (chunk, ...rest) { count(chunk); return end.call(this, chunk, ...rest); };
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const subject = subjectOf(req, res, ctx), now = Date.now(), b = bucket(subject, now);
    b.requests++; b.bytes_out += ctx.bytes; b.db_queries += ctx.queries; b.db_ms += ctx.ms;
    for (const s of ctx.slots) { let set = slots.get(s); if (!set) slots.set(s, set = new Set()); set.add(subject); }
    maybeFlush();
  };
  res.once('finish', commit); res.once('close', commit);
  als.run(ctx, next);
}

// Envolve client.query de cada conexão do pool (pool.query e transações passam por aqui).
export function instrumentPool(db) {
  pool = db;
  // pool.query pega a conexão com um callback; se ela estava na fila, o callback roda no contexto
  // de quem a liberou. Prende o callback ao contexto de quem pediu (a loja certa).
  const connect = db.connect;
  db.connect = function (cb) { return typeof cb === 'function' ? connect.call(this, AsyncResource.bind(cb)) : connect.call(this); };
  db.on('connect', client => {
    if (client.__meter) return; client.__meter = true;
    const orig = client.query;
    client.query = function (...args) {
      if (!enabled() || flushing) return orig.apply(this, args);
      // O contexto (loja) é lido na chamada: a resposta do banco chega no contexto da conexão.
      const ctx = als.getStore(), t0 = performance.now(), last = args[args.length - 1];
      if (typeof last === 'function') {
        args[args.length - 1] = function (err, res) { recordQuery(performance.now() - t0, err ? null : res, ctx); return last.apply(this, arguments); };
        return orig.apply(this, args);
      }
      const r = orig.apply(this, args);
      if (r && typeof r.then === 'function') r.then(res => recordQuery(performance.now() - t0, res, ctx), () => recordQuery(performance.now() - t0, null, ctx));
      return r;
    };
  });
}

// Janelas fechadas (mais de 5 min atrás) viram active_slots / slot_share por dia e loja.
function closeSlots(now, all = false) {
  const per = new Map(); // 'day|subject' -> { active, share }
  for (const [s, set] of slots) {
    if (!all && s + SLOT > now - 60000) continue;
    const share = 1 / set.size;
    for (const subject of set) {
      const k = dayOf(s) + '|' + subject; const v = per.get(k) || { active: 0, share: 0 };
      v.active++; v.share += share; per.set(k, v);
    }
    slots.delete(s);
  }
  return per;
}

export function snapshot(now = Date.now(), all = false) {
  const per = closeSlots(now, all), rows = [];
  const keys = new Set([...days.keys(), ...per.keys()]);
  for (const k of keys) {
    const [day, subject] = k.split('|'), b = days.get(k) || { requests: 0, bytes_out: 0, db_queries: 0, db_ms: 0 }, s = per.get(k) || { active: 0, share: 0 };
    rows.push({ day, subject, ...b, active_slots: s.active, slot_share: s.share });
  }
  days.clear();
  return rows;
}

async function writeRows(rows) {
  if (!rows.length || !pool) return;
  await als.run({ internal: true }, () => pool.query(`
    INSERT INTO tenant_usage_daily(day,subject,tenant_id,requests,bytes_out,db_queries,db_ms,active_slots,slot_share)
    SELECT r.day::date, r.subject, CASE WHEN r.subject='platform' THEN NULL ELSE (SELECT id FROM tenants WHERE id::text=r.subject) END,
           r.requests, r.bytes_out, r.db_queries, r.db_ms, r.active_slots, r.slot_share
    FROM jsonb_to_recordset($1::jsonb) AS r(day text, subject text, requests int, bytes_out bigint, db_queries int, db_ms float8, active_slots int, slot_share float8)
    ON CONFLICT (day, subject) DO UPDATE SET requests=tenant_usage_daily.requests+EXCLUDED.requests, bytes_out=tenant_usage_daily.bytes_out+EXCLUDED.bytes_out,
      db_queries=tenant_usage_daily.db_queries+EXCLUDED.db_queries, db_ms=tenant_usage_daily.db_ms+EXCLUDED.db_ms,
      active_slots=tenant_usage_daily.active_slots+EXCLUDED.active_slots, slot_share=tenant_usage_daily.slot_share+EXCLUDED.slot_share,
      tenant_id=COALESCE(tenant_usage_daily.tenant_id, EXCLUDED.tenant_id)`, [JSON.stringify(rows)]));
}

export async function flushUsage({ all = false } = {}) {
  if (flushing) return flushing;
  lastFlush = Date.now();
  const rows = snapshot(Date.now(), all);
  flushing = writeRows(rows).catch(err => {
    // Banco fora: devolve os totais para a memória e tenta de novo na próxima.
    for (const r of rows) { const b = bucket(r.subject, Date.parse(r.day + 'T12:00:00Z')); b.requests += r.requests; b.bytes_out += r.bytes_out; b.db_queries += r.db_queries; b.db_ms += r.db_ms; }
    console.error('Medidor de uso: falha ao gravar', err.code || err.name);
  }).finally(() => { flushing = null; });
  return flushing;
}
function maybeFlush() { if (Date.now() - lastFlush >= FLUSH_EVERY && !flushing) setImmediate(() => { void flushUsage(); }); }

let shutdownHooked = false;
export function hookShutdown() {
  if (shutdownHooked) return; shutdownHooked = true;
  const stop = async sig => {
    try { await Promise.race([flushUsage({ all: true }), new Promise(r => setTimeout(r, 5000))]); } finally { process.exit(sig === 'SIGINT' ? 130 : 0); }
  };
  process.once('SIGTERM', () => stop('SIGTERM')); process.once('SIGINT', () => stop('SIGINT'));
}

export const _test = { als, recordQuery, closeSlots, days, slots, subjectOf };
