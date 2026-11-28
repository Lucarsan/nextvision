import { tierFor, tiersForTenant } from './commission-tiers.js';
// Acesso por quiosque (proposta da Audace, p. 6 e 7).
// - O computador do quiosque abre o caixa com a senha da unidade e fica aberto o dia todo.
// - Vendedora não tem login: toca no nome e digita o PIN de 4 dígitos para confirmar a venda.
// - Na mesma tela, a senha de um dono (ou de um supervisor daquela unidade) abre direto o painel da rede.
// - Cancelar venda no quiosque pede o PIN de quem vendeu e o PIN de um supervisor, dono ou gerente.
import crypto from 'node:crypto';
import { passwordMatches } from './password-input.js';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { gateLogin, proofField, networkLocked } from './device-lock.js';

const OWN_HOSTS = new Set(['ficoupronto.com', 'www.ficoupronto.com', 'app.ficoupronto.com']);
export const PIN = z.string().regex(/^\d{4}$/, 'PIN de 4 dígitos');
const firstName = n => String(n || '').trim().split(/\s+/)[0];

// PIN de uma vendedora (ou de quem autoriza) confere? Usa o cliente da transação quando houver.
export async function pinOk(client, bcrypt, userId, pin) {
  if (!userId || !/^\d{4}$/.test(String(pin || ''))) return false;
  const r = await client.query('SELECT pin_hash FROM users WHERE id = $1 AND active', [userId]);
  return !!r.rows[0]?.pin_hash && bcrypt.compare(String(pin), r.rows[0].pin_hash);
}

// Quem pode autorizar com PIN numa unidade: dono ou supervisor da rede que cobre a unidade, ou o gerente (owner) da loja.
export async function authorizerByPin(client, bcrypt, tenantId, pin) {
  if (!/^\d{4}$/.test(String(pin || ''))) return null;
  const r = await client.query(`SELECT u.id, u.name, u.pin_hash FROM users u JOIN tenants t ON t.id = $1
    WHERE u.active AND u.pin_hash IS NOT NULL AND (
      (u.role = 'network' AND u.network_id = t.network_id AND (u.network_access = 'owner' OR t.id = ANY(u.network_unit_ids)))
      OR (u.role = 'owner' AND u.tenant_id = t.id))`, [tenantId]);
  for (const u of r.rows) if (await bcrypt.compare(String(pin), u.pin_hash)) return { id: u.id, name: u.name };
  return null;
}

