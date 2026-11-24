// Cobrança das lojas pelo Asaas (central → Cobranças).
// - Quem paga: billing_accounts, uma por loja avulsa ou por rede (a Audace paga uma conta só pelas 7 unidades).
//   "Isenta" nunca gera cobrança nem bloqueia (ELITECH). Loja sem cadastro de cobrança nunca é bloqueada.
// - A central cria no Asaas: o cliente (CPF/CNPJ), cobranças avulsas ou parceladas (ex.: implantação em 3x,
//   cada parcela com valor e vencimento próprios) e a mensalidade (assinatura mensal do Asaas).
// - O Asaas avisa por webhook (token no header asaas-access-token); cada aviso é guardado pelo id e só
//   processado uma vez. A situação da cobrança é conferida na API antes de gravar (aviso fora de ordem não
//   desfaz pagamento). A cada 30 min (no expediente) tudo é conferido de novo, para o caso de aviso perdido.
// - Bloqueio: cobrança em aberto há mais de "carência" dias depois do vencimento → loja (ou rede inteira)
//   suspensa. Antes de bloquear, a cobrança é consultada no Asaas; se a consulta falhar, não bloqueia.
//   Pagou → libera sozinho (só o que a cobrança bloqueou; suspensão manual da central continua).
// Variáveis: ASAAS_API_KEY ($aact_prod_… ou $aact_hmlg_… do sandbox). Opcionais: ASAAS_API_URL,
// ASAAS_WEBHOOK_TOKEN (sem ela, derivado do JWT_SECRET), BILLING_SYNC=off.
import crypto from 'node:crypto';
import { z } from 'zod';
import { backgroundAllowed } from './quiet-hours.js';
import { STORE_TZ } from './auto-close.js';

const KEY = () => (process.env.ASAAS_API_KEY || '').trim();
export const asaasEnv = () => { const k = KEY(); if (!k) return null; return /aact_hmlg_/.test(k) ? 'sandbox' : 'production'; };
const API = () => (process.env.ASAAS_API_URL || (asaasEnv() === 'sandbox' ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3')).replace(/\/$/, '');
const BASE = () => (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
export const WEBHOOK_PATH = '/api/internal/asaas/webhook';
export const asaasWebhookToken = () => (process.env.ASAAS_WEBHOOK_TOKEN || '').trim() || crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev').update('asaas-webhook-v1').digest('base64url');
const sameToken = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export const PAID = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
export const OPEN = ['PENDING', 'OVERDUE'];
const EVENTS = ['PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_RESTORED', 'PAYMENT_REFUNDED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_BANK_SLIP_CANCELLED'];

export const todayLocal = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: STORE_TZ }).format(d);
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isoDate = v => v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null;
const cents = v => Math.round(Number(v || 0) * 100);
const reais = c => Number((c / 100).toFixed(2));

export async function asaas(method, path, body) {
  if (!KEY()) { const e = new Error('Asaas não configurado: falta ASAAS_API_KEY no servidor'); e.status = 503; throw e; }
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(API() + path, { method, signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'User-Agent': 'FicouPronto/1.0 (central)', access_token: KEY() }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { /* não-JSON */ }
    if (!r.ok) {
      const detail = data?.errors?.map(x => x.description).filter(Boolean).join('; ') || text.slice(0, 200) || ('HTTP ' + r.status);
      const e = new Error('Asaas: ' + detail); e.status = r.status; e.asaas = true; throw e;
    }
    return data || {};
  } catch (e) {
    if (e.name === 'AbortError') { const t = new Error('Asaas não respondeu a tempo'); t.status = 504; t.asaas = true; throw t; }
    throw e;
  } finally { clearTimeout(timer); }
}

// ---- Gravação das cobranças vindas do Asaas ----
async function accountForPayment(q, p) {
  const byCharge = (await q('SELECT account_id,subscription_id,kind FROM billing_charges WHERE asaas_payment_id=$1', [p.id])).rows[0];
  if (byCharge) return byCharge;
  if (p.subscription) {
    const s = (await q('SELECT id,account_id FROM billing_subscriptions WHERE asaas_subscription_id=$1', [p.subscription])).rows[0];
    if (s) return { account_id: s.account_id, subscription_id: s.id, kind: 'monthly' };
  }
  if (p.customer) {
    const a = (await q('SELECT id FROM billing_accounts WHERE asaas_customer_id=$1', [p.customer])).rows[0];
    if (a) return { account_id: a.id, subscription_id: null, kind: 'other' };
  }
  return null; // cobrança do Asaas que não é de loja do Ficou Pronto: ignora.
}

export async function upsertPayment(q, p, extra = {}) {
  if (!p?.id) return null;
  const link = await accountForPayment(q, p); if (!link) return null;
  const r = await q(`INSERT INTO billing_charges(account_id,subscription_id,kind,description,value_cents,due_date,status,deleted,asaas_payment_id,invoice_url,bank_slip_url,billing_type,paid_at,paid_value_cents,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT(asaas_payment_id) DO UPDATE SET value_cents=EXCLUDED.value_cents,due_date=EXCLUDED.due_date,status=EXCLUDED.status,deleted=EXCLUDED.deleted,
      invoice_url=COALESCE(EXCLUDED.invoice_url,billing_charges.invoice_url),bank_slip_url=COALESCE(EXCLUDED.bank_slip_url,billing_charges.bank_slip_url),
      billing_type=EXCLUDED.billing_type,paid_at=EXCLUDED.paid_at,paid_value_cents=EXCLUDED.paid_value_cents,
      description=COALESCE(NULLIF(billing_charges.description,''),EXCLUDED.description),updated_at=now()
    RETURNING *`,
    [link.account_id, link.subscription_id, extra.kind || link.kind || 'other', extra.description ?? p.description ?? '', cents(p.value), isoDate(p.dueDate), String(p.status || 'PENDING'), !!p.deleted, p.id,
      p.invoiceUrl || null, p.bankSlipUrl || null, p.billingType || null, isoDate(p.paymentDate || p.clientPaymentDate || p.confirmedDate), PAID.includes(p.status) ? cents(p.value) : null, extra.created_by || null]);
  return r.rows[0];
}

// Busca a cobrança no Asaas e grava. 404 = apagada no Asaas.
async function refreshCharge(q, charge) {
  try { return await upsertPayment(q, await asaas('GET', '/payments/' + encodeURIComponent(charge.asaas_payment_id))); }
  catch (e) {
    if (e.status === 404) { await q('UPDATE billing_charges SET deleted=true,updated_at=now() WHERE id=$1', [charge.id]); return null; }
    throw e;
  }
}

export async function syncAccount(q, account) {
  if (!account.asaas_customer_id) return { ok: true, skipped: true };
  try {
    const seen = new Set();
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = await asaas('GET', '/payments?customer=' + encodeURIComponent(account.asaas_customer_id) + '&limit=100&offset=' + offset);
      for (const p of page.data || []) { seen.add(p.id); await upsertPayment(q, p); }
      if (!page.hasMore) break;
    }
    // Em aberto aqui e fora da lista do Asaas: confere uma a uma (pode ter sido apagada).
    const open = (await q("SELECT * FROM billing_charges WHERE account_id=$1 AND NOT deleted AND status = ANY($2) AND asaas_payment_id IS NOT NULL", [account.id, OPEN])).rows;
    for (const c of open) if (!seen.has(c.asaas_payment_id)) await refreshCharge(q, c);
    await q('UPDATE billing_accounts SET last_sync_at=now(),last_error=NULL WHERE id=$1', [account.id]);
    return { ok: true };
  } catch (e) {
    await q('UPDATE billing_accounts SET last_error=$2 WHERE id=$1', [account.id, String(e.message).slice(0, 300)]);
    return { ok: false, error: e.message };
  }
}

