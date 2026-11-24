import { tierFor } from './commission-tiers.js';
import { openClaims } from './warranty.js';
// Rede de lojas: várias unidades (tenants) sob uma marca, com um painel geral para o dono da rede.
// - Central (master): cria a rede, liga e desliga unidades, define CNPJ e rótulo de cada unidade e cria o login do dono da rede.
// - Dono da rede (role 'network'): vê as unidades e o faturamento por unidade. Não opera caixa nem vê dados de clientes.
// - Público: /api/public/brand devolve nome, logo e cor da rede pelo endereço (ex.: audace.ficoupronto.com), para a tela de login.
import crypto from 'node:crypto';
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

  // Faixas de comissão da rede (central).
  app.put('/api/master/networks/:id/commission-tiers', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ tiers: z.array(z.object({ min_cents: z.number().int().min(0).max(1000000000), percent: z.number().min(0).max(50).multipleOf(0.01) }).strict()).max(10) }).strict(), req, res); if (!v) return;
    const tiers = [...v.tiers].sort((a, b) => a.min_cents - b.min_cents);
    if (new Set(tiers.map(t => t.min_cents)).size !== tiers.length) return bad(res, 400, 'Duas faixas com o mesmo valor mínimo');
    const r = await q('UPDATE store_networks SET commission_tiers = $2 WHERE id = $1 RETURNING commission_tiers', [req.params.id, JSON.stringify(tiers)]);
    if (!r.rowCount) return bad(res, 404, 'Rede não encontrada');
    await audit(req, 'update', 'commission_tiers', req.params.id); res.json(r.rows[0]);
  }));
  // Painel da rede: vendas do mês e comissão por vendedora (faixas da rede).
  app.get('/api/network/commissions', ...network, route(async (req, res) => {
    const m = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).safeParse(req.query);
    if (!m.success) return bad(res, 400, 'Mês inválido');
    const month = m.data.month || (await q("SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM') m", [STORE_TZ])).rows[0].m;
    const tiers = (await q('SELECT commission_tiers FROM store_networks WHERE id = $1', [req.user.network_id])).rows[0]?.commission_tiers || [];
    const r = await q(`SELECT u.id, u.name, coalesce(t.unit_label, t.name) unit, coalesce(sum(x.total_cents) FILTER (WHERE x.id IS NOT NULL), 0)::bigint total, count(x.id)::int n
      FROM users u JOIN tenants t ON t.id = u.tenant_id
      LEFT JOIN sales x ON x.seller_id = u.id AND x.canceled_at IS NULL AND to_char(x.created_at AT TIME ZONE $3, 'YYYY-MM') = $4
      WHERE t.network_id = $1 AND ($2::uuid[] IS NULL OR t.id = ANY($2)) AND u.login_kind = 'pin' AND (u.active OR x.id IS NOT NULL)
      GROUP BY u.id, u.name, t.unit_label, t.name ORDER BY total DESC, u.name`, [req.user.network_id, scope(req), STORE_TZ, month]);
    const rows = r.rows.map(x => { const tt = tierFor(tiers, Number(x.total)); return { id: x.id, name: x.name, unit: x.unit, sales_count: x.n, total_cents: Number(x.total), percent: tt ? tt.percent : 0, commission_cents: tt ? tt.estimated_cents : 0, next: tt?.next || null }; });
    res.set('Cache-Control', 'no-store').json({ month, tiers, sellers: rows, total_commission_cents: rows.reduce((a, x) => a + x.commission_cents, 0) });
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

  // ---- Pessoas da rede (central) ----
  // Uma lista só com donos, supervisores e o pessoal de cada unidade. "Função" vira papel no sistema:
  //   dono → rede, vê tudo · supervisor → rede, só as unidades marcadas
  //   vendedora → sem login: confirma a venda no caixa do quiosque com o PIN de 4 dígitos
  //   gerente → dono da loja na unidade · responsavel → operador livre com e-mail · consultora → operador novato com e-mail
  // Dono, supervisor e gerente podem ter PIN para autorizar cancelamento no quiosque.
  const FUNCS = {
    dono: { role: 'network', access: 'owner' }, supervisor: { role: 'network', access: 'supervisor' },
    vendedora: { role: 'operator', level: 'full', pin: true },
    gerente: { role: 'owner', level: 'full' }, responsavel: { role: 'operator', level: 'full' }, consultora: { role: 'operator', level: 'basic' }
  };
  const funcOf = u => u.login_kind === 'pin' ? 'vendedora' : u.role === 'network' ? (u.network_access === 'supervisor' ? 'supervisor' : 'dono') : u.role === 'owner' ? 'gerente' : u.access_level === 'basic' ? 'consultora' : 'responsavel';
  const tempPassword = () => 'Fp-' + crypto.randomBytes(9).toString('base64url');
  const tempPin = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');
  const pinEmail = () => 'vendedora+' + crypto.randomUUID() + '@pin.invalid';
  const personSchema = z.object({
    name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(200).optional(),
    function: z.enum(Object.keys(FUNCS)), unit_id: uuid.nullable().optional(), unit_ids: z.array(uuid).max(50).optional(),
    active: z.boolean().optional(), password: z.string().min(12).max(200).optional(), pin: z.string().regex(/^\d{4}$/).optional()
  }).strict();
  async function networkUnits(networkId) { return new Set((await q('SELECT id FROM tenants WHERE network_id = $1', [networkId])).rows.map(r => r.id)); }
  // Converte função + unidade(s) nas colunas do usuário; null = combinação inválida.
  function placement(v, networkId, units) {
    const f = FUNCS[v.function];
    if (f.role === 'network') {
      const ids = f.access === 'supervisor' ? [...new Set(v.unit_ids || [])] : [];
      if (ids.some(id => !units.has(id))) return null;
      return { role: 'network', tenant_id: null, network_id: networkId, network_access: f.access, network_unit_ids: ids, access_level: 'full', login_kind: 'email' };
    }
    if (!v.unit_id || !units.has(v.unit_id)) return null;
    return { role: f.role, tenant_id: v.unit_id, network_id: null, network_access: 'owner', network_unit_ids: [], access_level: f.level, login_kind: f.pin ? 'pin' : 'email' };
  }
  const personOut = u => ({ id: u.id, name: u.name, email: u.login_kind === 'pin' ? null : u.email, active: u.active, function: funcOf(u), unit_id: u.tenant_id || null,
    unit_ids: u.role === 'network' ? (u.network_unit_ids || []) : [], has_pin: !!u.pin_hash, created_at: u.created_at });

  app.get('/api/master/networks/:id/people', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const r = await q(`SELECT u.id, u.name, u.email, u.active, u.role, u.tenant_id, u.network_access, u.network_unit_ids, u.access_level, u.login_kind, u.pin_hash, u.created_at
      FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE (u.network_id = $1 OR (t.network_id = $1 AND u.role IN ('owner', 'operator'))) AND u.login_kind <> 'kiosk'
      ORDER BY CASE WHEN u.role = 'network' THEN 0 ELSE 1 END, lower(coalesce(t.unit_label, t.name, '')), (u.login_kind = 'pin') DESC, lower(u.name)`, [req.params.id]);
    res.set('Cache-Control', 'no-store').json(r.rows.map(personOut));
  }));

  app.post('/api/master/networks/:id/people', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(personSchema, req, res); if (!v) return;
    if (!(await q('SELECT 1 FROM store_networks WHERE id = $1', [req.params.id])).rowCount) return bad(res, 404, 'Rede não encontrada');
    const p = placement(v, req.params.id, await networkUnits(req.params.id)); if (!p) return bad(res, 400, 'Escolha a unidade (ou as unidades do supervisor) desta rede');
    const isPin = p.login_kind === 'pin';
    if (!isPin && !v.email) return bad(res, 400, 'Informe o e-mail (só a vendedora entra sem e-mail, com PIN)');
    const password = isPin ? null : (v.password || tempPassword());
    const pin = v.pin || (isPin ? tempPin() : null);
    try {
      const r = await q(`INSERT INTO users(name, email, password_hash, role, tenant_id, network_id, network_access, network_unit_ids, access_level, active, login_kind, pin_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [v.name, isPin ? pinEmail() : v.email, await bcrypt.hash(password || crypto.randomBytes(24).toString('hex'), 12),
        p.role, p.tenant_id, p.network_id, p.network_access, p.network_unit_ids, p.access_level, v.active ?? true, p.login_kind, pin ? await bcrypt.hash(pin, 10) : null]);
      await audit(req, 'create', 'user', r.rows[0].id, p.tenant_id);
      res.status(201).json({ ...personOut(r.rows[0]), ...(!isPin && !v.password ? { temporary_password: password } : {}), ...(pin && !v.pin ? { temporary_pin: pin } : {}) });
    } catch (e) { if (!uniqueError(e, res, 'E-mail')) throw e; }
  }));

  app.patch('/api/master/network-people/:id', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(personSchema.omit({ password: true }).partial(), req, res); if (!v) return;
    const cur = (await q(`SELECT u.*, coalesce(u.network_id, t.network_id) net FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1 AND u.role IN ('network', 'owner', 'operator') AND u.login_kind <> 'kiosk'`, [req.params.id])).rows[0];
    if (!cur?.net) return bad(res, 404, 'Pessoa não encontrada nesta rede');
    const merged = { function: v.function ?? funcOf(cur), unit_id: v.unit_id !== undefined ? v.unit_id : cur.tenant_id, unit_ids: v.unit_ids ?? cur.network_unit_ids };
    const p = placement(merged, cur.net, await networkUnits(cur.net)); if (!p) return bad(res, 400, 'Escolha a unidade (ou as unidades do supervisor) desta rede');
    const isPin = p.login_kind === 'pin';
    // Deixar de ser vendedora exige e-mail real; virar vendedora troca o e-mail por um interno.
    let email = v.email ?? null;
    if (isPin) email = cur.login_kind === 'pin' ? cur.email : pinEmail();
    else if (cur.login_kind === 'pin' && !v.email) return bad(res, 400, 'Informe o e-mail para dar login a esta pessoa');
    const newPin = v.pin || (isPin && !cur.pin_hash ? tempPin() : null);
    try {
      const r = await q(`UPDATE users SET name = coalesce($2, name), email = coalesce($3, email), active = coalesce($4, active),
        role = $5, tenant_id = $6, network_id = $7, network_access = $8, network_unit_ids = $9, access_level = $10, login_kind = $11,
        pin_hash = coalesce($12, pin_hash), password_changed_at = CASE WHEN login_kind <> $11 THEN now() ELSE password_changed_at END WHERE id = $1 RETURNING *`,
        [cur.id, v.name ?? null, email, v.active ?? null, p.role, p.tenant_id, p.network_id, p.network_access, p.network_unit_ids, p.access_level, p.login_kind, newPin ? await bcrypt.hash(newPin, 10) : null]);
      await audit(req, 'update', 'user', cur.id, p.tenant_id);
      res.json({ ...personOut(r.rows[0]), ...(newPin && !v.pin ? { temporary_pin: newPin } : {}) });
    } catch (e) { if (!uniqueError(e, res, 'E-mail')) throw e; }
  }));

  // ---- Dono da rede e supervisores ----
  // Dono vê todas as unidades; supervisor só as que acompanha (lista vazia = nenhuma).
  const scope = req => req.user.network_access === 'supervisor' ? (req.user.network_unit_ids || []) : null;
  app.get('/api/network/me', ...network, route(async (req, res) => {
    const n = await q('SELECT * FROM store_networks WHERE id = $1', [req.user.network_id]);
    const units = await q('SELECT id, name, unit_label, cnpj, city, status, sales_enabled FROM tenants WHERE network_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY lower(coalesce(unit_label, name))', [req.user.network_id, scope(req)]);
    const me = await q('SELECT name FROM users WHERE id = $1', [req.user.id]);
    res.set('Cache-Control', 'no-store').json({ network: networkOut(n.rows[0]), units: units.rows, user: { name: me.rows[0]?.name || '', access: req.user.network_access || 'owner' } });
  }));

  // Faturamento por unidade num período (dias no fuso da loja). Padrão: hoje.
  // Marca como conciliada a venda paga na maquininha avulsa (o ECONF foi enviado pelo emissor ou conferido à mão).
  app.post('/api/network/sales/:id/econf-done', ...network, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Venda inválida');
    const r = await q(`UPDATE sales s SET econf_done_at = now(), econf_done_by = $3 FROM tenants t
      WHERE s.id = $1 AND t.id = s.tenant_id AND t.network_id = $2 AND ($4::uuid[] IS NULL OR t.id = ANY($4)) AND s.offline_payment AND s.econf_done_at IS NULL RETURNING s.id`,
      [req.params.id, req.user.network_id, req.user.id, scope(req)]);
    if (!r.rowCount) return bad(res, 404, 'Pendência não encontrada');
    await audit(req, 'econf_done', 'sale', req.params.id); res.json({ done: true });
  }));

  app.get('/api/network/overview', ...network, route(async (req, res) => {
    const p = z.object({ from: dateField.optional(), to: dateField.optional() }).safeParse(req.query);
    if (!p.success) return bad(res, 400, 'Período inválido');
    const today = (await q('SELECT to_char((now() AT TIME ZONE $1)::date, \'YYYY-MM-DD\') d', [STORE_TZ])).rows[0].d;
    const from = p.data.from || p.data.to || today, to = p.data.to || p.data.from || today;
    const span = (await q('SELECT ($2::date - $1::date) days', [from, to])).rows[0].days;
    if (span < 0 || span >= MAX_RANGE_DAYS) return bad(res, 400, 'Período inválido (máximo de ' + MAX_RANGE_DAYS + ' dias)');
    const r = await q(`
      WITH units AS (SELECT id, name, unit_label, status FROM tenants WHERE network_id = $1 AND ($5::uuid[] IS NULL OR id = ANY($5))),
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
        (SELECT coalesce(jsonb_object_agg(method, amount), '{}'::jsonb) FROM (SELECT method, sum(amount)::bigint amount FROM pay WHERE pay.tenant_id = u.id GROUP BY method) m) by_method,
        (SELECT coalesce(sum(cashback_used_cents), 0)::bigint FROM s WHERE s.tenant_id = u.id AND s.canceled_at IS NULL) cashback_used_cents,
        EXISTS (SELECT 1 FROM cash_sessions c WHERE c.tenant_id = u.id AND c.status = 'open') cash_open,
        -- Meta do mês da loja (store_goals sem vendedora; 0 = sem meta) e o vendido no mês até agora.
        (SELECT nullif(g.target_cents, 0) FROM store_goals g WHERE g.tenant_id = u.id AND g.user_id IS NULL AND g.month <= date_trunc('month', (now() AT TIME ZONE $4))::date ORDER BY g.month DESC LIMIT 1) month_goal_cents,
        (SELECT coalesce(sum(x.total_cents), 0)::bigint FROM sales x WHERE x.tenant_id = u.id AND x.canceled_at IS NULL AND x.created_at >= (date_trunc('month', now() AT TIME ZONE $4) AT TIME ZONE $4)) month_total_cents
      FROM units u ORDER BY lower(coalesce(u.unit_label, u.name))`, [req.user.network_id, from, to, STORE_TZ, scope(req)]);
    // Alertas do período: cobrança repetida (mesmo valor e forma na mesma unidade em até 2 minutos), cancelamentos e estoque baixo.
    const dup = await q(`
      SELECT coalesce(t.unit_label, t.name) unit, b.total_cents, b.payment_method, to_char(b.created_at AT TIME ZONE $4, 'HH24:MI') at,
             extract(epoch FROM b.created_at - a.created_at)::int seconds
      FROM sales a JOIN sales b ON b.tenant_id = a.tenant_id AND b.id <> a.id AND b.total_cents = a.total_cents
        AND b.payment_method = a.payment_method AND b.payments IS NOT DISTINCT FROM a.payments
        AND b.created_at > a.created_at AND b.created_at <= a.created_at + interval '2 minutes'
      JOIN tenants t ON t.id = a.tenant_id
      WHERE t.network_id = $1 AND ($5::uuid[] IS NULL OR t.id = ANY($5)) AND a.canceled_at IS NULL AND b.canceled_at IS NULL
        AND (b.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
      ORDER BY b.created_at DESC LIMIT 20`, [req.user.network_id, from, to, STORE_TZ, scope(req)]);
    const canceled = await q(`
      SELECT coalesce(t.unit_label, t.name) unit, s.total_cents, coalesce(s.cancel_reason, '') reason, cu.name canceled_by,
             to_char(s.canceled_at AT TIME ZONE $4, 'DD/MM HH24:MI') at
      FROM sales s JOIN tenants t ON t.id = s.tenant_id LEFT JOIN users cu ON cu.id = s.canceled_by
      WHERE t.network_id = $1 AND ($5::uuid[] IS NULL OR t.id = ANY($5)) AND s.canceled_at IS NOT NULL AND (s.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
      ORDER BY s.canceled_at DESC LIMIT 50`, [req.user.network_id, from, to, STORE_TZ, scope(req)]);
    // Estoque baixo: peças com estoque controlado, 1 unidade ou menos, que venderam nos últimos 30 dias.
    const low = await q(`
      SELECT coalesce(t.unit_label, t.name) unit, p.name, p.stock_qty, sum(i.quantity)::int sold
      FROM products p JOIN tenants t ON t.id = p.tenant_id
      JOIN sale_items i ON i.product_id = p.id AND i.tenant_id = p.tenant_id
      JOIN sales s ON s.id = i.sale_id AND s.canceled_at IS NULL AND s.created_at >= now() - interval '30 days'
      WHERE t.network_id = $1 AND ($2::uuid[] IS NULL OR t.id = ANY($2)) AND p.active AND p.stock_qty IS NOT NULL AND p.stock_qty <= 1
      GROUP BY t.unit_label, t.name, p.id ORDER BY sold DESC LIMIT 30`, [req.user.network_id, scope(req)]);
    const lowByUnit = [];
    for (const row of low.rows) { let u = lowByUnit.find(x => x.unit === row.unit); if (!u) lowByUnit.push(u = { unit: row.unit, products: [] }); u.products.push({ name: row.name, stock_qty: row.stock_qty, sold_30d: row.sold }); }
    const units = r.rows.map(u => {
      const total = Number(u.total_cents), by = {};
      for (const k of METHODS) by[k] = Number(u.by_method[k] || 0);
      const goal = u.month_goal_cents == null ? null : Number(u.month_goal_cents), month = Number(u.month_total_cents);
      return { id: u.id, name: u.unit_label || u.name, status: u.status, sales_count: u.sales_count, total_cents: total, canceled_count: u.canceled_count, average_ticket_cents: u.sales_count ? Math.round(total / u.sales_count) : 0, by_method: by,
        cashback_used_cents: Number(u.cashback_used_cents), cash_open: u.cash_open, month_total_cents: month, month_goal_cents: goal, month_goal_percent: goal ? Math.round(month * 100 / goal) : null };
    });
    const totals = units.reduce((a, u) => { a.sales_count += u.sales_count; a.total_cents += u.total_cents; a.canceled_count += u.canceled_count; a.cashback_used_cents += u.cashback_used_cents; for (const k of METHODS) a.by_method[k] += u.by_method[k]; return a; }, { sales_count: 0, total_cents: 0, canceled_count: 0, cashback_used_cents: 0, by_method: Object.fromEntries(METHODS.map(k => [k, 0])) });
    totals.average_ticket_cents = totals.sales_count ? Math.round(totals.total_cents / totals.sales_count) : 0;
    // Pinpad fora do ar: vendas pagas na maquininha avulsa ainda sem conciliação (ECONF), de qualquer data.
    const econf = await q(`SELECT s.id, coalesce(t.unit_label, t.name) unit, s.sale_number, s.total_cents, s.payment_method, s.offline_auth,
        to_char(s.created_at AT TIME ZONE $3, 'DD/MM HH24:MI') at
      FROM sales s JOIN tenants t ON t.id = s.tenant_id
      WHERE t.network_id = $1 AND ($2::uuid[] IS NULL OR t.id = ANY($2)) AND s.offline_payment AND s.econf_done_at IS NULL AND s.canceled_at IS NULL
      ORDER BY s.created_at LIMIT 200`, [req.user.network_id, scope(req), STORE_TZ]);
    const alerts = {
      warranty_open: await openClaims(q, req.user.network_id, scope(req)),
      econf_pending: econf.rows,
      duplicates: dup.rows.map(d => ({ unit: d.unit, total_cents: d.total_cents, payment_method: d.payment_method, at: d.at, seconds: d.seconds })),
      canceled: canceled.rows.map(c => ({ unit: c.unit, total_cents: c.total_cents, reason: c.reason, canceled_by: c.canceled_by || '', at: c.at })),
      low_stock: lowByUnit
    };
    res.set('Cache-Control', 'no-store').json({ from, to, units, totals, alerts });
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
  // No endereço próprio da rede, a página inicial e a de entrada viram a tela de acesso com a marca da rede
  // (não o site do Ficou Pronto).
  app.get(['/', '/entrar', '/entrar.html'], route(async (req, res, next) => { if ((await brandFor(req)).network) return res.redirect(302, '/acesso'); next(); }));
}