export function registerKiosk(app, { q, auth, roles, route, bad, valid, audit, uuid, rateLimit, bcrypt, secret }) {
  const limiter = (limit, windowMs = 900000) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false });
  const networkForHost = async req => {
    const host = String(req.hostname || '').toLowerCase();
    if (!host || OWN_HOSTS.has(host) || host.endsWith('.onrender.com') || /^[\d.]+$|^\[|^localhost$/.test(host)) return null;
    return (await q("SELECT id, name FROM store_networks WHERE hostname = $1 AND status = 'active'", [host])).rows[0] || null;
  };
  const unitsOf = networkId => q(`SELECT t.id, coalesce(t.unit_label, t.name) label,
      coalesce((SELECT json_agg(u.name ORDER BY lower(u.name)) FROM users u WHERE u.tenant_id = t.id AND u.active AND u.login_kind = 'pin'), '[]') sellers
    FROM tenants t WHERE t.network_id = $1 AND t.status IN ('trial', 'active') ORDER BY lower(coalesce(t.unit_label, t.name))`, [networkId]);

  // Tela "Entrar na unidade": unidades da rede deste endereço, com o primeiro nome das vendedoras.
  app.get('/api/public/units', limiter(120, 60000), route(async (req, res) => {
    const net = await networkForHost(req);
    if (!net) return res.set('Cache-Control', 'no-store').json({ network: false, units: [] });
    const r = await unitsOf(net.id);
    res.set('Cache-Control', 'no-store').json({ network: true, units: r.rows.map(u => ({ id: u.id, label: u.label, sellers: u.sellers.map(firstName) })) });
  }));

  // Abre a unidade: senha do quiosque → caixa; senha de dono/supervisor da rede → painel da rede.
  app.post('/api/auth/unit', limiter(15), route(async (req, res) => {
    const v = valid(z.object({ unit_id: uuid, password: z.string().min(1).max(200), device_proof: proofField }).strict(), req, res); if (!v) return;
    const unit = (await q("SELECT id, network_id, status, device_lock FROM tenants WHERE id = $1 AND network_id IS NOT NULL", [v.unit_id])).rows[0];
    const fail = () => bad(res, 401, 'Senha incorreta para esta unidade');
    if (!unit) return fail();
    const net = await networkForHost(req);
    if (net && net.id !== unit.network_id) return fail();
    const people = await q(`SELECT u.id, u.name, u.role, u.tenant_id, u.network_id, u.network_access, u.network_unit_ids, u.password_hash, u.login_kind
      FROM users u JOIN store_networks n ON n.id = $2 AND n.status = 'active'
      WHERE u.active AND ((u.login_kind = 'kiosk' AND u.tenant_id = $1) OR (u.role = 'network' AND u.network_id = $2 AND u.login_kind = 'email'))
      ORDER BY (u.login_kind = 'kiosk') DESC`, [unit.id, unit.network_id]);
    for (const u of people.rows) {
      if (!(await passwordMatches(v.password, u.password_hash))) continue;
      if (u.login_kind === 'kiosk') {
        if (!['trial', 'active'].includes(unit.status)) return bad(res, 403, 'Unidade bloqueada. Fale com a central.');
        // Rede travada: o caixa só abre no PC desta unidade (prova do agente Ficou Pronto).
        const g = await gateLogin(q, res, { locked: unit.device_lock, networkId: unit.network_id, unitId: unit.id, proof: v.device_proof, actorId: u.id }); if (!g.ok) return;
        const token = jwt.sign({ id: u.id, tenant_id: u.tenant_id, role: u.role, ...(g.dev ? { dev: g.dev } : {}) }, secret, { algorithm: 'HS256', expiresIn: '16h' });
        await q("INSERT INTO audit_events(tenant_id, actor_id, action, target_type, target_id) VALUES($1,$2,'kiosk_open','tenant',$3)", [unit.id, u.id, unit.id]);
        return res.json({ token, panel: '/caixa', user: { id: u.id, name: u.name, role: u.role, tenant_id: u.tenant_id, kiosk: true } });
      }
      // Supervisor só abre pelo quiosque das unidades que acompanha.
      if (u.network_access === 'supervisor' && !(u.network_unit_ids || []).includes(unit.id)) continue;
      // Gestão da rede pela tela da unidade: com a trava da gestão, precisa ser o PC desta unidade.
      const g = await gateLogin(q, res, { locked: await networkLocked(q, unit.network_id), networkId: unit.network_id, unitId: unit.id, proof: v.device_proof, actorId: u.id, tenantId: unit.id }); if (!g.ok) return;
      const token = jwt.sign({ id: u.id, tenant_id: null, network_id: u.network_id, role: 'network', ...(g.dev ? { dev: g.dev } : {}) }, secret, { algorithm: 'HS256', expiresIn: '8h' });
      return res.json({ token, panel: '/rede.html', user: { id: u.id, name: u.name, role: 'network', network_id: u.network_id } });
    }
    return fail();
  }));

  const staff = [auth, roles('owner', 'operator')];
  // Vendedoras da unidade (as que confirmam venda com PIN).
  app.get('/api/store/kiosk/sellers', ...staff, route(async (req, res) => {
    const r = await q("SELECT id, name FROM users WHERE tenant_id = $1 AND active AND login_kind = 'pin' ORDER BY lower(name)", [req.user.tenant_id]);
    const t = (await q('SELECT name, unit_label, pin_sales, network_id, depot FROM tenants WHERE id = $1', [req.user.tenant_id])).rows[0];
    res.set('Cache-Control', 'no-store').json({ sellers: r.rows, unit: { name: t.name, label: t.unit_label || t.name, pin_sales: t.pin_sales, network: !!t.network_id, depot: !!t.depot }, kiosk: !!req.user.kiosk });
  }));

  // Confere o PIN na hora em que a vendedora toca no nome (a venda confere de novo ao gravar).
  app.post('/api/store/kiosk/check-pin', ...staff, limiter(60, 300000), route(async (req, res) => {
    const v = valid(z.object({ seller_id: uuid, pin: PIN }).strict(), req, res); if (!v) return;
    const s = (await q("SELECT id, name FROM users WHERE id = $1 AND tenant_id = $2 AND active AND login_kind = 'pin'", [v.seller_id, req.user.tenant_id])).rows[0];
    if (!s || !(await pinOk({ query: q }, bcrypt, s.id, v.pin))) return bad(res, 401, 'PIN incorreto');
    res.json({ ok: true, id: s.id, name: s.name });
  }));

  // Meu dia (p. 11): as vendas da vendedora, o faturamento da loja, a meta e a comissão prevista.
  // Não mostra custo, lucro nem a comissão das colegas.
  app.post('/api/store/kiosk/my-day', ...staff, limiter(60, 300000), route(async (req, res) => {
    const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida');
    const v = valid(z.object({ seller_id: uuid, pin: PIN, from: ymd.optional(), to: ymd.optional() }).strict(), req, res); if (!v) return;
    const tz = 'America/Fortaleza', tenant = req.user.tenant_id;
    if (!!v.from !== !!v.to) return bad(res, 400, 'Escolha a data inicial e a final');
    const s = (await q("SELECT id, name, commission_percent FROM users WHERE id = $1 AND tenant_id = $2 AND active AND login_kind = 'pin'", [v.seller_id, tenant])).rows[0];
    if (!s || !(await pinOk({ query: q }, bcrypt, s.id, v.pin))) return bad(res, 401, 'PIN incorreto');
    const today = `(x.created_at AT TIME ZONE '${tz}')::date = (now() AT TIME ZONE '${tz}')::date`;
    const month = `x.created_at >= (date_trunc('month', now() AT TIME ZONE '${tz}') AT TIME ZONE '${tz}')`;
    const mine = await q(`SELECT to_char(x.created_at AT TIME ZONE '${tz}', 'HH24:MI') hora, c.name cliente, x.total_cents, x.payment_method, x.payments
      FROM sales x LEFT JOIN customers c ON c.id = x.customer_id WHERE x.tenant_id = $1 AND x.seller_id = $2 AND x.canceled_at IS NULL AND ${today}
      ORDER BY x.created_at DESC`, [tenant, s.id]);
    const store = (await q(`SELECT count(*)::int n, coalesce(sum(total_cents), 0)::bigint total FROM sales x WHERE x.tenant_id = $1 AND x.canceled_at IS NULL AND ${today}`, [tenant])).rows[0];
    const monthMine = (await q(`SELECT coalesce(sum(total_cents), 0)::bigint total FROM sales x WHERE x.tenant_id = $1 AND x.seller_id = $2 AND x.canceled_at IS NULL AND ${month}`, [tenant, s.id])).rows[0];
    const goal = (await q(`SELECT nullif(target_cents, 0) target FROM store_goals WHERE tenant_id = $1 AND user_id = $2 AND month <= date_trunc('month', now() AT TIME ZONE '${tz}')::date ORDER BY month DESC LIMIT 1`, [tenant, s.id])).rows[0];
    const monthTotal = Number(monthMine.total), tier = tierFor(await tiersForTenant({ query: q }, tenant), monthTotal), pct = tier ? tier.percent : Number(s.commission_percent || 0);
    // Período escolhido pela vendedora (só as vendas dela): até 1 ano, sem datas futuras.
    let period = null;
    if (v.from) {
      const chk = (await q(`SELECT $1::date <= $2::date ok, $2::date - $1::date <= 366 short, $2::date <= (now() AT TIME ZONE '${tz}')::date past`, [v.from, v.to]).catch(() => ({ rows: [{}] }))).rows[0];
      if (!chk.ok) return bad(res, 400, 'A data inicial precisa ser antes da final');
      if (!chk.short) return bad(res, 400, 'Escolha um período de até 1 ano');
      const where = `x.tenant_id = $1 AND x.seller_id = $2 AND x.canceled_at IS NULL AND (x.created_at AT TIME ZONE '${tz}')::date BETWEEN $3::date AND $4::date`;
      const tot = (await q(`SELECT count(*)::int n, coalesce(sum(total_cents), 0)::bigint total FROM sales x WHERE ${where}`, [tenant, s.id, v.from, v.to])).rows[0];
      const shop = (await q(`SELECT count(*)::int n, coalesce(sum(total_cents), 0)::bigint total FROM sales x WHERE x.tenant_id = $1 AND x.canceled_at IS NULL
        AND (x.created_at AT TIME ZONE '${tz}')::date BETWEEN $2::date AND $3::date`, [tenant, v.from, v.to])).rows[0];
      const days = await q(`SELECT to_char((x.created_at AT TIME ZONE '${tz}')::date, 'YYYY-MM-DD') dia, count(*)::int n, sum(total_cents)::bigint total
        FROM sales x WHERE ${where} GROUP BY 1 ORDER BY 1 DESC`, [tenant, s.id, v.from, v.to]);
      const list = await q(`SELECT to_char(x.created_at AT TIME ZONE '${tz}', 'DD/MM HH24:MI') quando, c.name cliente, x.total_cents, x.payment_method
        FROM sales x LEFT JOIN customers c ON c.id = x.customer_id WHERE ${where} ORDER BY x.created_at DESC LIMIT 200`, [tenant, s.id, v.from, v.to]);
      period = { from: v.from, to: v.to, total_cents: Number(tot.total), count: tot.n, store: { total_cents: Number(shop.total), count: shop.n },
        days: days.rows.map(d => ({ day: d.dia, count: d.n, total_cents: Number(d.total) })), sales: list.rows, truncated: tot.n > list.rowCount };
    }
    res.set('Cache-Control', 'no-store').json({
      seller: { id: s.id, name: s.name }, period,
      today: { total_cents: mine.rows.reduce((a, x) => a + x.total_cents, 0), count: mine.rows.length, sales: mine.rows },
      store_today: { total_cents: Number(store.total), count: store.n },
      month: { total_cents: monthTotal, goal_cents: goal?.target ?? null, goal_percent: goal?.target ? Math.round(monthTotal * 100 / goal.target) : null },
      commission: { percent: pct, estimated_cents: Math.round(monthTotal * pct / 100), tiered: !!tier, next: tier?.next || null }
    });
  }));

  // Central: senha do computador do quiosque (cria o acesso da unidade na primeira vez). Mostrada uma vez.
  app.post('/api/master/tenants/:id/kiosk-password', auth, roles('master'), route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ password: z.string().min(8).max(200).optional() }).strict(), req, res); if (!v) return;
    const t = (await q('SELECT id, name, unit_label, network_id FROM tenants WHERE id = $1', [req.params.id])).rows[0];
    if (!t) return bad(res, 404, 'Loja não encontrada');
    if (!t.network_id) return bad(res, 400, 'Ligue a loja a uma rede antes de criar o acesso do quiosque');
    const password = v.password || ('Un-' + crypto.randomBytes(6).toString('base64url'));
    const hash = await bcrypt.hash(password, 12);
    const up = await q("UPDATE users SET password_hash = $2, password_changed_at = now(), active = true WHERE tenant_id = $1 AND login_kind = 'kiosk' RETURNING id", [t.id, hash]);
    if (!up.rowCount) await q(`INSERT INTO users(tenant_id, name, email, password_hash, role, access_level, login_kind)
      VALUES($1, $2, $3, $4, 'operator', 'full', 'kiosk')`, [t.id, 'Caixa do quiosque ' + (t.unit_label || t.name), 'quiosque+' + t.id + '@kiosk.invalid', hash]);
    await audit(req, 'set_kiosk_password', 'tenant', t.id, t.id);
    res.json({ unit: t.unit_label || t.name, password });
  }));
}
