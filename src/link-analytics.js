// Medição do acompanhamento + relatório de resultados para os lojistas.
//
// Coleta (anônima): a página do cliente envia /visit a cada ~30 s com tempos acumulados; a loja
// registra quando envia/copia o link; o servidor registra downloads e recompensas.
// Central: números por período, por loja e por dia, CSV, número público (desligado por padrão) e a
// fila diária/semanal de mensagens de resultados para enviar a cada lojista pelo WhatsApp.
import { z } from 'zod';
import { localNow } from './reports.js';

const TZ = process.env.STORE_TIMEZONE || 'America/Fortaleza';
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dayRe = /^\d{4}-\d{2}-\d{2}$/;
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (day, n) => ymd(new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000));
const dmy = s => s.split('-').reverse().join('/');
export const todayLocal = (now = new Date()) => ymd(localNow(now));

export const DEFAULT_TEMPLATE = 'Olá, {loja}! 📊 Seus resultados no Ficou Pronto ({periodo}):\n'
  + '• {links} pedidos com link de acompanhamento\n'
  + '• {aberturas} aberturas por {pessoas} pessoas\n'
  + '• {taxa} dos links foram abertos pelos clientes\n'
  + '• {retornos} clientes voltaram para acompanhar de novo\n'
  + '• {horas_video} de vídeo ao vivo assistido\n'
  + '• Tempo médio na página: {tempo_medio}\n'
  + 'Seus clientes estão acompanhando. Qualquer dúvida, é só chamar!';
export const PLACEHOLDERS = ['loja', 'periodo', 'links', 'enviados', 'aberturas', 'pessoas', 'taxa', 'retornos', 'tempo_medio', 'horas_video', 'downloads', 'conversas', 'concluidos'];

export function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  if (h) return h + ' h' + (m ? ' ' + m + ' min' : '');
  if (m) return m + ' min' + (s % 60 && m < 10 ? ' ' + (s % 60) + ' s' : '');
  return s + ' s';
}
const pct = (a, b) => b ? Math.round(a * 100 / b) + '%' : '—';