// ---- Bloqueio e liberação ----
async function setBlocked(q, a, blocked) {
  const target = a.tenant_id ? 'id=$1' : 'network_id=$1', id = a.tenant_id || a.network_id;
  if (blocked) {
    await q(`UPDATE tenants SET billing_prev_status=status,status='suspended' WHERE ${target} AND status IN ('trial','active')`, [id]);
    if (a.network_id) await q("UPDATE store_networks SET status='suspended',billing_blocked=true WHERE id=$1 AND status='active'", [a.network_id]);
    await q('UPDATE billing_accounts SET blocked_at=now() WHERE id=$1', [a.id]);
  } else {
    await q(`UPDATE tenants SET status=CASE WHEN status='suspended' THEN billing_prev_status ELSE status END,billing_prev_status=NULL WHERE ${target} AND billing_prev_status IS NOT NULL`, [id]);
    if (a.network_id) await q("UPDATE store_networks SET status=CASE WHEN status='suspended' THEN 'active' ELSE status END,billing_blocked=false WHERE id=$1 AND billing_blocked", [a.network_id]);
    await q('UPDATE billing_accounts SET blocked_at=NULL WHERE id=$1', [a.id]);
  }
  await q('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,NULL,$2,$3,$4)', [a.tenant_id || null, blocked ? 'billing_block' : 'billing_unblock', a.tenant_id ? 'tenant' : 'store_network', id]);
}

const overdueSql = `SELECT c.* FROM billing_charges c JOIN billing_accounts a ON a.id=c.account_id
  WHERE c.account_id=$1 AND NOT c.deleted AND c.status = ANY($2) AND c.due_date + a.grace_days < $3::date ORDER BY c.due_date`;

