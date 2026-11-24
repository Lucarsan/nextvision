// Metas do mês pelo painel da rede: da rede toda, de cada unidade e de cada vendedora.
// Vale a meta do mês ou, sem meta nova, a do mês anterior (Anexo II). 0 = sem meta.
import { z } from 'zod';

const TZ = 'America/Fortaleza';

export function registerNetworkGoals(app, { q, auth, roles, route, bad, valid, audit }) {
  const network = [auth, roles('network')];
  const monthOk = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
  const scope = req => req.user.network_access === 'supervisor' ? (req.user.network_unit_ids || []) : null;

  app.get('/api/network/goals', ...network, route(async (req, res) => {
    const month = monthOk(req.query.month) ? req.query.month : new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()).slice(0, 7);
    const first = month + '-01';
    const net = (await q(`SELECT target_cents, to_char(month,'YYYY-MM') since FROM network_goals WHERE network_id=$1 AND month <= $2::date ORDER BY month DESC LIMIT 1`, [req.user.network_id, first])).rows[0];
    const units = (await q(`SELECT t.id, coalesce(t.unit_label,t.name) name,
        (SELECT g.target_cents FROM store_goals g WHERE g.tenant_id=t.id AND g.user_id IS NULL AND g.month <= $2::date ORDER BY g.month DESC LIMIT 1) goal_cents,
        (SELECT coalesce(sum(s.total_cents),0)::bigint FROM sales s WHERE s.tenant_id=t.id AND s.canceled_at IS NULL AND to_char(s.created_at AT TIME ZONE '${TZ}','YYYY-MM') = $3) sold_cents,
        (SELECT coalesce(json_agg(json_build_object('id',u.id,'name',u.name,
            'goal_cents',(SELECT g.target_cents FROM store_goals g WHERE g.tenant_id=t.id AND g.user_id=u.id AND g.month <= $2::date ORDER BY g.month DESC LIMIT 1),
            'sold_cents',(SELECT coalesce(sum(s.total_cents),0) FROM sales s WHERE s.tenant_id=t.id AND s.seller_id=u.id AND s.canceled_at IS NULL AND to_char(s.created_at AT TIME ZONE '${TZ}','YYYY-MM') = $3)) ORDER BY u.name),'[]')
          FROM users u WHERE u.tenant_id=t.id AND u.active AND u.login_kind='pin') sellers
      FROM tenants t WHERE t.network_id=$1 AND NOT t.depot AND ($4::uuid[] IS NULL OR t.id = ANY($4)) ORDER BY lower(coalesce(t.unit_label,t.name))`, [req.user.network_id, first, month, scope(req)])).rows;
    const sold = units.reduce((a, u) => a + Number(u.sold_cents), 0);
    res.set('Cache-Control', 'no-store').json({ month, can_edit_network: req.user.network_access !== 'supervisor',
      network: { goal_cents: net?.target_cents || null, since: net?.since || null, sold_cents: sold, units_goal_sum_cents: units.reduce((a, u) => a + (u.goal_cents || 0), 0) },
      units: units.map(u => ({ ...u, goal_cents: u.goal_cents || null, sold_cents: Number(u.sold_cents), sellers: u.sellers.map(s => ({ ...s, goal_cents: s.goal_cents || null, sold_cents: Number(s.sold_cents) })) })) });
  }));

  // Salva as metas do mês (vale para os meses seguintes até mudar). Supervisor: só as unidades dele, sem a meta da rede.
  const cents = z.number().int().min(0).max(2000000000).nullable();
  app.put('/api/network/goals', ...network, route(async (req, res) => {
    const v = valid(z.object({ month: z.string().refine(monthOk, 'Mês inválido'), network_cents: cents.optional(),
      units: z.array(z.object({ id: z.string().uuid(), goal_cents: cents })).max(200).default([]),
      sellers: z.array(z.object({ id: z.string().uuid(), goal_cents: cents })).max(2000).default([]) }).strict(), req, res); if (!v) return;
    const sc = scope(req), first = v.month + '-01';
    if (v.network_cents !== undefined && sc) return bad(res, 403, 'Só o dono define a meta da rede');
    const allowed = new Set((await q('SELECT id FROM tenants WHERE network_id=$1 AND ($2::uuid[] IS NULL OR id = ANY($2))', [req.user.network_id, sc])).rows.map(r => r.id));
    if (v.units.some(u => !allowed.has(u.id))) return bad(res, 403, 'Unidade fora do seu alcance');
    const sellers = v.sellers.length ? (await q("SELECT id, tenant_id FROM users WHERE id = ANY($1::uuid[]) AND login_kind='pin'", [v.sellers.map(s => s.id)])).rows : [];
    const sellerUnit = new Map(sellers.map(s => [s.id, s.tenant_id]));
    if (v.sellers.some(s => !allowed.has(sellerUnit.get(s.id)))) return bad(res, 403, 'Vendedora fora do seu alcance');
    const put = (tenant, user, target) => q(`INSERT INTO store_goals(tenant_id, month, user_id, target_cents) VALUES($1,$2::date,$3,$4)
      ON CONFLICT (tenant_id, month, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET target_cents=EXCLUDED.target_cents, updated_at=now()`, [tenant, first, user, target ?? 0]);
    for (const u of v.units) await put(u.id, null, u.goal_cents);
    for (const s of v.sellers) await put(sellerUnit.get(s.id), s.id, s.goal_cents);
    if (v.network_cents !== undefined) await q(`INSERT INTO network_goals(network_id, month, target_cents, updated_by) VALUES($1,$2::date,$3,$4)
      ON CONFLICT (network_id, month) DO UPDATE SET target_cents=EXCLUDED.target_cents, updated_by=EXCLUDED.updated_by, updated_at=now()`, [req.user.network_id, first, v.network_cents ?? 0, req.user.id]);
    await audit(req, 'update', 'network_goals', req.user.network_id);
    res.json({ ok: true });
  }));
}