// Números de um período [from, to) em datas locais, por loja (tenant opcional) e por dia.
export async function linkStats(q, { from, to, tenantId = null }) {
  const p = [from, to, TZ, tenantId];
  const inRange = col => `${col} >= ($1::date::timestamp AT TIME ZONE $3) AND ${col} < ($2::date::timestamp AT TIME ZONE $3)`;
  const tf = col => `($4::uuid IS NULL OR ${col} = $4::uuid)`;
  const [stores, days] = await Promise.all([
    q(`WITH o AS (SELECT tenant_id, count(*)::int created,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM link_visits v WHERE v.order_id = orders.id))::int created_opened
        FROM orders WHERE deleted_at IS NULL AND ${inRange('created_at')} AND ${tf('tenant_id')} GROUP BY tenant_id),
      c AS (SELECT tenant_id, count(*)::int completed FROM orders WHERE deleted_at IS NULL AND ${inRange('completed_at')} AND ${tf('tenant_id')} GROUP BY tenant_id),
      v AS (SELECT tenant_id, count(*)::int opens, count(DISTINCT visitor_id)::int people, count(DISTINCT order_id)::int orders_opened,
          COALESCE(sum(visible_seconds), 0)::bigint visible, COALESCE(sum(live_seconds), 0)::bigint live,
          count(*) FILTER (WHERE device = 'mobile')::int mobile
        FROM link_visits WHERE ${inRange('started_at')} AND ${tf('tenant_id')} GROUP BY tenant_id),
      r AS (SELECT tenant_id, count(*)::int returns FROM (SELECT tenant_id, order_id, visitor_id FROM link_visits
          WHERE ${inRange('started_at')} AND ${tf('tenant_id')} GROUP BY 1, 2, 3 HAVING count(*) > 1) x GROUP BY tenant_id),
      e AS (SELECT tenant_id,
          count(DISTINCT order_id) FILTER (WHERE kind = 'link_sent')::int sent,
          count(*) FILTER (WHERE kind = 'link_copied')::int copied,
          count(*) FILTER (WHERE kind = 'video_download')::int downloads,
          count(*) FILTER (WHERE kind = 'talk_store')::int talks,
          count(*) FILTER (WHERE kind = 'loyalty_claim')::int claims
        FROM link_events WHERE ${inRange('created_at')} AND ${tf('tenant_id')} GROUP BY tenant_id)
      SELECT t.id tenant_id, t.name, t.slug, t.whatsapp, t.status, t.results_report, t.results_report_weekday,
        COALESCE(o.created, 0) links, COALESCE(o.created_opened, 0) links_opened, COALESCE(c.completed, 0) completed,
        COALESCE(v.opens, 0) opens, COALESCE(v.people, 0) people, COALESCE(v.orders_opened, 0) orders_opened,
        COALESCE(v.visible, 0)::int visible_seconds, COALESCE(v.live, 0)::int live_seconds, COALESCE(v.mobile, 0) mobile,
        COALESCE(r.returns, 0) returns, COALESCE(e.sent, 0) sent, COALESCE(e.copied, 0) copied,
        COALESCE(e.downloads, 0) downloads, COALESCE(e.talks, 0) talks, COALESCE(e.claims, 0) claims
      FROM tenants t LEFT JOIN o ON o.tenant_id = t.id LEFT JOIN c ON c.tenant_id = t.id LEFT JOIN v ON v.tenant_id = t.id
      LEFT JOIN r ON r.tenant_id = t.id LEFT JOIN e ON e.tenant_id = t.id
      WHERE ${tf('t.id')} ORDER BY COALESCE(v.opens, 0) DESC, t.name`, p),
    q(`WITH d AS (SELECT generate_series($1::date, $2::date - 1, interval '1 day')::date d)
      SELECT to_char(d.d, 'YYYY-MM-DD') AS day,
        (SELECT count(*) FROM orders o WHERE o.deleted_at IS NULL AND ${tf('o.tenant_id')}
          AND o.created_at >= (d.d::timestamp AT TIME ZONE $3) AND o.created_at < ((d.d + 1)::timestamp AT TIME ZONE $3))::int links,
        (SELECT count(*) FROM link_visits v WHERE ${tf('v.tenant_id')}
          AND v.started_at >= (d.d::timestamp AT TIME ZONE $3) AND v.started_at < ((d.d + 1)::timestamp AT TIME ZONE $3))::int opens,
        (SELECT COALESCE(sum(v.live_seconds), 0) FROM link_visits v WHERE ${tf('v.tenant_id')}
          AND v.started_at >= (d.d::timestamp AT TIME ZONE $3) AND v.started_at < ((d.d + 1)::timestamp AT TIME ZONE $3))::int live_seconds
      FROM d ORDER BY d.d`, p)
  ]);
  const sum = k => stores.rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  const keys = ['links', 'links_opened', 'completed', 'opens', 'people', 'orders_opened', 'visible_seconds', 'live_seconds', 'mobile', 'returns', 'sent', 'copied', 'downloads', 'talks', 'claims'];
  const totals = Object.fromEntries(keys.map(k => [k, sum(k)]));
  return { from, to, totals: withDerived(totals), stores: stores.rows.map(withDerived), days: days.rows };
}
function withDerived(r) {
  return { ...r, open_rate: r.links ? Math.round(r.links_opened * 100 / r.links) : null, avg_visible_seconds: r.opens ? Math.round(r.visible_seconds / r.opens) : 0 };
}

// Período do relatório de resultados que vence em `day` (data local): diário = ontem; semanal = 7 dias até ontem.
export function resultsPeriod(kind, day) {
  const to = day, from = kind === 'daily' ? addDays(day, -1) : addDays(day, -7);
  const last = addDays(to, -1);
  return { from, to, key: kind + ':' + day, title: kind === 'daily' ? dmy(last) : `${dmy(from)} a ${dmy(last)}` };
}
const dueOn = (t, day) => t.results_report === 'daily' || (t.results_report === 'weekly' && new Date(day + 'T12:00:00Z').getUTCDay() === Number(t.results_report_weekday));

