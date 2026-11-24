// Mensagens do quiosque (rede): fila do dia de cada unidade, enviada pela vendedora pelo WhatsApp do
// próprio quiosque (wa.me, sem custo de envio). Tipos: obrigado (cashback, garantia, "Nossas lojas"),
// pedido de avaliação no Google (N dias depois da compra), cashback vencendo, aniversário e campanhas da rede.
// Cada cliente fica com a unidade da última compra (ou da ficha mais antiga), para não receber duas vezes.
// Dono e supervisor ajustam as regras do cashback e das mensagens no painel da rede.
import { z } from 'zod';
import { reviewLinkBase, reviewStatsByTenant } from './review-links.js';

const TZ = 'America/Fortaleza';
export const MESSAGE_DEFAULTS = {
  review_enabled: true, review_delay_days: 2,
  expiring_enabled: true, expiring_days: 7,
  birthday_enabled: true,
  texts: {
    thanks: 'Olá, {nome}! Obrigada pela compra na {loja}. {cashback}Seu comprovante e a garantia da joia: {comprovante}\nNossas lojas: {lojas}',
    review: 'Oi, {nome}! Gostou da sua compra na {loja}? Sua avaliação no Google ajuda muito a gente, leva 1 minutinho: {link_avaliacao}',
    expiring: 'Oi, {nome}! Você tem {saldo} de cashback na {marca} que vence em {validade}. Dá para usar em qualquer uma das nossas lojas: {lojas}',
    birthday: 'Feliz aniversário, {nome}! A {marca} deseja um dia lindo pra você.{saldo_frase} Nossas lojas: {lojas}',
  },
};
const TYPES = ['thanks', 'review', 'expiring', 'birthday', 'campaign'];
const brl = c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dmy = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '';
const base = () => (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const first = n => String(n || '').trim().split(/\s+/)[0] || '';
export const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? '').replace(/[ \t]+\n/g, '\n').trim();
export const settingsOf = net => {
  const s = net?.message_settings || {};
  return { ...MESSAGE_DEFAULTS, ...s, texts: { ...MESSAGE_DEFAULTS.texts, ...(s.texts || {}) } };
};

// Grupo da cliente na rede (fichas ligadas): coalesce(link_id, id).
const GROUP = 'coalesce(%.link_id,%.id)';
const grp = a => GROUP.replaceAll('%', a);
// A cliente "pertence" à unidade da última compra no grupo; sem compra, à ficha mais antiga.
const OWNER = `$1 = coalesce(
  (SELECT s.tenant_id FROM sales s JOIN customers g ON g.id = s.customer_id WHERE ${grp('g')} = ${grp('c')} AND s.canceled_at IS NULL ORDER BY s.created_at DESC LIMIT 1),
  (SELECT g.tenant_id FROM customers g WHERE ${grp('g')} = ${grp('c')} AND g.deleted_at IS NULL ORDER BY g.created_at LIMIT 1))`;
// Já mandado (ou pulado) para alguém do grupo, com esse rótulo, no intervalo.
const SENT = (label, days) => `EXISTS (SELECT 1 FROM customer_messages m JOIN customers g ON g.id = m.customer_id
  WHERE ${grp('g')} = ${grp('c')} AND m.campaign IN (${label}, 'skip:' || ${label}) AND m.created_at > now() - interval '${days} days')`;
const BALANCE = `(SELECT coalesce(sum(l.remaining_cents),0)::int FROM cashback_lots l JOIN customers g ON g.id = l.customer_id
  WHERE ${grp('g')} = ${grp('c')} AND l.reversed_at IS NULL AND l.remaining_cents > 0 AND l.expires_on >= $2::date)`;
const PHONE = "length(regexp_replace(coalesce(c.phone,''),'\\D','','g')) >= 10";

async function context(q, tenantId) {
  const t = (await q(`SELECT t.id, t.name, t.unit_label, t.google_review_url, t.network_id, n.name net_name, n.slug, n.hostname, n.message_settings
    FROM tenants t LEFT JOIN store_networks n ON n.id = t.network_id WHERE t.id = $1`, [tenantId])).rows[0];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  // Links com o endereço da rede (ex.: audace.ficoupronto.com), quando houver.
  const root = t?.hostname && /^[a-z0-9.-]+$/.test(t.hostname) ? 'https://' + t.hostname : base();
  return { t, today, root, cfg: settingsOf(t), lojas: t?.slug ? root + '/nossas-lojas/' + t.slug : '', marca: t?.net_name || t?.name, loja: t?.name };
}

