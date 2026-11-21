// Rede de lojas: várias unidades (tenants) sob uma marca, com um painel geral para o dono da rede.
// - Central (master): cria a rede, liga e desliga unidades, define CNPJ e rótulo de cada unidade e cria o login do dono da rede.
// - Dono da rede (role 'network'): vê as unidades e o faturamento por unidade. Não opera caixa nem vê dados de clientes.
// - Público: /api/public/brand devolve nome, logo e cor da rede pelo endereço (ex.: audace.ficoupronto.com), para a tela de login.
import { z } from 'zod';
import { STORE_TZ } from './auto-close.js';

const slug = z.string().regex(/^[a-z0-9-]{3,60}$/);
const hostname = z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);
const logoUrl = z.string().trim().max(500).regex(/^https:\/\//);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const cnpjDigits = v => typeof v === 'string' ? v.replace(/\D/g, '') : v;
export const validCnpj = c => {
  if (!/^\d{14}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const dv = n => { const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = w.reduce((a, x, i) => a + x * Number(c[i]), 0) % 11; return s < 2 ? 0 : 11 - s; };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
};
const cnpjField = z.preprocess(cnpjDigits, z.string().refine(validCnpj, 'CNPJ inválido'));
const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MAX_RANGE_DAYS = 92;
const METHODS = ['cash', 'pix', 'debit', 'credit', 'other'];
const OWN_HOSTS = new Set(['ficoupronto.com', 'www.ficoupronto.com', 'app.ficoupronto.com']);

const networkOut = n => ({ id: n.id, name: n.name, slug: n.slug, hostname: n.hostname, logo_url: n.logo_url, brand_color: n.brand_color, status: n.status, created_at: n.created_at, units_count: n.units_count ?? undefined });

export function registerStoreNetworks(app, { q, auth, roles, route, bad, valid, audit, uuid, rateLimit, bcrypt }) {
  const master = [auth, roles('master')];
  const network = [auth, roles('network')];
  const uniqueError = (e, res, what) => { if (e.code === '23505') { bad(res, 409, what + ' já está em uso'); return true; } return false; };

  // ---- Central ----
  app.get('/api/master/networks', ...master, route(async (_req, res) => {
    const r = await q('SELECT n.*, (SELECT count(*)::int FROM tenants t WHERE t.network_id = n.id) units_count FROM store_networks n ORDER BY lower(n.name)');
    res.json(r.rows.map(networkOut));
  }));

  app.post('/api/master/networks', ...master, route(async (req, res) => {
    const v = valid(z.object({ name: z.string().trim().min(2).max(120), slug, hostname: hostname.nullable().optional(), logo_url: logoUrl.nullable().optional(), brand_color: color.nullable().optional() }).strict(), req, res); if (!v) return;
    try {
      const r = await q('INSERT INTO store_networks(name, slug, hostname, logo_url, brand_color) VALUES($1,$2,$3,$4,$5) RETURNING *', [v.name, v.slug, v.hostname || null, v.logo_url || null, v.brand_color || null]);
      await audit(req, 'create', 'store_network', r.rows[0].id, null);
      res.status(201).json(networkOut({ ...r.rows[0], units_count: 0 }));
    } catch (e) { if (!uniqueError(e, res, 'Identificador ou endereço')) throw e; }
  }));

  app.patch('/api/master/networks/:id', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ name: z.string().trim().min(2).max(120).optional(), hostname: hostname.nullable().optional(), logo_url: logoUrl.nullable().optional(), brand_color: color.nullable().optional(), status: z.enum(['active', 'suspended']).optional() }).strict(), req, res); if (!v) return;
    const keys = Object.keys(v); if (!keys.length) return bad(res, 400, 'Nada para alterar');
    try {
      const r = await q(`UPDATE store_networks SET ${keys.map((k, i) => k + ' = $' + (i + 2)).join(', ')} WHERE id = $1 RETURNING *`, [req.params.id, ...keys.map(k => v[k] === '' ? null : v[k])]);
      if (!r.rowCount) return bad(res, 404, 'Rede não encontrada');
      brandCache.clear();
      await audit(req, 'update', 'store_network', req.params.id, null);
      res.json(networkOut(r.rows[0]));
    } catch (e) { if (!uniqueError(e, res, 'Endereço')) throw e; }
  }));

  app.get('/api/master/networks/:id/units', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const r = await q('SELECT id, name, slug, unit_label, cnpj, city, status, sales_enabled FROM tenants WHERE network_id = $1 ORDER BY lower(coalesce(unit_label, name))', [req.params.id]);
    res.json(r.rows);
  }));

  // Liga a unidade a uma rede (ou tira, com network_id null) e define CNPJ e rótulo.
  app.patch('/api/master/tenants/:id/network', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ network_id: uuid.nullable().optional(), cnpj: z.union([z.literal(''), cnpjField]).nullable().optional(), unit_label: z.string().trim().max(60).nullable().optional() }).strict(), req, res); if (!v) return;
    const keys = Object.keys(v); if (!keys.length) return bad(res, 400, 'Nada para alterar');
    if (v.network_id && !(await q('SELECT 1 FROM store_networks WHERE id = $1', [v.network_id])).rowCount) return bad(res, 404, 'Rede não encontrada');
    try {
      const r = await q(`UPDATE tenants SET ${keys.map((k, i) => k + ' = $' + (i + 2)).join(', ')} WHERE id = $1 RETURNING id, name, network_id, cnpj, unit_label`, [req.params.id, ...keys.map(k => v[k] === '' ? null : v[k])]);
      if (!r.rowCount) return bad(res, 404, 'Loja não encontrada');
      await audit(req, 'update_network', 'tenant', req.params.id, req.params.id);
      res.json(r.rows[0]);
    } catch (e) { if (!uniqueError(e, res, 'CNPJ')) throw e; }
  }));

  app.get('/api/master/networks/:id/users', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    res.json((await q("SELECT id, name, email, active, created_at FROM users WHERE network_id = $1 AND role = 'network' ORDER BY active DESC, lower(name)", [req.params.id])).rows);
  }));

  app.post('/api/master/networks/:id/users', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ name: z.string().trim().min(2).max(120), email: z.string().email(), password: z.string().min(12) }).strict(), req, res); if (!v) return;
    if (!(await q('SELECT 1 FROM store_networks WHERE id = $1', [req.params.id])).rowCount) return bad(res, 404, 'Rede não encontrada');
    try {
      const r = await q("INSERT INTO users(network_id, name, email, password_hash, role) VALUES($1,$2,$3,$4,'network') RETURNING id, name, email, active, created_at", [req.params.id, v.name, v.email.toLowerCase(), await bcrypt.hash(v.password, 12)]);
      await audit(req, 'create', 'user', r.rows[0].id, null);
      res.status(201).json(r.rows[0]);
    } catch (e) { if (!uniqueError(e, res, 'E-mail')) throw e; }
  }));

  app.patch('/api/master/network-users/:id', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ active: z.boolean().optional(), name: z.string().trim().min(2).max(120).optional() }).strict(), req, res); if (!v) return;
    const r = await q("UPDATE users SET active = COALESCE($2, active), name = COALESCE($3, name) WHERE id = $1 AND role = 'network' RETURNING id, name, email, active", [req.params.id, v.active ?? null, v.name ?? null]);
    if (!r.rowCount) return bad(res, 404, 'Usuário não encontrado');
    await audit(req, 'update', 'user', req.params.id, null);
    res.json(r.rows[0]);
  }));

  // ---- Dono da rede ----
  app.get('/api/network/me', ...network, route(async (req, res) => {
    const n = await q('SELECT * FROM store_networks WHERE id = $1', [req.user.network_id]);
    const units = await q('SELECT id, name, unit_label, cnpj, city, status, sales_enabled FROM tenants WHERE network_id = $1 ORDER BY lower(coalesce(unit_label, name))', [req.user.network_id]);
    res.set('Cache-Control', 'no-store').json({ network: networkOut(n.rows[0]), units: units.rows });
  }));

  // Faturamento por unidade num período (dias no fuso da loja). Padrão: hoje.
  app.get('/api/network/overview', ...network, route(async (req, res) => {
    const p = z.object({ from: dateField.optional(), to: dateField.optional() }).safeParse(req.query);
    if (!p.success) return bad(res, 400, 'Período inválido');
    const today = (await q('SELECT to_char((now() AT TIME ZONE $1)::date, \'YYYY-MM-DD\') d', [STORE_TZ])).rows[0].d;
    const from = p.data.from || p.data.to || today, to = p.data.to || p.data.from || today;
    const span = (await q('SELECT ($2::date - $1::date) days', [from, to])).rows[0].days;
    if (span < 0 || span >= MAX_RANGE_DAYS) return bad(res, 400, 'Período inválido (máximo de ' + MAX_RANGE_DAYS + ' dias)');
    const r = await q(`
      WITH units AS (SELECT id, name, unit_label, status FROM tenants WHERE network_id = $1),
      s AS (
        SELECT s.* FROM sales s JOIN units u ON u.id = s.tenant_id
        WHERE (s.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
      ),
      pay AS (
        SELECT s.tenant_id, coalesce(p->>'method', s.payment_method) method,
               coalesce((p->>'amount_cents')::bigint, s.total_cents) amount
        FROM s LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.payments) = 'array' THEN s.payments ELSE NULL END) p ON true
        WHERE s.canceled_at IS NULL
      )
      SELECT u.id, u.name, u.unit_label, u.status,
        (SELECT count(*)::int FROM s WHERE s.tenant_id = u.id AND s.canceled_at IS NULL) sales_count,
        (SELECT coalesce(sum(total_cents), 0)::bigint FROM s WHERE s.tenant_id = u.id AND s.canceled_at IS NULL) total_cents,
        (SELECT count(*)::int FROM s WHERE s.tenant_id = u.id AND s.canceled_at IS NOT NULL) canceled_count,
        (SELECT coalesce(jsonb_object_agg(method, amount), '{}'::jsonb) FROM (SELECT method, sum(amount)::bigint amount FROM pay WHERE pay.tenant_id = u.id GROUP BY method) m) by_method
      FROM units u ORDER BY lower(coalesce(u.unit_label, u.name))`, [req.user.network_id, from, to, STORE_TZ]);
    const units = r.rows.map(u => {
      const total = Number(u.total_cents), by = {};
      for (const k of METHODS) by[k] = Number(u.by_method[k] || 0);
      return { id: u.id, name: u.unit_label || u.name, status: u.status, sales_count: u.sales_count, total_cents: total, canceled_count: u.canceled_count, average_ticket_cents: u.sales_count ? Math.round(total / u.sales_count) : 0, by_method: by };
    });
    const totals = units.reduce((a, u) => { a.sales_count += u.sales_count; a.total_cents += u.total_cents; a.canceled_count += u.canceled_count; for (const k of METHODS) a.by_method[k] += u.by_method[k]; return a; }, { sales_count: 0, total_cents: 0, canceled_count: 0, by_method: Object.fromEntries(METHODS.map(k => [k, 0])) });
    totals.average_ticket_cents = totals.sales_count ? Math.round(totals.total_cents / totals.sales_count) : 0;
    res.set('Cache-Control', 'no-store').json({ from, to, units, totals });
  }));

  // ---- Público: marca da rede pelo endereço ----
  const brandCache = new Map();
  const brandFor = async req => {
    const host = String(req.hostname || '').toLowerCase();
    // Endereços do próprio Ficou Pronto nunca são de rede: não consulta o banco (deixa o Neon dormir no silêncio).
    if (!host || OWN_HOSTS.has(host) || host.endsWith('.onrender.com') || /^[\d.]+$|^\[|^localhost$/.test(host)) return { network: false };
    const hit = brandCache.get(host);
    if (hit && Date.now() - hit.at < 60000) return hit.data;
    const r = await q("SELECT name, logo_url, brand_color FROM store_networks WHERE hostname = $1 AND status = 'active'", [host]);
    const data = r.rows[0] ? { network: true, name: r.rows[0].name, logo_url: r.rows[0].logo_url, brand_color: r.rows[0].brand_color } : { network: false };
    if (brandCache.size > 500) brandCache.clear();
    brandCache.set(host, { at: Date.now(), data });
    return data;
  };
  app.get('/api/public/brand', rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }), route(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60').json(await brandFor(req));
  }));
  // No endereço próprio da rede, a página inicial é a tela de login (não o site do Ficou Pronto).
  app.get('/', route(async (req, res, next) => { if ((await brandFor(req)).network) return res.redirect(302, '/entrar'); next(); }));
}