export function fillTemplate(template, store, period) {
  // Valor null = sem dado no período (ex.: taxa sem pedidos novos): a linha inteira sai da mensagem.
  const v = {
    loja: store.name || '', periodo: period.title, links: store.links, enviados: store.sent, aberturas: store.opens, pessoas: store.people,
    taxa: store.links ? pct(store.links_opened, store.links) : null, retornos: store.returns, tempo_medio: duration(store.avg_visible_seconds),
    horas_video: duration(store.live_seconds), downloads: store.downloads, conversas: store.talks, concluidos: store.completed
  };
  return String(template || DEFAULT_TEMPLATE).split('\n')
    .filter(line => ![...line.matchAll(/\{([a-z_]+)\}/g)].some(m => Object.hasOwn(v, m[1]) && v[m[1]] === null))
    .join('\n').replace(/\{([a-z_]+)\}/g, (m, k) => Object.hasOwn(v, k) ? String(v[k]) : m);
}

const csvCell = v => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = rows => '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');

function parseRange(query, fallbackDays = 30) {
  const today = todayLocal();
  const to = dayRe.test(query.to || '') ? addDays(query.to, 1) : addDays(today, 1);
  const from = dayRe.test(query.from || '') ? query.from : addDays(to, -fallbackDays);
  if (from >= to || (Date.parse(to) - Date.parse(from)) / 86400000 > 400) return null;
  return { from, to };
}