export async function messageQueue(q, tenantId, { limit = 40 } = {}) {
  const { t, today, root, cfg, lojas, marca, loja } = await context(q, tenantId);
  const out = { today, review_link_missing: !t.google_review_url, counts: {}, items: [] };
  const push = (type, rows, make) => { out.counts[type] = (out.counts[type] || 0) + rows.length; for (const r of rows.slice(0, limit)) out.items.push({ type, customer_id: r.id, name: r.name, phone: r.phone, ...make(r) }); };
  const common = r => ({ nome: first(r.name), loja, marca, lojas });

  // 1. Obrigado: vendas de hoje e ontem com cliente, ainda sem mensagem.
  const thanks = (await q(`SELECT c.id, c.name, c.phone, s.id sale_id, s.sale_number, s.receipt_code, s.cashback_earned_cents, ${BALANCE} balance,
      (SELECT min(l.expires_on) FROM cashback_lots l WHERE l.sale_id = s.id) exp
    FROM sales s JOIN customers c ON c.id = s.customer_id
    WHERE s.tenant_id = $1 AND s.canceled_at IS NULL AND (s.created_at AT TIME ZONE '${TZ}')::date >= $2::date - 1 AND ${PHONE}
      AND NOT EXISTS (SELECT 1 FROM customer_messages m WHERE m.sale_id = s.id AND m.campaign IN ('thanks','skip:thanks'))
    ORDER BY s.created_at DESC`, [tenantId, today])).rows;
  push('thanks', thanks, r => ({ sale_id: r.sale_id, ref: 'Venda nº ' + r.sale_number, text: fill(cfg.texts.thanks, { ...common(r),
    cashback: r.cashback_earned_cents ? `Você ganhou ${brl(r.cashback_earned_cents)} de cashback${r.exp ? ', válido até ' + dmy(r.exp) : ''}, para usar em qualquer unidade. Seu saldo: ${brl(r.balance)}. ` : '',
    comprovante: r.receipt_code ? root + '/g/' + r.receipt_code : '' }) }));

  // 2. Avaliação no Google: compras de N a N+5 dias atrás nesta unidade, uma vez a cada 180 dias por cliente.
  if (cfg.review_enabled && t.google_review_url) {
    const d = Math.max(0, Number(cfg.review_delay_days) || 0);
    const rows = (await q(`SELECT DISTINCT ON (c.id) c.id, c.name, c.phone, c.review_code FROM sales s JOIN customers c ON c.id = s.customer_id
      WHERE s.tenant_id = $1 AND s.canceled_at IS NULL AND c.deleted_at IS NULL AND ${PHONE}
        AND (s.created_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date - ${d + 5} AND $2::date - ${d}
        AND NOT ${SENT("'review'", 180)} ORDER BY c.id`, [tenantId, today])).rows;
    push('review', rows, r => ({ text: fill(cfg.texts.review, { ...common(r), link_avaliacao: reviewLinkBase() + r.review_code }) }));
  }
  // 3. Cashback vencendo nos próximos dias (lotes desta unidade).
  if (cfg.expiring_enabled) {
    const days = Math.max(1, Number(cfg.expiring_days) || 7);
    const rows = (await q(`SELECT c.id, c.name, c.phone, min(l.expires_on) exp, ${BALANCE} balance FROM cashback_lots l JOIN customers c ON c.id = l.customer_id
      WHERE l.tenant_id = $1 AND l.reversed_at IS NULL AND l.remaining_cents > 0 AND l.expires_on BETWEEN $2::date AND $2::date + ${days}
        AND c.deleted_at IS NULL AND ${PHONE} AND NOT ${SENT("'expiring'", 10)} GROUP BY c.id ORDER BY min(l.expires_on)`, [tenantId, today])).rows;
    push('expiring', rows.filter(r => r.balance > 0), r => ({ text: fill(cfg.texts.expiring, { ...common(r), saldo: brl(r.balance), validade: dmy(r.exp) }) }));
  }
  // 4. Aniversariantes do dia (sem quem pediu para não receber ofertas).
  if (cfg.birthday_enabled) {
    const label = `'birthday-${today.slice(0, 4)}'`;
    const rows = (await q(`SELECT c.id, c.name, c.phone, ${BALANCE} balance FROM customers c
      WHERE c.tenant_id = $1 AND c.deleted_at IS NULL AND NOT c.offers_opt_out AND ${PHONE} AND c.birth_date IS NOT NULL
        AND to_char(c.birth_date, 'MM-DD') = to_char($2::date, 'MM-DD') AND ${OWNER} AND NOT ${SENT(label, 300)}`, [tenantId, today])).rows;
    push('birthday', rows, r => ({ campaign: label.slice(1, -1), text: fill(cfg.texts.birthday, { ...common(r), saldo_frase: r.balance ? ` Você tem ${brl(r.balance)} de cashback para usar.` : '' }) }));
  }
  // 5. Campanhas ativas da rede, para as clientes desta unidade.
  if (t.network_id) {
    const camps = (await q("SELECT * FROM network_campaigns WHERE network_id = $1 AND active AND $2::date BETWEEN starts_on AND ends_on ORDER BY created_at", [t.network_id, today])).rows;
    for (const cp of camps) {
      const label = `'net:${cp.id}'`;
      const aud = { all: 'true', birthday_month: "c.birth_date IS NOT NULL AND extract(month FROM c.birth_date) = extract(month FROM $2::date)", cashback_balance: `${BALANCE} > 0`,
        inactive_60: `NOT EXISTS (SELECT 1 FROM sales s JOIN customers g ON g.id = s.customer_id WHERE ${grp('g')} = ${grp('c')} AND s.canceled_at IS NULL AND s.created_at > now() - interval '60 days')` }[cp.audience];
      const rows = (await q(`SELECT c.id, c.name, c.phone, ${BALANCE} balance FROM customers c
        WHERE c.tenant_id = $1 AND c.deleted_at IS NULL AND NOT c.offers_opt_out AND ${PHONE} AND (${aud}) AND ${OWNER} AND NOT ${SENT(label, 400)} ORDER BY c.name`, [tenantId, today])).rows;
      push('campaign', rows, r => ({ campaign: label.slice(1, -1), ref: cp.title, text: fill(cp.body, { ...common(r), saldo: brl(r.balance) }) }));
    }
  }
  return out;
}