// Decide bloquear/liberar. skip: contas cuja conferência falhou nesta rodada (não bloqueia por falha de consulta).
export async function enforce(q, { accountId = null, refresh = true, skip = new Set() } = {}) {
  const today = todayLocal(), out = [];
  const accounts = (await q('SELECT * FROM billing_accounts' + (accountId ? ' WHERE id=$1' : ''), accountId ? [accountId] : [])).rows;
  for (const a of accounts) {
    let block = false;
    const override = a.block_override_until && isoDate(a.block_override_until) >= today;
    if (a.mode === 'charge' && a.auto_block && !override) {
      let overdue = (await q(overdueSql, [a.id, OPEN, today])).rows;
      if (overdue.length && !a.blocked_at) {
        if (skip.has(a.id)) continue;
        if (refresh) {
          try { for (const c of overdue) if (c.asaas_payment_id) await refreshCharge(q, c); }
          catch (e) { await q('UPDATE billing_accounts SET last_error=$2 WHERE id=$1', [a.id, 'Não bloqueado: falha ao conferir no Asaas (' + String(e.message).slice(0, 200) + ')']); continue; }
          overdue = (await q(overdueSql, [a.id, OPEN, today])).rows;
        }
      }
      block = overdue.length > 0;
    }
    if (block && !a.blocked_at) { await setBlocked(q, a, true); out.push({ id: a.id, action: 'blocked' }); }
    else if (!block && a.blocked_at) { await setBlocked(q, a, false); out.push({ id: a.id, action: 'unblocked' }); }
  }
  return out;
}

// ---- Mensalidade por unidade (rede) ----
// Próximo vencimento no dia escolhido: este mês se ainda não passou (inclusive hoje), senão o mês que vem.
export const nextDueOn = (day, today = todayLocal()) => {
  const [y, m, d] = today.split('-').map(Number);
  const base = d <= day ? new Date(Date.UTC(y, m - 1, day)) : new Date(Date.UTC(y, m, day));
  return base.toISOString().slice(0, 10);
};
const perUnitDescription = units => {
  const names = units.map(u => u.unit_label || u.name).join(', ');
  return ('Mensalidade Ficou Pronto — ' + units.length + (units.length === 1 ? ' unidade: ' : ' unidades: ') + names).slice(0, 160);
};
// Deixa a assinatura do Asaas igual às unidades liberadas: cria, muda o valor (inclusive da cobrança
// em aberto: mês cheio) ou cancela quando não sobra unidade. Idempotente: o loop de 30 min corrige falhas.
export async function syncPerUnit(q, a) {
  if (!a?.network_id || !a.unit_price_cents || a.mode !== 'charge' || !a.asaas_customer_id || !KEY()) return { skipped: true };
  const units = (await q('SELECT id,name,unit_label FROM tenants WHERE network_id=$1 AND billing_since IS NOT NULL ORDER BY billing_since, lower(coalesce(unit_label,name))', [a.network_id])).rows;
  const n = units.length, value = n * a.unit_price_cents, description = perUnitDescription(units);
  const sub = (await q("SELECT * FROM billing_subscriptions WHERE account_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1", [a.id])).rows[0];
  if (sub && !sub.per_unit) { const e = new Error('Já existe uma mensalidade de valor fixo: cancele-a para cobrar por unidade'); e.status = 409; throw e; }
  if (!n) {
    if (!sub) return { units: 0 };
    try { if (sub.asaas_subscription_id) await asaas('DELETE', '/subscriptions/' + encodeURIComponent(sub.asaas_subscription_id)); } catch (e) { if (e.status !== 404) throw e; }
    await q("UPDATE billing_subscriptions SET status='canceled',canceled_at=now() WHERE id=$1", [sub.id]);
    await syncAccount(q, a); return { units: 0, action: 'canceled' };
  }
  if (!sub) {
    const first = nextDueOn(a.due_day || 20);
    const s = await asaas('POST', '/subscriptions', { customer: a.asaas_customer_id, billingType: a.billing_type, value: reais(value), nextDueDate: first, cycle: 'MONTHLY', description, externalReference: 'fp-account:' + a.id });
    await q('INSERT INTO billing_subscriptions(account_id,description,value_cents,first_due_date,asaas_subscription_id,per_unit,units) VALUES($1,$2,$3,$4,$5,true,$6)', [a.id, description, value, first, s.id, n]);
    await syncAccount(q, a); return { units: n, value_cents: value, action: 'created' };
  }
  if (sub.value_cents !== value || sub.description !== description) {
    await asaas('PUT', '/subscriptions/' + encodeURIComponent(sub.asaas_subscription_id), { value: reais(value), description, updatePendingPayments: true });
    await q('UPDATE billing_subscriptions SET value_cents=$2,description=$3,units=$4 WHERE id=$1', [sub.id, value, description, n]);
    await syncAccount(q, a); return { units: n, value_cents: value, action: 'updated' };
  }
  return { units: n, value_cents: value };
}

export async function syncAll(q) {
  const skip = new Set(); let error = null;
  if (KEY()) {
    const accounts = (await q("SELECT * FROM billing_accounts WHERE asaas_customer_id IS NOT NULL AND mode <> 'exempt'")).rows;
    for (const a of accounts) {
      if (a.unit_price_cents) { try { await syncPerUnit(q, a); } catch (e) { error = e.message; await q('UPDATE billing_accounts SET last_error=$2 WHERE id=$1', [a.id, String(e.message).slice(0, 300)]); } }
      const r = await syncAccount(q, a); if (!r.ok) { skip.add(a.id); error = r.error; }
    }
  }
  const changes = await enforce(q, { refresh: false, skip });
  await q('UPDATE platform_settings SET billing_last_sync_at=now(),billing_last_sync_error=$1 WHERE id=true', [error ? String(error).slice(0, 300) : null]);
  return { changes, error };
}

