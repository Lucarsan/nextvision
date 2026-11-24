// Painel da loja (proposta p. 12) para supervisor e gestão: números do dia da unidade, cada venda com
// hora, vendedora, cliente, forma e cupom, fechamento por forma de pagamento com conferência do supervisor,
// e pendências (garantias perto do prazo, transferências, pagamentos a conciliar, fechamentos sem conferência).
import { z } from 'zod';

const TZ = 'America/Fortaleza';
const METHODS = ['cash', 'pix', 'debit', 'credit', 'other'];

export function registerUnitPanel(app, { q, auth, roles, route, bad, valid, audit, uuid }) {
  const network = [auth, roles('network')];
  const unitOf = async (req, id) => {
    if (!uuid.safeParse(id).success) return null;
    if (req.user.network_access === 'supervisor' && !(req.user.network_unit_ids || []).includes(id)) return null;
    return (await q(`SELECT t.id, coalesce(t.unit_label,t.name) name,
        (SELECT nullif(g.target_cents, 0) FROM store_goals g WHERE g.tenant_id = t.id AND g.user_id IS NULL AND g.month <= date_trunc('month', (now() AT TIME ZONE '${TZ}'))::date ORDER BY g.month DESC LIMIT 1) goal_cents
      FROM tenants t WHERE t.id=$1 AND t.network_id=$2`, [id, req.user.network_id])).rows[0] || null;
  };

  app.get('/api/network/units/:id/day', ...network, route(async (req, res) => {
    const u = await unitOf(req, req.params.id); if (!u) return bad(res, 404, 'Unidade não encontrada');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    const d = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;
    const sales = (await q(`SELECT s.id, s.sale_number, to_char(s.created_at AT TIME ZONE $3,'HH24:MI') at, s.total_cents, s.discount_cents, s.cashback_used_cents,
        s.payment_method, s.payments, s.canceled_at IS NOT NULL canceled, s.cancel_reason, s.offline_payment, s.econf_done_at IS NOT NULL econf_done,
        coalesce(sl.name, cr.name) seller, c.name customer,
        (SELECT f.status FROM fiscal_documents f WHERE f.sale_id=s.id ORDER BY f.created_at DESC LIMIT 1) fiscal_status
      FROM sales s LEFT JOIN users sl ON sl.id=s.seller_id LEFT JOIN users cr ON cr.id=s.created_by LEFT JOIN customers c ON c.id=s.customer_id
      WHERE s.tenant_id=$1 AND (s.created_at AT TIME ZONE $3)::date = $2::date ORDER BY s.created_at DESC`, [u.id, d, TZ])).rows;
    const ok = sales.filter(s => !s.canceled), byMethod = Object.fromEntries(METHODS.map(m => [m, 0]));
    for (const s of ok) { const ps = s.payment_method === 'mixed' && Array.isArray(s.payments) ? s.payments : [{ method: s.payment_method, amount_cents: s.total_cents }]; for (const p of ps) byMethod[p.method] = (byMethod[p.method] || 0) + p.amount_cents; }
    const bySeller = {}; for (const s of ok) { const k = s.seller || '—'; bySeller[k] = bySeller[k] || { seller: k, count: 0, total_cents: 0 }; bySeller[k].count++; bySeller[k].total_cents += s.total_cents; }
    const month = (await q(`SELECT coalesce(sum(total_cents),0)::bigint t FROM sales WHERE tenant_id=$1 AND canceled_at IS NULL AND to_char(created_at AT TIME ZONE $3,'YYYY-MM') = to_char($2::date,'YYYY-MM')`, [u.id, d, TZ])).rows[0].t;
    const sessions = (await q(`SELECT cs.id, cs.status, to_char(cs.opened_at AT TIME ZONE $3,'DD/MM HH24:MI') opened_at, to_char(cs.closed_at AT TIME ZONE $3,'DD/MM HH24:MI') closed_at,
        cs.opening_cents, cs.expected_cash_cents, cs.counted_cash_cents, cs.close_note, ob.name opened_by, cb.name closed_by, rv.name reviewed_by,
        to_char(cs.reviewed_at AT TIME ZONE $3,'DD/MM HH24:MI') reviewed_at, cs.review_note,
        (SELECT coalesce(json_agg(json_build_object('kind',m.kind,'amount_cents',m.amount_cents,'note',m.note,'by',mu.name) ORDER BY m.created_at),'[]') FROM cash_movements m LEFT JOIN users mu ON mu.id=m.created_by WHERE m.session_id=cs.id) movements
      FROM cash_sessions cs LEFT JOIN users ob ON ob.id=cs.opened_by LEFT JOIN users cb ON cb.id=cs.closed_by LEFT JOIN users rv ON rv.id=cs.reviewed_by
      WHERE cs.tenant_id=$1 AND ((cs.opened_at AT TIME ZONE $3)::date = $2::date OR (cs.closed_at AT TIME ZONE $3)::date = $2::date OR cs.status='open'
        OR (cs.status='closed' AND cs.reviewed_at IS NULL AND cs.closed_at > now() - interval '15 days'))
      ORDER BY cs.opened_at DESC`, [u.id, d, TZ])).rows;
    const pending = {
      warranty: (await q(`SELECT w.id, w.kind, to_char(w.due_on,'YYYY-MM-DD') due_on, s.receipt_code FROM warranty_claims w JOIN sales s ON s.id=w.sale_id WHERE w.tenant_id=$1 AND w.closed_at IS NULL AND w.due_on <= ($2::date + 7) ORDER BY w.due_on`, [u.id, d])).rows,
      transfers: (await q(`SELECT x.number, x.status FROM stock_transfers x WHERE (x.to_tenant=$1 OR x.from_tenant=$1) AND (x.status='divergent' OR (x.status='sent' AND x.sent_at < now() - interval '2 days'))`, [u.id])).rows,
      econf: (await q(`SELECT sale_number FROM sales WHERE tenant_id=$1 AND offline_payment AND econf_done_at IS NULL AND canceled_at IS NULL ORDER BY created_at`, [u.id])).rows.map(r => r.sale_number),
      unreviewed: sessions.filter(s => s.status === 'closed' && !s.reviewed_at).length,
    };
    const total = ok.reduce((a, s) => a + s.total_cents, 0);
    res.set('Cache-Control', 'no-store').json({ unit: u, date: d, kpis: { total_cents: total, count: ok.length, ticket_cents: ok.length ? Math.round(total / ok.length) : 0, canceled: sales.length - ok.length, month_cents: Number(month), goal_cents: u.goal_cents ? Number(u.goal_cents) : null },
      by_method: byMethod, by_seller: Object.values(bySeller).sort((a, b) => b.total_cents - a.total_cents), sales, sessions, pending });
  }));

  // Supervisor ou dono confere o fechamento.
  app.post('/api/network/cash-sessions/:id/review', ...network, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ note: z.string().trim().max(300).default('') }).strict(), req, res); if (!v) return;
    const s = (await q('SELECT cs.id, cs.tenant_id, cs.status, cs.reviewed_at FROM cash_sessions cs JOIN tenants t ON t.id=cs.tenant_id WHERE cs.id=$1 AND t.network_id=$2', [req.params.id, req.user.network_id])).rows[0];
    if (!s || (req.user.network_access === 'supervisor' && !(req.user.network_unit_ids || []).includes(s.tenant_id))) return bad(res, 404, 'Caixa não encontrado');
    if (s.status !== 'closed') return bad(res, 409, 'O caixa ainda está aberto');
    if (s.reviewed_at) return bad(res, 409, 'Fechamento já conferido');
    await q('UPDATE cash_sessions SET reviewed_by=$2, reviewed_at=now(), review_note=$3 WHERE id=$1', [s.id, req.user.id, v.note || null]);
    await audit(req, 'review', 'cash_session', s.id, s.tenant_id);
    res.json({ ok: true });
  }));
}