export function registerLinkAnalytics(app, { q, auth, roles, route, bad, valid, audit, rateLimit, digestToken, tid }) {
  const byToken = `(o.public_token_hash = $1 OR o.share_code = $2) AND o.deleted_at IS NULL`;

  // ---------- Coleta na página do cliente ----------
  const visitSchema = z.object({
    visit: z.string().regex(uuidRe), visitor: z.string().regex(uuidRe),
    visible: z.number().int().min(0).max(86400), live: z.number().int().min(0).max(86400),
    device: z.enum(['mobile', 'tablet', 'desktop', 'other']).default('other'),
    source: z.enum(['whatsapp', 'qrcode', 'direct', 'other']).default('direct')
  });
  const visitLimit = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
  app.post('/api/public/orders/:token/visit', visitLimit, route(async (req, res) => {
    const token = req.params.token;
    if (!/^[\w-]{16,100}$/.test(token)) return bad(res, 404, 'Não encontrado');
    const v = valid(visitSchema, req, res); if (!v) return;
    // Tempos acumulados: só aumentam e nunca passam do tempo real desde a abertura (+1 min de folga).
    await q(`INSERT INTO link_visits(id, tenant_id, order_id, visitor_id, visible_seconds, live_seconds, device, source)
      SELECT $3, o.tenant_id, o.id, $4, LEAST($5, 60), LEAST($6, 60), $7, $8 FROM orders o WHERE ${byToken}
      ON CONFLICT (id) DO UPDATE SET last_seen_at = now(),
        visible_seconds = GREATEST(link_visits.visible_seconds, LEAST($5, extract(epoch FROM now() - link_visits.started_at)::int + 60)),
        live_seconds = GREATEST(link_visits.live_seconds, LEAST($6, extract(epoch FROM now() - link_visits.started_at)::int + 60))
      WHERE link_visits.order_id = EXCLUDED.order_id AND link_visits.visitor_id = EXCLUDED.visitor_id
        AND link_visits.last_seen_at > now() - interval '12 hours'`,
      [digestToken(token), token, v.visit, v.visitor, v.visible, v.live, v.device, v.source]);
    res.status(204).end();
  }));

  const eventLimit = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
  app.post('/api/public/orders/:token/event', eventLimit, route(async (req, res) => {
    const token = req.params.token;
    if (!/^[\w-]{16,100}$/.test(token)) return bad(res, 404, 'Não encontrado');
    const v = valid(z.object({ kind: z.enum(['talk_store']), visitor: z.string().regex(uuidRe).optional() }), req, res); if (!v) return;
    await q(`INSERT INTO link_events(tenant_id, order_id, kind, visitor_id) SELECT o.tenant_id, o.id, $3, $4 FROM orders o WHERE ${byToken}`,
      [digestToken(token), token, v.kind, v.visitor || null]);
    res.status(204).end();
  }));

  // ---------- Loja: link enviado ou copiado ----------
  // Recebe o link (como aparece na mensagem) e acha o pedido da própria loja: /p/<código> ou /<loja>/<número>.
  app.post('/api/store/link-shares', auth, roles('owner', 'operator'), rateLimit({ windowMs: 60000, limit: 60 }), route(async (req, res) => {
    const v = valid(z.object({ link: z.string().max(400), channel: z.enum(['whatsapp', 'copy']) }), req, res); if (!v) return;
    let path; try { path = new URL(v.link).pathname; } catch { return bad(res, 400, 'Link inválido'); }
    let order;
    const p = /^\/p\/([\w-]{16,100})\/?$/.exec(path), s = /^\/([a-z0-9-]{3,60})\/(\d{4,5})\/?$/.exec(path);
    if (p) order = await q(`SELECT o.id FROM orders o WHERE ${byToken} AND o.tenant_id = $3`, [digestToken(p[1]), p[1], tid(req)]);
    else if (s) order = await q(`SELECT o.id FROM tenant_slugs ts JOIN orders o ON o.tenant_id = ts.tenant_id
      WHERE ts.slug = $1 AND o.order_number = $2 AND o.tenant_id = $3 AND o.deleted_at IS NULL ORDER BY o.created_at DESC LIMIT 1`, [s[1], Number(s[2]), tid(req)]);
    if (!order?.rowCount) return bad(res, 404, 'Pedido não encontrado');
    await q('INSERT INTO link_events(tenant_id, order_id, kind, created_by) VALUES($1, $2, $3, $4)', [tid(req), order.rows[0].id, v.channel === 'copy' ? 'link_copied' : 'link_sent', req.user.id]);
    res.status(204).end();
  }));

  // ---------- Central: números ----------
  app.get('/api/master/analytics', auth, roles('master'), route(async (req, res) => {
    const range = parseRange(req.query); if (!range) return bad(res, 400, 'Período inválido (até 400 dias)');
    const tenantId = uuidRe.test(req.query.tenant || '') ? req.query.tenant : null;
    const settings = await q('SELECT public_stats_enabled FROM platform_settings WHERE id = true');
    res.set('Cache-Control', 'no-store').json({ ...(await linkStats(q, { ...range, tenantId })), public_stats_enabled: !!settings.rows[0]?.public_stats_enabled });
  }));

  app.get('/api/master/analytics.csv', auth, roles('master'), route(async (req, res) => {
    const range = parseRange(req.query); if (!range) return bad(res, 400, 'Período inválido (até 400 dias)');
    const group = ['store', 'day', 'order'].includes(req.query.group) ? req.query.group : 'store';
    let rows;
    if (group === 'store') {
      const s = await linkStats(q, range);
      rows = [['Loja', 'Pedidos com link', 'Links enviados (WhatsApp)', 'Links copiados', 'Pedidos com link aberto', 'Taxa de abertura (%)', 'Aberturas', 'Pessoas (aparelhos)', 'Retornos', 'Tempo na página (s)', 'Tempo médio por abertura (s)', 'Vídeo ao vivo assistido (s)', 'Downloads de vídeo', 'Conversas com a loja', 'Recompensas pedidas', 'Pedidos concluídos']]
        .concat(s.stores.map(r => [r.name, r.links, r.sent, r.copied, r.links_opened, r.open_rate ?? '', r.opens, r.people, r.returns, r.visible_seconds, r.avg_visible_seconds, r.live_seconds, r.downloads, r.talks, r.claims, r.completed]));
    } else if (group === 'day') {
      const s = await linkStats(q, range);
      rows = [['Dia', 'Pedidos com link', 'Aberturas', 'Vídeo ao vivo assistido (s)']].concat(s.days.map(d => [d.day, d.links, d.opens, d.live_seconds]));
    } else {
      const r = await q(`SELECT t.name store, o.order_number, o.external_reference, to_char(o.created_at AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') created, o.status,
          (SELECT count(*) FROM link_visits v WHERE v.order_id = o.id)::int opens,
          (SELECT count(DISTINCT visitor_id) FROM link_visits v WHERE v.order_id = o.id)::int people,
          (SELECT COALESCE(sum(visible_seconds), 0) FROM link_visits v WHERE v.order_id = o.id)::int visible,
          (SELECT COALESCE(sum(live_seconds), 0) FROM link_visits v WHERE v.order_id = o.id)::int live,
          (SELECT count(*) FROM link_events e WHERE e.order_id = o.id AND e.kind = 'link_sent')::int sent,
          (SELECT count(*) FROM link_events e WHERE e.order_id = o.id AND e.kind = 'video_download')::int downloads
        FROM orders o JOIN tenants t ON t.id = o.tenant_id
        WHERE o.deleted_at IS NULL AND o.created_at >= ($1::date::timestamp AT TIME ZONE $3) AND o.created_at < ($2::date::timestamp AT TIME ZONE $3)
        ORDER BY o.created_at`, [range.from, range.to, TZ]);
      rows = [['Loja', 'Pedido nº', 'Referência', 'Criado em', 'Situação', 'Aberturas', 'Pessoas', 'Tempo na página (s)', 'Vídeo ao vivo (s)', 'Envios pelo WhatsApp', 'Downloads']]
        .concat(r.rows.map(x => [x.store, x.order_number, x.external_reference, x.created, x.status, x.opens, x.people, x.visible, x.live, x.sent, x.downloads]));
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ficoupronto-${group}-${range.from}-a-${addDays(range.to, -1)}.csv"`, 'Cache-Control': 'no-store' });
    res.send(csv(rows));
  }));

  app.patch('/api/master/analytics/settings', auth, roles('master'), route(async (req, res) => {
    const v = valid(z.object({ public_stats_enabled: z.boolean().optional(), store_report_template: z.string().trim().max(2000).nullable().optional() }), req, res); if (!v) return;
    const r = await q(`UPDATE platform_settings SET public_stats_enabled = COALESCE($1, public_stats_enabled),
      store_report_template = CASE WHEN $2::boolean THEN NULLIF($3, '') ELSE store_report_template END WHERE id = true
      RETURNING public_stats_enabled, store_report_template`, [v.public_stats_enabled ?? null, v.store_report_template !== undefined, v.store_report_template ?? '']);
    await audit(req, 'update_analytics_settings', 'platform_settings', null);
    res.json({ ...r.rows[0], store_report_template: r.rows[0].store_report_template || DEFAULT_TEMPLATE });
  }));

  // Número público (somado, sem dados de cliente). Desligado até a central ligar.
  let publicCache = { at: 0, data: null };
  app.get('/api/public/stats', rateLimit({ windowMs: 60000, limit: 60 }), route(async (_req, res) => {
    const enabled = (await q('SELECT public_stats_enabled FROM platform_settings WHERE id = true')).rows[0]?.public_stats_enabled;
    if (!enabled) return bad(res, 404, 'Não disponível');
    if (Date.now() - publicCache.at > 10 * 60000) {
      const r = await q(`SELECT (SELECT count(*) FROM orders WHERE deleted_at IS NULL)::int links,
        (SELECT count(*) FROM link_visits)::int opens, (SELECT count(DISTINCT visitor_id) FROM link_visits)::int people,
        (SELECT COALESCE(sum(live_seconds), 0) FROM link_visits)::bigint live_seconds,
        (SELECT count(*) FROM tenants WHERE status IN ('trial', 'active'))::int stores`);
      const x = r.rows[0];
      publicCache = { at: Date.now(), data: { links: x.links, opens: x.opens, people: x.people, live_hours: Math.round(Number(x.live_seconds) / 360) / 10, stores: x.stores, updated_at: new Date().toISOString() } };
    }
    res.set('Cache-Control', 'public, max-age=600').json(publicCache.data);
  }));

  // ---------- Central: relatório de resultados para os lojistas ----------
  const template = async () => (await q('SELECT store_report_template FROM platform_settings WHERE id = true')).rows[0]?.store_report_template || DEFAULT_TEMPLATE;

  app.get('/api/master/results-reports', auth, roles('master'), route(async (req, res) => {
    const day = dayRe.test(req.query.date || '') ? req.query.date : todayLocal();
    const tpl = await template();
    const tenants = await q("SELECT id, name, results_report, results_report_weekday FROM tenants WHERE status IN ('trial', 'active') ORDER BY name");
    const due = tenants.rows.filter(t => dueOn(t, day));
    const out = [];
    for (const t of due) {
      const period = resultsPeriod(t.results_report, day);
      const stats = await linkStats(q, { from: period.from, to: period.to, tenantId: t.id });
      const s = stats.stores[0];
      const sent = await q('SELECT sent_at, u.name sent_by FROM results_report_sends r LEFT JOIN users u ON u.id = r.sent_by WHERE r.tenant_id = $1 AND r.period_key = $2', [t.id, period.key]);
      out.push({ tenant_id: t.id, name: t.name, whatsapp: s.whatsapp, schedule: t.results_report, period, stats: s, message: fillTemplate(tpl, s, period), sent: sent.rows[0] || null });
    }
    const schedules = tenants.rows.map(t => ({ tenant_id: t.id, name: t.name, results_report: t.results_report, results_report_weekday: t.results_report_weekday }));
    res.set('Cache-Control', 'no-store').json({ date: day, template: tpl, default_template: DEFAULT_TEMPLATE, placeholders: PLACEHOLDERS, due: out, schedules });
  }));

  // Prévia para qualquer loja e período (botão "Gerar agora").
  app.get('/api/master/results-reports/preview', auth, roles('master'), route(async (req, res) => {
    if (!uuidRe.test(req.query.tenant || '')) return bad(res, 400, 'Loja inválida');
    const kind = req.query.kind === 'daily' ? 'daily' : 'weekly';
    const period = resultsPeriod(kind, todayLocal());
    const s = (await linkStats(q, { from: period.from, to: period.to, tenantId: req.query.tenant })).stores[0];
    if (!s) return bad(res, 404, 'Loja não encontrada');
    res.json({ tenant_id: s.tenant_id, name: s.name, whatsapp: s.whatsapp, period, stats: s, message: fillTemplate(await template(), s, period) });
  }));

  app.post('/api/master/results-reports/sent', auth, roles('master'), route(async (req, res) => {
    const v = valid(z.object({ tenant_id: z.string().regex(uuidRe), period_key: z.string().regex(/^(daily|weekly):\d{4}-\d{2}-\d{2}$/), sent: z.boolean().default(true) }), req, res); if (!v) return;
    if (v.sent) await q('INSERT INTO results_report_sends(tenant_id, period_key, sent_by) VALUES($1, $2, $3) ON CONFLICT DO NOTHING', [v.tenant_id, v.period_key, req.user.id]);
    else await q('DELETE FROM results_report_sends WHERE tenant_id = $1 AND period_key = $2', [v.tenant_id, v.period_key]);
    res.status(204).end();
  }));

  app.patch('/api/master/tenants/:id/results-report', auth, roles('master'), route(async (req, res) => {
    if (!uuidRe.test(req.params.id)) return bad(res, 400, 'Loja inválida');
    const v = valid(z.object({ results_report: z.enum(['off', 'daily', 'weekly']), results_report_weekday: z.number().int().min(0).max(6).optional() }), req, res); if (!v) return;
    const r = await q('UPDATE tenants SET results_report = $2, results_report_weekday = COALESCE($3, results_report_weekday) WHERE id = $1 RETURNING id, results_report, results_report_weekday', [req.params.id, v.results_report, v.results_report_weekday ?? null]);
    if (!r.rowCount) return bad(res, 404, 'Loja não encontrada');
    await audit(req, 'update_results_report', 'tenant', req.params.id, req.params.id);
    res.json(r.rows[0]);
  }));
}
