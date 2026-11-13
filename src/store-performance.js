// Metas e comissões (dono define; equipe acompanha).
// - Meta do mês: valor de SERVIÇOS vendidos (itens de serviço das vendas não canceladas, já com desconto e
//   cashback usado). Da loja (user_id nulo) e, se quiser, de cada pessoa. A meta vale para os meses
//   seguintes até ser trocada (busca a última definida até o mês pedido).
// - Comissão por login (quem aparece como vendedor da venda): percentual sobre os adicionais, os serviços
//   ou o total vendido. "Adicional" é o que estava marcado no cadastro do serviço na hora da venda.
// - Banhos: itens de serviço com "banho" no nome.
// - A página mostra quanto a loja fatura: ver ou mudar pede a senha do admin (a mesma do "Valor do estoque"),
//   para não ficar aberta para a atendente.
import { z } from 'zod';
import { requireAdmin } from './store-admin.js';

const TZ = process.env.STORE_TIMEZONE || 'America/Fortaleza';
const monthField = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);

export function registerStorePerformance(app, { q, route, bad, valid, audit, guard, owner, tid, uuid }) {
  const tz = TZ.replace(/'/g, '');
  const monthOf = req => {
    const m = req.query.month ? monthField.safeParse(String(req.query.month)) : { success: true, data: thisMonth() };
    return m.success ? m.data : null;
  };

  app.get('/api/store/sales/performance', ...guard, requireAdmin, route(async (req, res) => {
    const month = monthOf(req); if (!month) return bad(res, 400, 'Mês inválido');
    const first = month + '-01';
    const people = (await q(`WITH s AS (
        SELECT x.id,x.seller_id,x.total_cents FROM sales x
        WHERE x.tenant_id=$1 AND x.canceled_at IS NULL AND date_trunc('month', x.created_at AT TIME ZONE '${tz}')=$2::date),
      i AS (SELECT s.seller_id,
          coalesce(sum(it.total_cents) FILTER (WHERE it.service),0)::bigint services_cents,
          coalesce(sum(it.total_cents) FILTER (WHERE it.service AND it.addon),0)::bigint addons_cents,
          count(*) FILTER (WHERE it.service AND it.addon)::int addons,
          count(*) FILTER (WHERE it.service AND lower(it.name) LIKE '%banho%')::int baths,
          count(*) FILTER (WHERE it.service)::int services
        FROM s JOIN sale_items it ON it.sale_id=s.id GROUP BY s.seller_id),
      t AS (SELECT seller_id,sum(total_cents)::bigint total_cents,count(*)::int sales FROM s GROUP BY seller_id)
      SELECT u.id user_id,u.name,u.role,u.active,u.commission_percent,u.commission_base,
        coalesce(t.total_cents,0)::bigint total_cents,coalesce(t.sales,0) sales,
        coalesce(i.services_cents,0)::bigint services_cents,coalesce(i.addons_cents,0)::bigint addons_cents,
        coalesce(i.addons,0) addons,coalesce(i.baths,0) baths,coalesce(i.services,0) services,
        (SELECT g.target_cents FROM store_goals g WHERE g.tenant_id=$1 AND g.user_id=u.id AND g.month<=$2::date ORDER BY g.month DESC LIMIT 1) goal_cents_raw
      FROM users u LEFT JOIN t ON t.seller_id=u.id LEFT JOIN i ON i.seller_id=u.id
      WHERE u.tenant_id=$1 AND u.role IN ('owner','operator') AND (u.active OR t.sales>0)
      ORDER BY coalesce(i.services_cents,0) DESC,lower(u.name)`, [tid(req), first])).rows;
    const goal = (await q(`SELECT target_cents,to_char(month,'YYYY-MM') since FROM store_goals WHERE tenant_id=$1 AND user_id IS NULL AND month<=$2::date ORDER BY month DESC LIMIT 1`, [tid(req), first])).rows[0] || null;
    const base = p => p.commission_base === 'all' ? Number(p.total_cents) : p.commission_base === 'services' ? Number(p.services_cents) : Number(p.addons_cents);
    const rows = people.map(p => ({ ...p, total_cents: Number(p.total_cents), services_cents: Number(p.services_cents), addons_cents: Number(p.addons_cents),
      goal_cents: p.goal_cents_raw || null, goal_cents_raw: undefined, commission_percent: Number(p.commission_percent), commission_cents: Math.round(base(p) * Number(p.commission_percent) / 100) }));
    const sum = k => rows.reduce((a, r) => a + r[k], 0);
    // Dias que faltam no mês (contando hoje), para o "por dia" da meta.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    const [y, m] = month.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const daysLeft = month === today.slice(0, 7) ? last - Number(today.slice(8, 10)) + 1 : month > today.slice(0, 7) ? last : 0;
    const isOwner = req.user.role === 'owner';
    res.set('Cache-Control', 'no-store');
    res.json({
      month, days_left: daysLeft, is_owner: isOwner,
      store: { goal_cents: goal?.target_cents || null, goal_since: goal?.target_cents ? goal.since : null, services_cents: sum('services_cents'), addons_cents: sum('addons_cents'),
        total_cents: sum('total_cents'), baths: sum('baths'), addons: sum('addons'), services: sum('services') },
      // Operador vê a meta da loja e a própria linha; o dono vê todos.
      people: isOwner ? rows : rows.filter(r => r.user_id === req.user.id)
    });
  }));

  // Meta do mês (da loja ou de uma pessoa). target_cents nulo = tira a meta a partir deste mês.
  app.put('/api/store/sales/goals', ...owner, requireAdmin, route(async (req, res) => {
    const v = valid(z.object({ month: monthField, user_id: uuid.nullable().optional(), target_cents: z.number().int().min(1).max(1000000000).nullable() }).strict(), req, res); if (!v) return;
    const userId = v.user_id || null;
    if (userId && !(await q("SELECT 1 FROM users WHERE id=$1 AND tenant_id=$2 AND role IN ('owner','operator')", [userId, tid(req)])).rowCount) return bad(res, 400, 'Pessoa inválida');
    // Sem meta (null) grava 0 neste mês: a meta anterior deixa de valer daqui para frente.
    const target = v.target_cents ?? 0;
    const up = await q('UPDATE store_goals SET target_cents=$4,updated_at=now() WHERE tenant_id=$1 AND month=$2::date AND user_id IS NOT DISTINCT FROM $3::uuid', [tid(req), v.month + '-01', userId, target]);
    if (!up.rowCount) await q('INSERT INTO store_goals(tenant_id,month,user_id,target_cents) VALUES($1,$2::date,$3,$4)', [tid(req), v.month + '-01', userId, target]);
    await audit(req, 'update', 'store_goal', userId || tid(req));
    res.json({ ok: true });
  }));

  // Comissão de uma pessoa: percentual e sobre o quê (adicionais, serviços ou tudo).
  app.patch('/api/store/sales/commission/:id', ...owner, requireAdmin, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Pessoa inválida');
    const v = valid(z.object({ commission_percent: z.number().min(0).max(100).multipleOf(0.01), commission_base: z.enum(['addons', 'services', 'all']) }).strict(), req, res); if (!v) return;
    const r = await q(`UPDATE users SET commission_percent=$3,commission_base=$4 WHERE id=$1 AND tenant_id=$2 AND role IN ('owner','operator') RETURNING id,name,commission_percent,commission_base`,
      [req.params.id, tid(req), v.commission_percent, v.commission_base]);
    if (!r.rowCount) return bad(res, 404, 'Pessoa não encontrada');
    await audit(req, 'update', 'user_commission', req.params.id);
    res.json({ ...r.rows[0], commission_percent: Number(r.rows[0].commission_percent) });
  }));
}