const KIND = { thanks: 'status', review: 'status', expiring: 'cashback', birthday: 'offer', campaign: 'offer' };

export function registerKioskMessages(app, { q, auth, roles, route, bad, valid, audit, uuid }) {
  const staff = [auth, roles('owner', 'operator')];
  const network = [auth, roles('network')];
  const scopeOk = (req, unitId) => req.user.network_access !== 'supervisor' || (req.user.network_unit_ids || []).includes(unitId);

  app.get('/api/store/kiosk/messages', ...staff, route(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await messageQueue(q, req.user.tenant_id));
  }));
  // Marca como enviada (ou pulada) depois que a vendedora abre o WhatsApp.
  app.post('/api/store/kiosk/messages/log', ...staff, route(async (req, res) => {
    const v = valid(z.object({ type: z.enum(TYPES), customer_id: uuid, sale_id: uuid.optional(), campaign: z.string().regex(/^(birthday-\d{4}|net:[0-9a-f-]{36})$/).optional(), skip: z.boolean().default(false) }).strict(), req, res); if (!v) return;
    const c = (await q('SELECT id FROM customers WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [v.customer_id, req.user.tenant_id])).rows[0];
    if (!c) return bad(res, 404, 'Cliente não encontrada nesta unidade');
    if (v.type === 'thanks' && !v.sale_id) return bad(res, 400, 'Informe a venda');
    if (v.sale_id && !(await q('SELECT 1 FROM sales WHERE id=$1 AND tenant_id=$2 AND customer_id=$3', [v.sale_id, req.user.tenant_id, v.customer_id])).rowCount) return bad(res, 404, 'Venda não encontrada');
    if (['birthday', 'campaign'].includes(v.type) && !v.campaign) return bad(res, 400, 'Informe a campanha');
    const label = { thanks: 'thanks', review: 'review', expiring: 'expiring' }[v.type] || v.campaign;
    await q('INSERT INTO customer_messages(tenant_id,customer_id,kind,sale_id,campaign,created_by,review_link) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [req.user.tenant_id, v.customer_id, KIND[v.type], v.sale_id || null, (v.skip ? 'skip:' : '') + label, req.user.id, v.type === 'review' && !v.skip]);
    res.status(201).json({ ok: true });
  }));

  // Página pública "Nossas lojas" (link da mensagem).
  app.get('/nossas-lojas/:slug', (_req, res) => res.sendFile('nossas-lojas.html', { root: 'public' }));
  app.get('/api/public/stores/:slug', route(async (req, res) => {
    if (!/^[a-z0-9-]{3,60}$/.test(req.params.slug)) return bad(res, 404, 'Não encontrado');
    const n = (await q("SELECT id,name,brand_color,logo_url FROM store_networks WHERE slug=$1 AND status='active'", [req.params.slug])).rows[0];
    if (!n) return bad(res, 404, 'Não encontrado');
    const u = (await q("SELECT coalesce(unit_label,name) name, address, opening_hours, whatsapp FROM tenants WHERE network_id=$1 AND status IN ('trial','active') AND NOT depot ORDER BY lower(coalesce(unit_label,name))", [n.id])).rows;
    res.set('Cache-Control', 'public, max-age=300').json({ name: n.name, brand_color: n.brand_color, logo_url: n.logo_url, stores: u });
  }));

  // ---- Painel da rede: regras do cashback e das mensagens, contato das unidades, campanhas, relatório ----
  app.get('/api/network/settings', ...network, route(async (req, res) => {
    const n = (await q('SELECT message_settings, low_stock_min, credit_valid_days FROM store_networks WHERE id=$1', [req.user.network_id])).rows[0];
    const units = (await q(`SELECT id, coalesce(unit_label,name) name, whatsapp, google_review_url, opening_hours, address, cashback_enabled, cashback_percent::float percent,
      cashback_max_use_percent, cashback_valid_days, cashback_min_sale_cents FROM tenants WHERE network_id=$1 ORDER BY lower(coalesce(unit_label,name))`, [req.user.network_id])).rows;
    const scope = req.user.network_access === 'supervisor' ? new Set(req.user.network_unit_ids || []) : null;
    const u0 = units[0] || {};
    res.set('Cache-Control', 'no-store').json({ can_edit: true, messages: settingsOf(n), stock: { low_stock_min: n?.low_stock_min ?? 1, credit_valid_days: n?.credit_valid_days ?? 180 },
      cashback: { enabled: !!u0.cashback_enabled, percent: u0.percent ?? 10, max_use_percent: u0.cashback_max_use_percent ?? 100, valid_days: u0.cashback_valid_days ?? 90, min_sale_cents: u0.cashback_min_sale_cents ?? 0,
        uniform: units.every(x => x.cashback_enabled === u0.cashback_enabled && x.percent === u0.percent && x.cashback_max_use_percent === u0.cashback_max_use_percent && x.cashback_valid_days === u0.cashback_valid_days && x.cashback_min_sale_cents === u0.cashback_min_sale_cents) },
      units: units.map(x => ({ id: x.id, name: x.name, whatsapp: x.whatsapp, google_review_url: x.google_review_url, opening_hours: x.opening_hours, address: x.address, editable: !scope || scope.has(x.id) })) });
  }));
  // O cashback vale na rede toda: a regra é a mesma nas unidades.
  app.put('/api/network/settings/cashback', ...network, route(async (req, res) => {
    const v = valid(z.object({ enabled: z.boolean(), percent: z.number().gt(0).max(50), max_use_percent: z.number().int().min(1).max(100), valid_days: z.number().int().min(7).max(730), min_sale_cents: z.number().int().min(0).max(100000000) }).strict(), req, res); if (!v) return;
    const r = await q(`UPDATE tenants SET cashback_enabled=$2, cashback_percent=$3, cashback_max_use_percent=$4, cashback_valid_days=$5, cashback_min_sale_cents=$6 WHERE network_id=$1 RETURNING id`,
      [req.user.network_id, v.enabled, v.percent, v.max_use_percent, v.valid_days, v.min_sale_cents]);
    await audit(req, 'update', 'network_cashback', req.user.network_id);
    res.json({ ok: true, units: r.rowCount });
  }));
  const textSchema = z.string().trim().min(5).max(1000);
  app.put('/api/network/settings/messages', ...network, route(async (req, res) => {
    const v = valid(z.object({ review_enabled: z.boolean(), review_delay_days: z.number().int().min(0).max(30), expiring_enabled: z.boolean(), expiring_days: z.number().int().min(1).max(30),
      birthday_enabled: z.boolean(), texts: z.object({ thanks: textSchema, review: textSchema, expiring: textSchema, birthday: textSchema }).strict() }).strict(), req, res); if (!v) return;
    await q('UPDATE store_networks SET message_settings=$2 WHERE id=$1', [req.user.network_id, v]);
    await audit(req, 'update', 'network_message_settings', req.user.network_id);
    res.json({ ok: true });
  }));
  app.put('/api/network/units/:id/contact', ...network, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    if (!scopeOk(req, req.params.id)) return bad(res, 403, 'Unidade fora da sua supervisão');
    const v = valid(z.object({ whatsapp: z.preprocess(x => typeof x === 'string' ? x.replace(/\D/g, '') : x, z.union([z.literal(''), z.string().regex(/^\d{10,13}$/, 'WhatsApp inválido')])),
      google_review_url: z.union([z.literal(''), z.string().trim().url().max(300).regex(/^https:\/\//, 'Use o link https do Google')]), opening_hours: z.string().trim().max(200) }).strict(), req, res); if (!v) return;
    const wa = v.whatsapp ? (v.whatsapp.length <= 11 ? '55' + v.whatsapp : v.whatsapp) : null;
    const r = await q('UPDATE tenants SET whatsapp=$3, google_review_url=$4, opening_hours=$5 WHERE id=$1 AND network_id=$2 RETURNING id', [req.params.id, req.user.network_id, wa, v.google_review_url || null, v.opening_hours || null]);
    if (!r.rowCount) return bad(res, 404, 'Unidade não encontrada');
    await audit(req, 'update', 'unit_contact', req.params.id, req.params.id);
    res.json({ ok: true });
  }));
  app.get('/api/network/campaigns', ...network, route(async (req, res) => {
    const r = await q(`SELECT c.*, to_char(c.starts_on,'YYYY-MM-DD') starts_on, to_char(c.ends_on,'YYYY-MM-DD') ends_on,
      (SELECT count(*)::int FROM customer_messages m JOIN tenants t ON t.id=m.tenant_id WHERE t.network_id=c.network_id AND m.campaign='net:'||c.id) sent
      FROM network_campaigns c WHERE c.network_id=$1 ORDER BY c.created_at DESC LIMIT 50`, [req.user.network_id]);
    res.set('Cache-Control', 'no-store').json(r.rows);
  }));
  app.post('/api/network/campaigns', ...network, route(async (req, res) => {
    const v = valid(z.object({ title: z.string().trim().min(2).max(80), body: textSchema, audience: z.enum(['all', 'inactive_60', 'birthday_month', 'cashback_balance']), starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(), req, res); if (!v) return;
    if (v.ends_on < v.starts_on) return bad(res, 400, 'O fim é antes do início');
    const r = await q('INSERT INTO network_campaigns(network_id,title,body,audience,starts_on,ends_on,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [req.user.network_id, v.title, v.body, v.audience, v.starts_on, v.ends_on, req.user.id]);
    await audit(req, 'create', 'network_campaign', r.rows[0].id);
    res.status(201).json(r.rows[0]);
  }));
  app.patch('/api/network/campaigns/:id', ...network, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ active: z.boolean() }).strict(), req, res); if (!v) return;
    const r = await q('UPDATE network_campaigns SET active=$3 WHERE id=$1 AND network_id=$2 RETURNING id', [req.params.id, req.user.network_id, v.active]);
    if (!r.rowCount) return bad(res, 404, 'Campanha não encontrada');
    await audit(req, v.active ? 'resume' : 'stop', 'network_campaign', req.params.id);
    res.json({ ok: true });
  }));
  // Envios do mês por unidade e tipo, mais quem abriu o link de avaliação.
  app.get('/api/network/messages/summary', ...network, route(async (req, res) => {
    const m = z.string().regex(/^\d{4}-\d{2}$/).safeParse(req.query.month); if (!m.success) return bad(res, 400, 'Mês inválido');
    const from = m.data + '-01', to = new Date(Date.UTC(+m.data.slice(0, 4), +m.data.slice(5, 7), 1)).toISOString().slice(0, 10);
    const scope = req.user.network_access === 'supervisor' ? (req.user.network_unit_ids || []) : null;
    const r = await q(`SELECT t.id, coalesce(t.unit_label,t.name) unit,
        count(*) FILTER (WHERE m.campaign='thanks')::int thanks, count(*) FILTER (WHERE m.campaign='review')::int review,
        count(*) FILTER (WHERE m.campaign='expiring')::int expiring, count(*) FILTER (WHERE m.campaign LIKE 'birthday-%')::int birthday,
        count(*) FILTER (WHERE m.campaign LIKE 'net:%')::int campaign
      FROM tenants t LEFT JOIN customer_messages m ON m.tenant_id=t.id AND m.created_at >= ($2::date::timestamp AT TIME ZONE '${TZ}') AND m.created_at < ($3::date::timestamp AT TIME ZONE '${TZ}')
      WHERE t.network_id=$1 AND ($4::uuid[] IS NULL OR t.id = ANY($4)) GROUP BY t.id ORDER BY 2`, [req.user.network_id, from, to, scope]);
    const stats = await reviewStatsByTenant(q, { from, to });
    res.set('Cache-Control', 'no-store').json(r.rows.map(x => ({ ...x, review_clicked: stats.get(x.id)?.review_clicked_of_sent || 0 })));
  }));
}