// Link para pagar, mostrado a quem está bloqueado (login e painel).
export async function payLinkFor(q, { tenantId = null, networkId = null }) {
  const r = await q(`SELECT c.invoice_url FROM billing_accounts a JOIN billing_charges c ON c.account_id=a.id
    WHERE a.blocked_at IS NOT NULL AND (a.tenant_id=$1 OR a.network_id=$2 OR a.network_id=(SELECT network_id FROM tenants WHERE id=$1))
      AND NOT c.deleted AND c.status = ANY($3) AND c.invoice_url IS NOT NULL ORDER BY c.due_date LIMIT 1`, [tenantId, networkId, OPEN]);
  return r.rows[0]?.invoice_url || null;
}
export const BLOCK_MSG = 'Acesso bloqueado por pagamento em atraso. Pague pelo link para liberar na hora, ou fale com a central.';

// ---- Rotas ----
export function registerBilling(app, { q, auth, roles, route, bad, valid, uuid, audit, rateLimit }) {
  const master = [auth, roles('master')];
  const digits = v => typeof v === 'string' ? v.replace(/\D/g, '') : v;
  const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const fail = (res, e) => bad(res, e.asaas || e.status === 503 ? (e.status === 503 ? 503 : 502) : 500, e.message);

  const accountsList = () => q(`
    WITH targets AS (
      SELECT t.id tenant_id, NULL::uuid network_id, t.name, t.slug, t.status, 1 units FROM tenants t WHERE t.network_id IS NULL AND NOT t.demo_mode
      UNION ALL
      SELECT NULL, n.id, n.name, n.slug, n.status, (SELECT count(*)::int FROM tenants u WHERE u.network_id=n.id) FROM store_networks n)
    SELECT tg.*, a.id account_id, a.mode, a.grace_days, a.auto_block, a.cpf_cnpj, a.asaas_customer_id, a.blocked_at, a.block_override_until, a.last_error, a.last_sync_at,
      (SELECT json_build_object('value_cents',s.value_cents,'description',s.description) FROM billing_subscriptions s WHERE s.account_id=a.id AND s.status='active' ORDER BY s.created_at DESC LIMIT 1) subscription,
      (SELECT json_build_object('due_date',c.due_date,'value_cents',c.value_cents,'description',c.description,'status',c.status) FROM billing_charges c WHERE c.account_id=a.id AND NOT c.deleted AND c.status = ANY($1) ORDER BY c.due_date LIMIT 1) next_open,
      (SELECT count(*)::int FROM billing_charges c WHERE c.account_id=a.id AND NOT c.deleted AND c.status = ANY($1) AND c.due_date < $2::date) overdue_count,
      (SELECT coalesce(sum(c.value_cents),0)::int FROM billing_charges c WHERE c.account_id=a.id AND NOT c.deleted AND c.status = ANY($1) AND c.due_date < $2::date) overdue_cents,
      (SELECT max(c.paid_at) FROM billing_charges c WHERE c.account_id=a.id AND c.status = ANY($3)) last_paid_at
    FROM targets tg LEFT JOIN billing_accounts a ON a.tenant_id=tg.tenant_id OR a.network_id=tg.network_id
    ORDER BY (a.id IS NULL), lower(tg.name)`, [OPEN, todayLocal(), PAID]);

  app.get('/api/master/billing', ...master, route(async (_req, res) => {
    const [rows, s, month] = await Promise.all([accountsList(), q('SELECT billing_last_sync_at,billing_last_sync_error FROM platform_settings WHERE id=true'),
      q(`SELECT coalesce(sum(value_cents) FILTER (WHERE status = ANY($1)),0)::int received_cents, coalesce(sum(value_cents) FILTER (WHERE status = ANY($2)),0)::int open_cents
         FROM billing_charges WHERE NOT deleted AND ((status = ANY($1) AND paid_at >= date_trunc('month',$3::date)) OR (status = ANY($2) AND due_date < (date_trunc('month',$3::date) + interval '1 month')))`, [PAID, OPEN, todayLocal()])]);
    res.json({ configured: !!KEY(), environment: asaasEnv(), webhook_url: BASE() + WEBHOOK_PATH, last_sync_at: s.rows[0]?.billing_last_sync_at, last_sync_error: s.rows[0]?.billing_last_sync_error,
      month: month.rows[0], today: todayLocal(), accounts: rows.rows });
  }));

  // Webhook no Asaas: consulta e cria/atualiza com a URL e o token deste servidor.
  app.get('/api/master/billing/webhook', ...master, route(async (_req, res) => {
    try {
      const url = BASE() + WEBHOOK_PATH, list = await asaas('GET', '/webhooks?limit=100');
      const w = (list.data || []).find(x => x.url === url);
      res.json({ url, exists: !!w, enabled: w?.enabled ?? false, interrupted: w?.interrupted ?? false, events: w?.events || [] });
    } catch (e) { fail(res, e); }
  }));
  app.post('/api/master/billing/webhook', ...master, route(async (req, res) => {
    try {
      const url = BASE() + WEBHOOK_PATH, list = await asaas('GET', '/webhooks?limit=100');
      const w = (list.data || []).find(x => x.url === url);
      const body = { name: 'Ficou Pronto', url, email: process.env.ASAAS_WEBHOOK_EMAIL || process.env.EMAIL_FROM?.replace(/^.*<|>.*$/g, '') || undefined, enabled: true, interrupted: false, apiVersion: 3, authToken: asaasWebhookToken(), sendType: 'SEQUENTIALLY', events: EVENTS };
      if (w) await asaas('PUT', '/webhooks/' + encodeURIComponent(w.id), body); else await asaas('POST', '/webhooks', body);
      await audit(req, w ? 'update' : 'create', 'asaas_webhook', null, null);
      res.json({ ok: true, url });
    } catch (e) { fail(res, e); }
  }));

  app.post('/api/master/billing/sync', ...master, rateLimit({ windowMs: 60000, limit: 6 }), route(async (_req, res) => res.json(await syncAll(q))));

  // Cadastro de quem paga (loja avulsa ou rede). Cria/atualiza o cliente no Asaas quando é "cobrar".
  const accountBody = z.object({
    tenant_id: uuid.optional(), network_id: uuid.optional(),
    name: z.string().trim().min(2).max(120),
    cpf_cnpj: z.preprocess(digits, z.union([z.literal(''), z.string().regex(/^(\d{11}|\d{14})$/, 'CPF ou CNPJ inválido')])).optional(),
    email: z.union([z.literal(''), z.string().trim().email().max(200)]).optional(),
    phone: z.preprocess(digits, z.union([z.literal(''), z.string().regex(/^\d{10,13}$/)])).optional(),
    mode: z.enum(['charge', 'exempt', 'paused']).default('charge'),
    grace_days: z.number().int().min(0).max(60).default(5),
    auto_block: z.boolean().default(true),
    billing_type: z.enum(['UNDEFINED', 'PIX', 'BOLETO']).default('UNDEFINED'),
    block_override_until: z.union([z.literal(''), dateField]).nullable().optional(),
    notes: z.string().max(2000).default(''),
    unit_price_cents: z.number().int().min(500).max(100000000).nullable().optional(),
    due_day: z.number().int().min(1).max(28).optional(),
  }).strict().refine(v => !!v.tenant_id !== !!v.network_id);
  app.put('/api/master/billing/accounts', ...master, route(async (req, res) => {
    const v = valid(accountBody, req, res); if (!v) return;
    const exists = v.tenant_id ? await q('SELECT network_id FROM tenants WHERE id=$1', [v.tenant_id]) : await q('SELECT id FROM store_networks WHERE id=$1', [v.network_id]);
    if (!exists.rowCount) return bad(res, 404, v.tenant_id ? 'Loja não encontrada' : 'Rede não encontrada');
    if (v.tenant_id && exists.rows[0].network_id) return bad(res, 400, 'Esta loja é unidade de uma rede: a cobrança é feita na rede');
    if (v.mode === 'charge' && !v.cpf_cnpj) return bad(res, 400, 'Informe o CPF ou CNPJ de quem paga');
    if (v.tenant_id && v.unit_price_cents) return bad(res, 400, 'Valor por unidade só vale para rede');
    const r = await q(`INSERT INTO billing_accounts(tenant_id,network_id,name,cpf_cnpj,email,phone,mode,grace_days,auto_block,billing_type,block_override_until,notes,unit_price_cents,due_day)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,coalesce($14,20))
      ON CONFLICT (${v.tenant_id ? 'tenant_id' : 'network_id'}) DO UPDATE SET name=EXCLUDED.name,cpf_cnpj=EXCLUDED.cpf_cnpj,email=EXCLUDED.email,phone=EXCLUDED.phone,mode=EXCLUDED.mode,
        grace_days=EXCLUDED.grace_days,auto_block=EXCLUDED.auto_block,billing_type=EXCLUDED.billing_type,block_override_until=EXCLUDED.block_override_until,notes=EXCLUDED.notes,
        unit_price_cents=CASE WHEN $15 THEN EXCLUDED.unit_price_cents ELSE billing_accounts.unit_price_cents END,
        due_day=CASE WHEN $14::int IS NULL THEN billing_accounts.due_day ELSE EXCLUDED.due_day END,updated_at=now()
      RETURNING *`, [v.tenant_id || null, v.network_id || null, v.name, v.cpf_cnpj || null, v.email || null, v.phone || null, v.mode, v.grace_days, v.auto_block, v.billing_type, v.block_override_until || null, v.notes,
        v.unit_price_cents ?? null, v.due_day ?? null, v.unit_price_cents !== undefined]);
    let a = r.rows[0], warning = null;
    await audit(req, 'upsert', 'billing_account', a.id, a.tenant_id || null);
    if (a.mode === 'charge' && KEY()) {
      const customer = { name: a.name, cpfCnpj: a.cpf_cnpj, email: a.email || undefined, mobilePhone: a.phone || undefined, externalReference: 'fp-account:' + a.id };
      try {
        if (a.asaas_customer_id) await asaas('PUT', '/customers/' + encodeURIComponent(a.asaas_customer_id), customer);
        else { const c = await asaas('POST', '/customers', customer); a = (await q('UPDATE billing_accounts SET asaas_customer_id=$2 WHERE id=$1 RETURNING *', [a.id, c.id])).rows[0]; }
      } catch (e) { warning = 'Salvo aqui, mas o Asaas recusou: ' + e.message; }
    } else if (a.mode === 'charge') warning = 'Salvo aqui. O cliente será criado no Asaas quando a chave (ASAAS_API_KEY) estiver no servidor.';
    if (!warning && a.unit_price_cents) { try { await syncPerUnit(q, a); } catch (e) { warning = 'Salvo aqui, mas a mensalidade por unidade não foi ajustada no Asaas: ' + e.message; } }
    await enforce(q, { accountId: a.id });
    res.json({ account: (await q('SELECT * FROM billing_accounts WHERE id=$1', [a.id])).rows[0], warning });
  }));

  const loadAccount = async id => (await q('SELECT * FROM billing_accounts WHERE id=$1', [id])).rows[0];
  app.get('/api/master/billing/accounts/:id', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const a = await loadAccount(req.params.id); if (!a) return bad(res, 404, 'Cadastro não encontrado');
    const [subs, charges, units] = await Promise.all([
      q('SELECT * FROM billing_subscriptions WHERE account_id=$1 ORDER BY status, created_at DESC', [a.id]),
      q('SELECT * FROM billing_charges WHERE account_id=$1 ORDER BY deleted, due_date DESC LIMIT 200', [a.id]),
      a.network_id ? q('SELECT id,name,unit_label,status,billing_since FROM tenants WHERE network_id=$1 ORDER BY lower(coalesce(unit_label,name))', [a.network_id]) : q('SELECT id,name,status FROM tenants WHERE id=$1', [a.tenant_id])]);
    res.json({ account: a, subscriptions: subs.rows, charges: charges.rows, units: units.rows, today: todayLocal() });
  }));

  // Liberar (ou parar) a cobrança de uma unidade da rede. Mês cheio: entra inteira na próxima cobrança em aberto.
  app.post('/api/master/billing/accounts/:id/units/:tenantId', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success || !uuid.safeParse(req.params.tenantId).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ active: z.boolean(), since: dateField.optional() }).strict(), req, res); if (!v) return;
    const a = await loadAccount(req.params.id); if (!a) return bad(res, 404, 'Cadastro não encontrado');
    if (!a.network_id) return bad(res, 400, 'Só para rede');
    if (!a.unit_price_cents) return bad(res, 409, 'Informe o valor por unidade no cadastro antes de liberar unidades');
    const u = (await q('SELECT id,billing_since FROM tenants WHERE id=$1 AND network_id=$2', [req.params.tenantId, a.network_id])).rows[0];
    if (!u) return bad(res, 404, 'Unidade não é desta rede');
    if (v.active && v.since && v.since > todayLocal()) return bad(res, 400, 'Data no futuro');
    const before = u.billing_since;
    await q('UPDATE tenants SET billing_since=$2 WHERE id=$1', [u.id, v.active ? (v.since || todayLocal()) : null]);
    await audit(req, v.active ? 'billing_unit_on' : 'billing_unit_off', 'tenant', u.id, u.id);
    if (a.mode !== 'charge') return res.json({ ok: true, warning: 'Guardado. O cadastro não está em “Cobrar”, então nada foi gerado no Asaas.' });
    try { res.json({ ok: true, ...(await syncPerUnit(q, a)) }); }
    catch (e) {
      if (e.status === 409) { await q('UPDATE tenants SET billing_since=$2 WHERE id=$1', [u.id, before]); return bad(res, 409, e.message); }
      bad(res, 502, 'Guardado aqui, mas o Asaas não foi ajustado agora (' + e.message + '). O sistema tenta de novo na conferência de 30 min.');
    }
  }));

  const needAsaas = (a, res) => {
    if (a.mode !== 'charge') { bad(res, 409, a.mode === 'exempt' ? 'Cadastro isento: não gera cobrança' : 'Cobrança pausada neste cadastro'); return false; }
    if (!KEY()) { bad(res, 503, 'Asaas não configurado: falta ASAAS_API_KEY no servidor'); return false; }
    if (!a.asaas_customer_id) { bad(res, 409, 'Salve o cadastro de novo para criar o cliente no Asaas'); return false; }
    return true;
  };

  // Cobrança avulsa ou parcelada: cada parcela com valor e vencimento próprios.
  app.post('/api/master/billing/accounts/:id/charges', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ kind: z.enum(['setup', 'monthly', 'other']).default('other'), description: z.string().trim().min(2).max(160),
      installments: z.array(z.object({ value_cents: z.number().int().min(500).max(100000000), due_date: dateField })).min(1).max(24) }).strict(), req, res); if (!v) return;
    const a = await loadAccount(req.params.id); if (!a) return bad(res, 404, 'Cadastro não encontrado'); if (!needAsaas(a, res)) return;
    if (v.installments.some(i => i.due_date < todayLocal())) return bad(res, 400, 'Vencimento no passado');
    const n = v.installments.length, created = [];
    try {
      for (const [i, inst] of v.installments.entries()) {
        const description = n > 1 ? `${v.description} — parcela ${i + 1}/${n}` : v.description;
        const p = await asaas('POST', '/payments', { customer: a.asaas_customer_id, billingType: a.billing_type, value: reais(inst.value_cents), dueDate: inst.due_date, description, externalReference: 'fp-account:' + a.id });
        created.push(await upsertPayment(q, p, { kind: v.kind, description, created_by: req.user.id }));
      }
    } catch (e) {
      await audit(req, 'create', 'billing_charge', a.id, a.tenant_id || null);
      return bad(res, e.status === 503 ? 503 : 502, e.message + (created.length ? ` (${created.length} de ${n} parcela(s) já criada(s); confira antes de repetir)` : ''));
    }
    await audit(req, 'create', 'billing_charge', a.id, a.tenant_id || null);
    res.status(201).json(created);
  }));

  // Mensalidade: assinatura mensal no Asaas (ela gera as cobranças de cada mês).
  app.post('/api/master/billing/accounts/:id/subscriptions', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ description: z.string().trim().min(2).max(160), value_cents: z.number().int().min(500).max(100000000), first_due_date: dateField, end_date: z.union([z.literal(''), dateField]).optional() }).strict(), req, res); if (!v) return;
    const a = await loadAccount(req.params.id); if (!a) return bad(res, 404, 'Cadastro não encontrado'); if (!needAsaas(a, res)) return;
    if (v.first_due_date < todayLocal()) return bad(res, 400, 'Primeiro vencimento no passado');
    if (a.unit_price_cents) return bad(res, 409, 'Esta rede é cobrada por unidade: libere as unidades em vez de criar mensalidade fixa');
    if ((await q("SELECT 1 FROM billing_subscriptions WHERE account_id=$1 AND status='active'", [a.id])).rowCount) return bad(res, 409, 'Já existe uma mensalidade ativa: cancele antes de criar outra');
    let s;
    try { s = await asaas('POST', '/subscriptions', { customer: a.asaas_customer_id, billingType: a.billing_type, value: reais(v.value_cents), nextDueDate: v.first_due_date, cycle: 'MONTHLY', description: v.description, endDate: v.end_date || undefined, externalReference: 'fp-account:' + a.id }); }
    catch (e) { return fail(res, e); }
    const row = (await q('INSERT INTO billing_subscriptions(account_id,description,value_cents,first_due_date,end_date,asaas_subscription_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [a.id, v.description, v.value_cents, v.first_due_date, v.end_date || null, s.id, req.user.id])).rows[0];
    await audit(req, 'create', 'billing_subscription', row.id, a.tenant_id || null);
    await syncAccount(q, a).catch(() => {});
    res.status(201).json(row);
  }));

  app.delete('/api/master/billing/subscriptions/:id', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const s = (await q("SELECT s.*,a.tenant_id FROM billing_subscriptions s JOIN billing_accounts a ON a.id=s.account_id WHERE s.id=$1 AND s.status='active'", [req.params.id])).rows[0];
    if (!s) return bad(res, 404, 'Mensalidade não encontrada');
    try { if (s.asaas_subscription_id) await asaas('DELETE', '/subscriptions/' + encodeURIComponent(s.asaas_subscription_id)); }
    catch (e) { if (e.status !== 404) return fail(res, e); }
    await q("UPDATE billing_subscriptions SET status='canceled',canceled_at=now() WHERE id=$1", [s.id]);
    await audit(req, 'cancel', 'billing_subscription', s.id, s.tenant_id || null);
    const a = await loadAccount(s.account_id); await syncAccount(q, a).catch(() => {}); await enforce(q, { accountId: a.id, refresh: false });
    res.json({ ok: true });
  }));

  const chargeOf = async id => (await q('SELECT c.*,a.tenant_id FROM billing_charges c JOIN billing_accounts a ON a.id=c.account_id WHERE c.id=$1', [id])).rows[0];
  app.delete('/api/master/billing/charges/:id', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const c = await chargeOf(req.params.id); if (!c || c.deleted) return bad(res, 404, 'Cobrança não encontrada');
    if (!OPEN.includes(c.status)) return bad(res, 409, 'Só dá para cancelar cobrança em aberto');
    try { await asaas('DELETE', '/payments/' + encodeURIComponent(c.asaas_payment_id)); } catch (e) { if (e.status !== 404) return fail(res, e); }
    await q('UPDATE billing_charges SET deleted=true,updated_at=now() WHERE id=$1', [c.id]);
    await audit(req, 'delete', 'billing_charge', c.id, c.tenant_id || null);
    await enforce(q, { accountId: c.account_id, refresh: false });
    res.json({ ok: true });
  }));

  // Recebido fora do Asaas (dinheiro, Pix direto): baixa no Asaas e libera.
  app.post('/api/master/billing/charges/:id/receive', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ paid_at: dateField, value_cents: z.number().int().min(1) }).strict(), req, res); if (!v) return;
    const c = await chargeOf(req.params.id); if (!c || c.deleted) return bad(res, 404, 'Cobrança não encontrada');
    if (!OPEN.includes(c.status)) return bad(res, 409, 'Cobrança já está paga ou encerrada');
    try { await upsertPayment(q, await asaas('POST', '/payments/' + encodeURIComponent(c.asaas_payment_id) + '/receiveInCash', { paymentDate: v.paid_at, value: reais(v.value_cents), notifyCustomer: false })); }
    catch (e) { return fail(res, e); }
    await audit(req, 'receive_cash', 'billing_charge', c.id, c.tenant_id || null);
    await enforce(q, { accountId: c.account_id, refresh: false });
    res.json(await chargeOf(c.id));
  }));

  // ---- Webhook do Asaas ----
  app.post(WEBHOOK_PATH, rateLimit({ windowMs: 60000, limit: 600 }), route(async (req, res) => {
    if (!sameToken(req.get('asaas-access-token'), asaasWebhookToken())) return bad(res, 401, 'Token inválido');
    const ev = req.body || {};
    if (typeof ev.id !== 'string' || typeof ev.event !== 'string') return bad(res, 400, 'Aviso inválido');
    const fresh = await q('INSERT INTO billing_events(id,event,payment_id) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING RETURNING id', [ev.id.slice(0, 120), ev.event.slice(0, 80), ev.payment?.id || null]);
    res.json({ ok: true });
    if (!fresh.rowCount || !ev.payment?.id) return;
    // Processa depois de responder (o Asaas espera 200 rápido). A situação vem da API, não do aviso.
    try {
      let p = ev.payment;
      try { p = await asaas('GET', '/payments/' + encodeURIComponent(ev.payment.id)); } catch (e) { if (e.status === 404) p = { ...ev.payment, deleted: true }; }
      if (ev.event === 'PAYMENT_DELETED') p = { ...p, deleted: true };
      const row = await upsertPayment(q, p);
      if (row) await enforce(q, { accountId: row.account_id, refresh: false });
      await q('UPDATE billing_events SET processed_at=now() WHERE id=$1', [ev.id.slice(0, 120)]);
    } catch (e) {
      await q('UPDATE billing_events SET error=$2 WHERE id=$1', [ev.id.slice(0, 120), String(e.message).slice(0, 300)]).catch(() => {});
    }
  }));

  // ---- Loja e rede: cobranças em aberto (só o dono) ----
  const openFor = async where => {
    const a = (await q('SELECT * FROM billing_accounts WHERE ' + where.sql, where.args)).rows[0];
    if (!a || a.mode !== 'charge') return { charges: [] };
    const rows = (await q("SELECT description,value_cents,due_date,status,invoice_url FROM billing_charges WHERE account_id=$1 AND NOT deleted AND status = ANY($2) ORDER BY due_date LIMIT 12", [a.id, OPEN])).rows;
    const today = todayLocal();
    return { blocked: !!a.blocked_at, grace_days: a.grace_days, today,
      charges: rows.map(c => ({ ...c, due_date: isoDate(c.due_date), overdue: isoDate(c.due_date) < today, pay_until: a.auto_block ? addDays(isoDate(c.due_date), a.grace_days) : null })) };
  };
  app.get('/api/store/billing', auth, roles('owner'), route(async (req, res) => res.json(await openFor({ sql: 'tenant_id=$1', args: [req.user.tenant_id] }))));
  app.get('/api/network/billing', auth, roles('network'), route(async (req, res) => {
    if (req.user.network_access && req.user.network_access !== 'owner') return res.json({ charges: [] });
    res.json(await openFor({ sql: 'network_id=$1', args: [req.user.network_id] }));
  }));
}

export function startBillingLoop(q) {
  if (process.env.BILLING_SYNC === 'off') return;
  let running = false;
  const tick = async () => {
    if (running || !backgroundAllowed()) return; running = true;
    try { const r = await syncAll(q); if (r.changes.length) console.log('Cobrança: ' + r.changes.map(c => c.action).join(', ')); }
    catch (e) { console.error('Cobrança (Asaas)', e.code || e.message); }
    finally { running = false; }
  };
  setTimeout(tick, 120000).unref(); setInterval(tick, 30 * 60000).unref();
}
