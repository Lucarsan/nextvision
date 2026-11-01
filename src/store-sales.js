// Caixa diário, vendas ligadas a clientes, fidelidade por venda e mensagens do dia.
// - Ligado por loja pela central (tenants.sales_enabled).
// - Cada venda fica num caixa aberto; ao fechar, o sistema calcula o dinheiro esperado.
// - Venda com cliente soma no mesmo cartão fidelidade dos pedidos concluídos.
// - O envio é feito pelo próprio WhatsApp da loja (link wa.me); aqui só registramos
//   quem já recebeu, para a lista do dia mostrar o que falta enviar.
import crypto from 'node:crypto';
import { z } from 'zod';

const TZ = process.env.STORE_TIMEZONE || 'America/Fortaleza';
const cents = z.number().int().min(0).max(100000000);
const dayField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const phoneDigits = v => String(v || '').replace(/\D/g, '');

export function registerStoreSales(app, { q, db, auth, roles, route, bad, valid, audit, uuid }) {
  const tid = req => req.user.tenant_id;
  const staff = [auth, roles('owner', 'operator')];
  const enabled = route(async (req, res, next) => {
    const r = await q('SELECT sales_enabled FROM tenants WHERE id=$1', [tid(req)]);
    if (!r.rows[0]?.sales_enabled) return bad(res, 403, 'Caixa e mensagens não estão habilitados para esta loja');
    next();
  });
  const guard = [...staff, enabled];
  const owner = [auth, roles('owner'), enabled];
  // Operador novato (access_level 'basic') não cancela venda, não lança saídas/sangria/suprimento,
  // não fecha o caixa e não dá desconto nem muda preço.
  const fullOnly = (req, res, next) => req.user.access_level === 'basic' ? bad(res, 403, 'Seu acesso (operador novato) não permite esta ação. Peça a um operador livre ou ao dono.') : next();
  const full = [...guard, fullOnly];

  // Progresso do cartão: compras ainda não usadas em prêmio, meta e prêmio atuais.
  const progressSql = `SELECT c.id customer_id,
      (SELECT count(*)::int FROM loyalty_checkins l WHERE l.tenant_id=c.tenant_id AND l.customer_id=c.id AND l.redemption_id IS NULL) checkins,
      t.loyalty_enabled,t.loyalty_target,t.loyalty_reward
    FROM customers c JOIN tenants t ON t.id=c.tenant_id WHERE c.tenant_id=$1 AND c.id=ANY($2::uuid[])`;
  const shape = p => p && ({
    enabled: p.loyalty_enabled, checkins: p.checkins, target: p.loyalty_target, reward: p.loyalty_reward,
    remaining: Math.max(0, p.loyalty_target - p.checkins), complete: p.loyalty_enabled && p.checkins >= p.loyalty_target
  });
  async function progressFor(tenant, ids, client = { query: q }) {
    if (!ids.length) return new Map();
    const r = await client.query(progressSql, [tenant, ids]);
    return new Map(r.rows.map(p => [p.customer_id, shape(p)]));
  }

  // ---------- Cashback ----------
  // Saldo = lotes não estornados, com sobra e ainda dentro da validade (último dia válido = expires_on, no fuso da loja).
  // Datas saem como texto 'AAAA-MM-DD' para não mudarem de dia ao virar JSON.
  const CB_ACTIVE = `reversed_at IS NULL AND remaining_cents>0 AND expires_on>=(now() AT TIME ZONE '${TZ.replace(/'/g, '')}')::date`;
  const CB_CONFIG = 'cashback_enabled,cashback_percent,cashback_max_use_percent,cashback_valid_days,cashback_min_sale_cents,cashback_rules,cashback_reminder_message';
  const cbShape = r => ({ balance_cents: r?.balance_cents || 0, next_expires_on: r?.next_on || null, next_expiring_cents: r?.next_cents || 0 });
  async function cashbackFor(tenant, ids, client = { query: q }) {
    if (!ids.length) return new Map();
    const r = await client.query(`WITH l AS (SELECT customer_id,remaining_cents,expires_on FROM cashback_lots WHERE tenant_id=$1 AND customer_id=ANY($2::uuid[]) AND ${CB_ACTIVE}),
        n AS (SELECT customer_id,min(expires_on) next_on FROM l GROUP BY 1)
      SELECT l.customer_id,sum(l.remaining_cents)::int balance_cents,to_char(n.next_on,'YYYY-MM-DD') next_on,
        (sum(l.remaining_cents) FILTER (WHERE l.expires_on=n.next_on))::int next_cents
      FROM l JOIN n USING (customer_id) GROUP BY l.customer_id,n.next_on`, [tenant, ids]);
    const by = new Map(r.rows.map(x => [x.customer_id, x]));
    return new Map(ids.map(id => [id, cbShape(by.get(id))]));
  }
  // Percentual guardado como numeric(5,2): calcula em centésimos de ponto para não errar por arredondamento de ponto flutuante.
  const cbEarn = (paid, percent) => Math.floor(paid * Math.round(Number(percent) * 100) / 10000);
  const cbAllowed = (total, balance, maxPercent) => Math.max(0, Math.min(balance, Math.floor(total * maxPercent / 100), total - 1));
  const money = c => 'R$ ' + (c / 100).toFixed(2).replace('.', ',');
  // Distribui um abatimento entre os itens, proporcional ao valor de cada um, sem deixar item negativo.
  function spread(items, amount) {
    const base = items.reduce((a, x) => a + x.total_cents, 0); let left = amount;
    if (!amount || !base) return;
    items.forEach((x, i) => { const cut = Math.min(left, x.total_cents, i === items.length - 1 ? left : Math.round(amount * x.total_cents / base)); x.total_cents -= cut; left -= cut; });
    for (const x of items) { if (!left) break; const cut = Math.min(left, x.total_cents); x.total_cents -= cut; left -= cut; }
  }

  async function cashSummary(tenant, sessionId, client = { query: q }) {
    const totals = await client.query(`SELECT payment_method,count(*)::int n,coalesce(sum(total_cents),0)::bigint total
      FROM sales WHERE session_id=$1 AND tenant_id=$2 AND canceled_at IS NULL GROUP BY payment_method`, [sessionId, tenant]);
    const moves = await client.query(`SELECT kind,method,count(*)::int n,coalesce(sum(amount_cents),0)::bigint total FROM cash_movements
      WHERE session_id=$1 AND tenant_id=$2 AND canceled_at IS NULL GROUP BY kind,method`, [sessionId, tenant]);
    const s = await client.query('SELECT opening_cents FROM cash_sessions WHERE id=$1', [sessionId]);
    const cb = (await client.query(`SELECT coalesce(sum(cashback_used_cents),0)::bigint used,coalesce(sum(cashback_earned_cents),0)::bigint earned
      FROM sales WHERE session_id=$1 AND tenant_id=$2 AND canceled_at IS NULL`, [sessionId, tenant])).rows[0];
    const by = Object.fromEntries(totals.rows.map(r => [r.payment_method, { count: r.n, total_cents: Number(r.total) }]));
    const sum = kind => moves.rows.filter(r => r.kind === kind).reduce((a, r) => a + Number(r.total), 0);
    const expensesBy = Object.fromEntries(moves.rows.filter(r => r.kind === 'expense').map(r => [r.method, { count: r.n, total_cents: Number(r.total) }]));
    const opening = s.rows[0]?.opening_cents || 0;
    const salesTotal = totals.rows.reduce((a, r) => a + Number(r.total), 0);
    const expenses = sum('expense');
    return {
      by_method: by,
      sales_count: totals.rows.reduce((a, r) => a + r.n, 0),
      sales_total_cents: salesTotal,
      expenses_by_method: expensesBy,
      expenses_count: moves.rows.filter(r => r.kind === 'expense').reduce((a, r) => a + r.n, 0),
      expenses_total_cents: expenses,
      balance_cents: salesTotal - expenses,
      opening_cents: opening, deposits_cents: sum('deposit'), withdrawals_cents: sum('withdrawal'),
      cashback_used_cents: Number(cb.used), cashback_earned_cents: Number(cb.earned),
      expected_cash_cents: opening + (by.cash?.total_cents || 0) + sum('deposit') - sum('withdrawal') - (expensesBy.cash?.total_cents || 0)
    };
  }

  async function sessionDetail(tenant, sessionId) {
    const sales = await q(`SELECT x.id,x.sale_number,x.total_cents,x.cashback_used_cents,x.cashback_earned_cents,x.payment_method,x.description,x.created_at,x.canceled_at,x.cancel_reason,
        x.customer_id,c.name customer_name,c.phone customer_phone,o.order_number,u.name created_by_name,uc.name canceled_by_name,COALESCE(sl.name,u.name) seller_name,
        COALESCE((SELECT json_agg(json_build_object('name',i.name || COALESCE(' ' || i.variant_name,''),'barcode',i.barcode,'quantity',i.quantity,'unit_price_cents',i.unit_price_cents,'total_cents',i.total_cents,
            'service',i.service,'device_model',i.device_model,'supplier_name',i.supplier_name,'unit_cost_cents',i.unit_cost_cents,'warranty_days',i.warranty_days) ORDER BY i.position)
          FROM sale_items i WHERE i.sale_id=x.id),'[]'::json) items
      FROM sales x LEFT JOIN customers c ON c.id=x.customer_id LEFT JOIN orders o ON o.id=x.order_id JOIN users u ON u.id=x.created_by LEFT JOIN users uc ON uc.id=x.canceled_by LEFT JOIN users sl ON sl.id=x.seller_id
      WHERE x.session_id=$1 AND x.tenant_id=$2 ORDER BY x.created_at DESC,x.sale_number DESC`, [sessionId, tenant]);
    const moves = await q(`SELECT m.id,m.kind,m.method,m.category,m.amount_cents,m.note,m.created_at,m.canceled_at,m.cancel_reason,u.name created_by_name,uc.name canceled_by_name
      FROM cash_movements m JOIN users u ON u.id=m.created_by LEFT JOIN users uc ON uc.id=m.canceled_by
      WHERE m.session_id=$1 AND m.tenant_id=$2 ORDER BY m.created_at DESC`, [sessionId, tenant]);
    // Vendas por vendedor (sem as canceladas).
    const bySeller = new Map();
    for (const x of sales.rows) if (!x.canceled_at) { const k = x.seller_name || '—'; const v = bySeller.get(k) || { name: k, count: 0, total_cents: 0 }; v.count++; v.total_cents += x.total_cents; bySeller.set(k, v); }
    const summary = await cashSummary(tenant, sessionId);
    summary.by_seller = [...bySeller.values()].sort((a, b) => b.total_cents - a.total_cents);
    return { sales: sales.rows, movements: moves.rows, summary };
  }

  // ---------- Configuração ----------
  app.get('/api/store/sales/config', ...staff, route(async (req, res) => {
    const r = await q(`SELECT sales_enabled,google_review_url,loyalty_enabled,loyalty_target,loyalty_reward,loyalty_rules,
      loyalty_min_sale_cents,status_message,offer_message,name,slug,${CB_CONFIG} FROM tenants WHERE id=$1`, [tid(req)]);
    const t = r.rows[0] || {};
    if (!t.sales_enabled) return res.json({ enabled: false });
    const { sales_enabled, ...rest } = t;
    res.json({ enabled: true, timezone: TZ, role: req.user.role, access_level: req.user.access_level, ...rest, cashback_percent: Number(rest.cashback_percent) });
  }));
  // Cashback: só o dono liga e define as regras (percentual, validade, limite de uso por compra, valor mínimo).
  app.patch('/api/store/sales/cashback', ...owner, route(async (req, res) => {
    const v = valid(z.object({
      cashback_enabled: z.boolean().optional(),
      cashback_percent: z.number().gt(0).max(50).multipleOf(0.01).optional(),
      cashback_max_use_percent: z.number().int().min(1).max(100).optional(),
      cashback_valid_days: z.number().int().min(7).max(730).optional(),
      cashback_min_sale_cents: cents.optional(),
      cashback_rules: z.string().trim().max(400).optional(),
      cashback_reminder_message: z.string().trim().max(1000).optional()
    }).strict(), req, res); if (!v) return;
    const keys = Object.keys(v); if (!keys.length) return bad(res, 400, 'Nada para salvar');
    const r = await q(`UPDATE tenants SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1} RETURNING ${CB_CONFIG}`, [...keys.map(k => v[k]), tid(req)]);
    await audit(req, 'update', 'cashback_settings', tid(req));
    res.json({ ...r.rows[0], cashback_percent: Number(r.rows[0].cashback_percent) });
  }));
  app.patch('/api/store/sales/config', ...owner, route(async (req, res) => {
    const v = valid(z.object({
      google_review_url: z.union([z.literal(''), z.string().trim().url().startsWith('https://').max(500)]).optional(),
      loyalty_rules: z.string().trim().max(600).optional(),
      loyalty_min_sale_cents: cents.optional(),
      status_message: z.string().trim().max(1000).optional(),
      offer_message: z.string().trim().max(1000).optional()
    }).strict(), req, res); if (!v) return;
    const r = await q(`UPDATE tenants SET google_review_url=CASE WHEN $1::text IS NULL THEN google_review_url ELSE NULLIF($1,'') END,
      loyalty_rules=COALESCE($2,loyalty_rules),loyalty_min_sale_cents=COALESCE($3,loyalty_min_sale_cents),
      status_message=COALESCE($4,status_message),offer_message=COALESCE($5,offer_message)
      WHERE id=$6 RETURNING google_review_url,loyalty_rules,loyalty_min_sale_cents,status_message,offer_message`,
      [v.google_review_url ?? null, v.loyalty_rules ?? null, v.loyalty_min_sale_cents ?? null, v.status_message ?? null, v.offer_message ?? null, tid(req)]);
    await audit(req, 'update', 'sales_settings', tid(req)); res.json(r.rows[0]);
  }));

  // ---------- Caixa ----------
  app.get('/api/store/cash', ...guard, route(async (req, res) => {
    const open = await q(`SELECT s.*,u.name opened_by_name FROM cash_sessions s JOIN users u ON u.id=s.opened_by WHERE s.tenant_id=$1 AND s.status='open'`, [tid(req)]);
    const last = await q(`SELECT s.id,s.opened_at,s.closed_at,s.opening_cents,s.expected_cash_cents,s.counted_cash_cents,s.close_note,u.name closed_by_name
      FROM cash_sessions s LEFT JOIN users u ON u.id=s.closed_by WHERE s.tenant_id=$1 AND s.status='closed' ORDER BY s.closed_at DESC LIMIT 1`, [tid(req)]);
    res.set('Cache-Control', 'no-store');
    if (!open.rowCount) return res.json({ session: null, last_closed: last.rows[0] || null });
    const s = open.rows[0];
    res.json({ session: s, ...(await sessionDetail(tid(req), s.id)), last_closed: last.rows[0] || null });
  }));

  app.post('/api/store/cash/open', ...guard, route(async (req, res) => {
    const v = valid(z.object({ opening_cents: cents.default(0) }).strict(), req, res); if (!v) return;
    try {
      const r = await q(`INSERT INTO cash_sessions(tenant_id,opening_cents,opened_by) VALUES($1,$2,$3) RETURNING *`, [tid(req), v.opening_cents, req.user.id]);
      await audit(req, 'open', 'cash_session', r.rows[0].id); res.status(201).json(r.rows[0]);
    } catch (e) { if (e.code === '23505') return bad(res, 409, 'O caixa já está aberto'); throw e; }
  }));

  app.post('/api/store/cash/movements', ...full, route(async (req, res) => {
    const v = valid(z.object({
      kind: z.enum(['withdrawal', 'deposit', 'expense']), amount_cents: cents.min(1),
      method: z.enum(['cash', 'pix', 'debit', 'credit', 'other']).default('cash'),
      category: z.string().trim().max(60).default(''), note: z.string().trim().max(200).default('')
    }).strict(), req, res); if (!v) return;
    if (v.kind !== 'expense' && v.method !== 'cash') return bad(res, 400, 'Sangria e suprimento são sempre em dinheiro');
    if (v.kind === 'expense' && !v.note && !v.category) return bad(res, 400, 'Informe a categoria ou a descrição da saída');
    const r = await q(`INSERT INTO cash_movements(tenant_id,session_id,kind,method,category,amount_cents,note,created_by)
      SELECT $1,s.id,$2,$3,$4,$5,$6,$7 FROM cash_sessions s WHERE s.tenant_id=$1 AND s.status='open' RETURNING *`,
      [tid(req), v.kind, v.method, v.category, v.amount_cents, v.note, req.user.id]);
    if (!r.rowCount) return bad(res, 409, 'Abra o caixa primeiro');
    await audit(req, v.kind, 'cash_movement', r.rows[0].id); res.status(201).json(r.rows[0]);
  }));

  app.post('/api/store/cash/movements/:id/cancel', ...full, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Lançamento inválido');
    const v = valid(z.object({ reason: z.string().trim().min(3).max(200) }).strict(), req, res); if (!v) return;
    const r = await q(`UPDATE cash_movements m SET canceled_at=now(),canceled_by=$1,cancel_reason=$2 FROM cash_sessions s
      WHERE m.id=$3 AND m.tenant_id=$4 AND m.canceled_at IS NULL AND s.id=m.session_id AND s.status='open' RETURNING m.id`, [req.user.id, v.reason, req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 409, 'Só é possível cancelar lançamentos do caixa aberto');
    await audit(req, 'cancel', 'cash_movement', req.params.id); res.json({ canceled: true });
  }));

  // Relatório do caixa (aberto ou fechado) para impressão.
  app.get('/api/store/cash/sessions/:id/report', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Caixa inválido');
    const s = await q(`SELECT s.*,uo.name opened_by_name,uc.name closed_by_name,t.name store_name,t.city,t.state
      FROM cash_sessions s JOIN users uo ON uo.id=s.opened_by LEFT JOIN users uc ON uc.id=s.closed_by JOIN tenants t ON t.id=s.tenant_id
      WHERE s.id=$1 AND s.tenant_id=$2`, [req.params.id, tid(req)]);
    if (!s.rowCount) return bad(res, 404, 'Caixa não encontrado');
    res.set('Cache-Control', 'no-store');
    res.json({ session: s.rows[0], ...(await sessionDetail(tid(req), req.params.id)), generated_at: new Date().toISOString(), timezone: TZ });
  }));

  app.post('/api/store/cash/close', ...full, route(async (req, res) => {
    const v = valid(z.object({ counted_cash_cents: cents, note: z.string().trim().max(400).default('') }).strict(), req, res); if (!v) return;
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const s = await c.query(`SELECT id FROM cash_sessions WHERE tenant_id=$1 AND status='open' FOR UPDATE`, [tid(req)]);
      if (!s.rowCount) { await c.query('ROLLBACK'); return bad(res, 409, 'Não há caixa aberto'); }
      const summary = await cashSummary(tid(req), s.rows[0].id, c);
      const r = await c.query(`UPDATE cash_sessions SET status='closed',closed_at=now(),closed_by=$1,expected_cash_cents=$2,counted_cash_cents=$3,close_note=$4
        WHERE id=$5 RETURNING *`, [req.user.id, summary.expected_cash_cents, v.counted_cash_cents, v.note || null, s.rows[0].id]);
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'close', 'cash_session', s.rows[0].id]);
      await c.query('COMMIT');
      res.json({ session: r.rows[0], summary, difference_cents: v.counted_cash_cents - summary.expected_cash_cents });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  app.get('/api/store/cash/sessions', ...guard, route(async (req, res) => {
    const r = await q(`SELECT s.id,s.status,s.opened_at,s.closed_at,s.opening_cents,s.expected_cash_cents,s.counted_cash_cents,s.close_note,
        uo.name opened_by_name,uc.name closed_by_name,
        (SELECT count(*)::int FROM sales x WHERE x.session_id=s.id AND x.canceled_at IS NULL) sales_count,
        (SELECT coalesce(sum(total_cents),0)::bigint FROM sales x WHERE x.session_id=s.id AND x.canceled_at IS NULL) sales_total_cents,
        (SELECT count(*)::int FROM sales x WHERE x.session_id=s.id AND x.canceled_at IS NULL AND x.customer_id IS NOT NULL) linked_count,
        (SELECT coalesce(sum(amount_cents),0)::bigint FROM cash_movements m WHERE m.session_id=s.id AND m.kind='expense' AND m.canceled_at IS NULL) expenses_total_cents
      FROM cash_sessions s JOIN users uo ON uo.id=s.opened_by LEFT JOIN users uc ON uc.id=s.closed_by
      WHERE s.tenant_id=$1 ORDER BY s.opened_at DESC LIMIT 30`, [tid(req)]);
    res.json(r.rows.map(x => ({ ...x, sales_total_cents: Number(x.sales_total_cents), expenses_total_cents: Number(x.expenses_total_cents) })));
  }));

  // ---------- Clientes (busca rápida no caixa) ----------
  app.get('/api/store/sales/customers', ...guard, route(async (req, res) => {
    const term = String(req.query.q || '').trim().slice(0, 80);
    if (term.length < 2) return res.json([]);
    const digits = phoneDigits(term);
    const r = await q(`SELECT id,name,phone,offers_opt_out FROM customers WHERE tenant_id=$1 AND deleted_at IS NULL AND
        (fp_fold(name) LIKE '%'||fp_fold($2)||'%' OR ($3<>'' AND length($3)>=4 AND regexp_replace(coalesce(phone,''),'\\D','','g') LIKE '%'||$3||'%'))
      ORDER BY (fp_fold(name) LIKE fp_fold($2)||'%') DESC,name LIMIT 12`, [tid(req), term, digits]);
    const progress = await progressFor(tid(req), r.rows.map(x => x.id));
    const cashback = await cashbackFor(tid(req), r.rows.map(x => x.id));
    res.json(r.rows.map(x => ({ ...x, loyalty: progress.get(x.id), cashback: cashback.get(x.id) })));
  }));

  app.get('/api/store/sales/customers/:id', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Cliente inválido');
    const c = await q('SELECT id,name,phone,offers_opt_out FROM customers WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [req.params.id, tid(req)]);
    if (!c.rowCount) return bad(res, 404, 'Cliente não encontrado');
    const orders = await q(`SELECT o.id,o.order_number,o.status,o.created_at,o.process_snapshot->>'name' process,o.details
      FROM orders o WHERE o.tenant_id=$1 AND o.customer_id=$2 AND o.deleted_at IS NULL AND o.created_at>now()-interval '60 days'
      AND NOT EXISTS(SELECT 1 FROM sales s WHERE s.order_id=o.id AND s.canceled_at IS NULL) ORDER BY o.created_at DESC LIMIT 8`, [tid(req), req.params.id]);
    const recent = await q(`SELECT sale_number,total_cents,payment_method,description,created_at FROM sales WHERE tenant_id=$1 AND customer_id=$2 AND canceled_at IS NULL ORDER BY created_at DESC LIMIT 5`, [tid(req), req.params.id]);
    const progress = await progressFor(tid(req), [req.params.id]);
    const cashback = (await cashbackFor(tid(req), [req.params.id])).get(req.params.id);
    res.json({ ...c.rows[0], loyalty: progress.get(req.params.id), cashback, orders: orders.rows, recent_sales: recent.rows });
  }));

  app.patch('/api/store/sales/customers/:id/offers', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Cliente inválido');
    const v = valid(z.object({ opt_out: z.boolean() }).strict(), req, res); if (!v) return;
    const r = await q('UPDATE customers SET offers_opt_out=$1 WHERE id=$2 AND tenant_id=$3 RETURNING id,offers_opt_out', [v.opt_out, req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'Cliente não encontrado');
    await audit(req, v.opt_out ? 'offers_opt_out' : 'offers_opt_in', 'customer', req.params.id); res.json(r.rows[0]);
  }));

  // Resgate no balcão: usa as compras da meta e registra o prêmio como entregue.
  app.post('/api/store/sales/customers/:id/redeem', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Cliente inválido');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const t = await c.query('SELECT loyalty_enabled,loyalty_target,loyalty_reward FROM tenants WHERE id=$1', [tid(req)]);
      if (!t.rows[0]?.loyalty_enabled) { await c.query('ROLLBACK'); return bad(res, 409, 'A fidelidade está desligada nas Configurações'); }
      const cust = await c.query('SELECT id FROM customers WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE', [req.params.id, tid(req)]);
      if (!cust.rowCount) { await c.query('ROLLBACK'); return bad(res, 404, 'Cliente não encontrado'); }
      const { loyalty_target: target, loyalty_reward: reward } = t.rows[0];
      const eligible = await c.query('SELECT id FROM loyalty_checkins WHERE tenant_id=$1 AND customer_id=$2 AND redemption_id IS NULL ORDER BY created_at,id LIMIT $3', [tid(req), req.params.id, target]);
      if (eligible.rowCount < target) { await c.query('ROLLBACK'); return bad(res, 409, `Faltam ${target - eligible.rowCount} compra(s) para o prêmio`); }
      const codeHash = crypto.createHash('sha256').update('BALCAO-' + crypto.randomUUID()).digest('hex');
      const red = await c.query(`INSERT INTO loyalty_redemptions(tenant_id,customer_id,code_hash,status,target_snapshot,reward_snapshot,redeemed_at,redeemed_by)
        VALUES($1,$2,$3,'redeemed',$4,$5,now(),$6) RETURNING id,redeemed_at`, [tid(req), req.params.id, codeHash, target, reward, req.user.id]);
      await c.query('UPDATE loyalty_checkins SET redemption_id=$1 WHERE id=ANY($2::uuid[])', [red.rows[0].id, eligible.rows.map(x => x.id)]);
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'loyalty_redeem_counter', 'loyalty_redemption', red.rows[0].id]);
      await c.query('COMMIT');
      const progress = await progressFor(tid(req), [req.params.id]);
      res.status(201).json({ reward, redeemed_at: red.rows[0].redeemed_at, loyalty: progress.get(req.params.id) });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // ---------- Produtos (código de barras) ----------
  // O leitor USB funciona como teclado: digita o código e Enter. O painel procura aqui.
  const productFields = 'id,name,barcode,price_cents,cost_cents,stock_qty,generated_barcode,ask_variant,restock_pending,labels_pending,active,updated_at,kind,supplier_id,device_model,(SELECT s.name FROM suppliers s WHERE s.id=products.supplier_id) supplier_name';
  // Fornecedor e modelo de aparelho: acha pelo nome (sem diferenciar maiúsculas) ou cria; cada uso sobe na lista de sugestões.
  const cleanName = v => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const touchName = async (cq, table, tenant, name, use = true) => {
    const n = cleanName(name); if (!n) return null;
    return (await cq(`INSERT INTO ${table}(tenant_id,name,uses,last_used_at) VALUES($1,$2,$3,CASE WHEN $3>0 THEN now() END)
      ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET uses=${table}.uses+$3,last_used_at=CASE WHEN $3>0 THEN now() ELSE ${table}.last_used_at END,active=true RETURNING id,name`, [tenant, n, use ? 1 : 0])).rows[0];
  };
  // Log de estoque: toda mudança grava quantidade, custo (entradas, para o relatório de compras), quem fez e o saldo
  // antes e depois. Chamar DEPOIS de mudar o estoque: o saldo "depois" é lido do produto (ou do modelo).
  // opts.before: saldo anterior quando não dá para calcular (ex.: produto que não controlava estoque); opts.note: observação.
  const ledger = (cq, tenant, productId, variantId, kind, quantity, unitCost, saleId, userId, opts = {}) => cq(`WITH a AS (SELECT CASE WHEN $3::uuid IS NULL
      THEN (SELECT stock_qty FROM products WHERE id=$2) ELSE (SELECT stock_qty FROM product_variants WHERE id=$3) END s)
    INSERT INTO stock_movements(tenant_id,product_id,variant_id,kind,quantity,unit_cost_cents,sale_id,created_by,stock_after,stock_before,note)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,a.s,CASE WHEN $9 THEN $10::int ELSE a.s-$5 END,$11 FROM a`,
    [tenant, productId, variantId, kind, quantity, unitCost ?? null, saleId ?? null, userId ?? null, 'before' in opts, opts.before ?? null, opts.note ?? null]);
  // Peça: o "modelo" é o aparelho e o fornecedor vai junto, para a lista de compras.
  const restockRows = async tenant => (await q(`SELECT p.id product_id,NULL::uuid variant_id,p.name,p.device_model variant,p.restock_pending pending,p.stock_qty,p.cost_cents,p.barcode,p.kind,s.name supplier_name
      FROM products p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.tenant_id=$1 AND p.active AND NOT p.ask_variant AND p.restock_pending>0
    UNION ALL
    SELECT p.id,v.id,p.name,v.name,v.restock_pending,v.stock_qty,p.cost_cents,p.barcode,p.kind,NULL
      FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.tenant_id=$1 AND p.active AND v.active AND v.restock_pending>0
    ORDER BY 9,10 NULLS LAST,3,4`, [tenant])).rows;
  // Modelo de um produto com modelos: acha pelo nome (sem diferenciar maiúsculas) ou cria.
  const upsertVariant = async (cq, tenant, productId, name) => (await cq(`INSERT INTO product_variants(tenant_id,product_id,name) VALUES($1,$2,$3)
    ON CONFLICT (product_id, lower(name)) DO UPDATE SET active=true RETURNING id,name,stock_qty,restock_pending`, [tenant, productId, name.trim().replace(/\s+/g, ' ')])).rows[0];
  const stockQty = z.number().int().min(-999999).max(999999);
  // Código interno EAN-13 começando com 2 (faixa reservada para uso dentro da loja; não colide com códigos de fábrica).
  const ean13 = body12 => { let sum = 0; for (let i = 0; i < 12; i++) sum += Number(body12[i]) * (i % 2 ? 3 : 1); return body12 + ((10 - (sum % 10)) % 10); };
  const productBody = z.object({
    name: z.string().trim().min(2).max(120),
    barcode: z.union([z.literal(''), z.string().trim().regex(/^[!-~]{3,64}$/, 'Código de barras inválido')]).optional(),
    price_cents: cents.optional(),
    cost_cents: cents.nullable().optional(),
    stock_qty: stockQty.nullable().optional(),
    ask_variant: z.boolean().optional(),
    // Peça de serviço (tela, bateria…): fornecedor e modelo do aparelho; preço de venda é opcional (sugestão).
    kind: z.enum(['product', 'part']).optional(),
    supplier: z.string().trim().max(80).optional(),
    device_model: z.string().trim().max(80).optional()
  }).strict();
  const dupBarcode = (e, res) => { if (e.code === '23505') { bad(res, 409, 'Já existe um produto com este código de barras'); return true; } return false; };

  // Busca por nome: cada palavra pode estar em qualquer parte ("cabo tipo c" acha "Cabo USB Tipo-C").
  // include_deleted=1 (com termo): traz também os excluídos, para reaproveitar o cadastro antigo na reposição.
  app.get('/api/store/products', ...guard, route(async (req, res) => {
    const term = String(req.query.q || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const kind = req.query.kind === 'part' ? 'part' : 'product';
    const words = term ? term.split(' ').filter(Boolean).slice(0, 8) : [];
    const deleted = !!term && req.query.include_deleted === '1';
    const r = await q(`SELECT ${productFields} FROM products WHERE tenant_id=$1 AND (active OR $5) AND kind=$3 AND
        ($2='' OR barcode=$2 OR fp_fold(name || ' ' || coalesce(device_model,'')) LIKE ALL (SELECT '%'||fp_fold(w)||'%' FROM unnest($4::text[]) w))
      ORDER BY (barcode=$2) DESC NULLS LAST,active DESC,(fp_fold(name) LIKE fp_fold($2)||'%') DESC,name,device_model,updated_at DESC LIMIT 500`, [tid(req), term, kind, words, deleted]);
    res.set('Cache-Control', 'no-store'); res.json(r.rows);
  }));
  // Produto excluído volta para a lista com o cadastro antigo (nome, código, preços); o estoque recomeça do zero.
  app.post('/api/store/products/:id/restore', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Produto inválido');
    try {
      const old = (await q('SELECT stock_qty FROM products WHERE id=$1 AND tenant_id=$2 AND NOT active', [req.params.id, tid(req)])).rows[0];
      const r = await q(`UPDATE products SET active=true,stock_qty=CASE WHEN stock_qty IS NULL THEN NULL ELSE 0 END,restock_pending=0,updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND NOT active RETURNING ${productFields}`, [req.params.id, tid(req)]);
      if (!r.rowCount) return bad(res, 404, 'Produto não encontrado');
      await ledger(q, tid(req), r.rows[0].id, null, 'restore', (r.rows[0].stock_qty ?? 0) - (old?.stock_qty ?? 0), null, null, req.user.id,
        { before: old?.stock_qty ?? null, note: old?.stock_qty ? `Produto reativado: estoque recomeça do zero (tinha ${old.stock_qty})` : 'Produto reativado' });
      await audit(req, 'restore', 'product', r.rows[0].id); res.json(r.rows[0]);
    } catch (e) { if (!dupBarcode(e, res)) throw e; }
  }));
  app.get('/api/store/products/barcode/:code', ...guard, route(async (req, res) => {
    const code = String(req.params.code || '').trim();
    if (!/^[!-~]{3,64}$/.test(code)) return bad(res, 400, 'Código de barras inválido');
    const r = await q(`SELECT ${productFields} FROM products WHERE tenant_id=$1 AND active AND barcode=$2 AND kind='product'`, [tid(req), code]);
    if (!r.rowCount) return bad(res, 404, 'Produto não cadastrado');
    res.set('Cache-Control', 'no-store'); res.json(r.rows[0]);
  }));
  app.post('/api/store/products', ...guard, route(async (req, res) => {
    const v = valid(productBody, req, res); if (!v) return;
    const part = v.kind === 'part';
    if (!part && v.price_cents == null) return bad(res, 400, 'Informe o preço de venda');
    if (part && v.ask_variant) return bad(res, 400, 'Peça não usa código geral com modelos: cadastre uma peça para cada modelo');
    try {
      const sup = part ? await touchName(q, 'suppliers', tid(req), v.supplier, false) : null;
      if (part && v.device_model) await touchName(q, 'device_models', tid(req), v.device_model, false);
      const r = await q(`INSERT INTO products(tenant_id,name,barcode,price_cents,cost_cents,stock_qty,ask_variant,created_by,kind,supplier_id,device_model) VALUES($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8,$9,$10,NULLIF($11,'')) RETURNING ${productFields}`,
        [tid(req), v.name, v.barcode || '', v.price_cents ?? 0, v.cost_cents ?? null, v.ask_variant ? null : v.stock_qty ?? null, !!v.ask_variant, req.user.id, part ? 'part' : 'product', sup?.id || null, part ? cleanName(v.device_model) : '']);
      if (!v.ask_variant && v.stock_qty > 0) await ledger(q, tid(req), r.rows[0].id, null, 'entry', v.stock_qty, v.cost_cents, null, req.user.id, { before: null, note: part ? 'Peça cadastrada' : 'Produto cadastrado' });
      await audit(req, 'create', 'product', r.rows[0].id); res.status(201).json(r.rows[0]);
    } catch (e) { if (!dupBarcode(e, res)) throw e; }
  }));
  app.patch('/api/store/products/:id', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Produto inválido');
    const v = valid(productBody.partial().strict(), req, res); if (!v) return;
    if (v.kind) return bad(res, 400, 'O tipo (produto ou peça) não muda depois do cadastro');
    try {
      const sup = 'supplier' in v ? await touchName(q, 'suppliers', tid(req), v.supplier, false) : null;
      if (v.device_model) await touchName(q, 'device_models', tid(req), v.device_model, false);
      const old = 'stock_qty' in v ? (await q('SELECT stock_qty FROM products WHERE id=$1 AND tenant_id=$2 AND active', [req.params.id, tid(req)])).rows[0] : null;
      const r = await q(`UPDATE products SET name=COALESCE($1,name),
          supplier_id=CASE WHEN $11 THEN $12::uuid ELSE supplier_id END,
          device_model=CASE WHEN $13::text IS NULL THEN device_model ELSE NULLIF($13,'') END,
          barcode=CASE WHEN $2::text IS NULL THEN barcode ELSE NULLIF($2,'') END,
          price_cents=COALESCE($3,price_cents),
          cost_cents=CASE WHEN $6 THEN $7::int ELSE cost_cents END,
          stock_qty=CASE WHEN $8 THEN $9::int ELSE stock_qty END,
          ask_variant=COALESCE($10,ask_variant),updated_at=now()
        WHERE id=$4 AND tenant_id=$5 AND active RETURNING ${productFields}`, [v.name ?? null, v.barcode ?? null, v.price_cents ?? null, req.params.id, tid(req),
        'cost_cents' in v, v.cost_cents ?? null, 'stock_qty' in v, v.stock_qty ?? null, v.ask_variant ?? null,
        'supplier' in v, sup?.id || null, 'device_model' in v ? cleanName(v.device_model) : null]);
      if (!r.rowCount) return bad(res, 404, 'Produto não encontrado');
      // Quantidade trocada direto no cadastro também entra no log.
      const before = old?.stock_qty ?? null, after = r.rows[0].stock_qty;
      if (old && before !== after) await ledger(q, tid(req), req.params.id, null, 'edit', (after ?? 0) - (before ?? 0), null, null, req.user.id,
        { before, note: before == null ? 'Passou a controlar estoque' : after == null ? 'Deixou de controlar estoque' : 'Quantidade corrigida no cadastro' });
      await audit(req, 'update', 'product', req.params.id); res.json(r.rows[0]);
    } catch (e) { if (!dupBarcode(e, res)) throw e; }
  }));
  // Produto sem código de barras: o sistema cria um código interno, cadastra o produto com o
  // estoque informado e o painel imprime uma etiqueta por unidade.
  app.post('/api/store/products/generate', ...guard, route(async (req, res) => {
    const v = valid(z.object({ name: z.string().trim().min(2).max(120), price_cents: cents, cost_cents: cents.nullable().optional(), quantity: z.number().int().min(1).max(500) }).strict(), req, res); if (!v) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const n = (await q("SELECT nextval('product_internal_code_seq') n")).rows[0].n;
      const code = ean13('2' + String(n).padStart(11, '0'));
      try {
        const r = await q(`INSERT INTO products(tenant_id,name,barcode,price_cents,cost_cents,stock_qty,generated_barcode,created_by) VALUES($1,$2,$3,$4,$5,$6,true,$7) RETURNING ${productFields}`,
          [tid(req), v.name, code, v.price_cents, v.cost_cents ?? null, v.quantity, req.user.id]);
        await ledger(q, tid(req), r.rows[0].id, null, 'entry', v.quantity, v.cost_cents, null, req.user.id, { before: null, note: 'Produto cadastrado com código gerado' });
        await audit(req, 'create', 'product', r.rows[0].id); return res.status(201).json(r.rows[0]);
      } catch (e) { if (e.code !== '23505') throw e; }
    }
    bad(res, 409, 'Não foi possível gerar um código livre. Tente de novo.');
  }));
  // Entrada (ou ajuste) de estoque: soma ao estoque atual; produto sem controle passa a controlar.
  // Produto com modelos: a entrada é por modelo. Entrada abate o que estava "vendido e não reposto".
  app.post('/api/store/products/:id/stock', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Produto inválido');
    const v = valid(z.object({ add: z.number().int().min(-99999).max(99999).refine(n => n !== 0), variant_name: z.string().trim().min(1).max(80).optional(), unit_cost_cents: cents.nullable().optional() }).strict(), req, res); if (!v) return;
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const p = (await c.query(`SELECT ${productFields} FROM products WHERE id=$1 AND tenant_id=$2 AND active FOR UPDATE`, [req.params.id, tid(req)])).rows[0];
      if (!p) { await c.query('ROLLBACK'); return bad(res, 404, 'Produto não encontrado'); }
      if (p.ask_variant && !v.variant_name) { await c.query('ROLLBACK'); return bad(res, 400, 'Informe o modelo (ex.: Galaxy A12)'); }
      const cq = (sql, params) => c.query(sql, params);
      const cost = v.unit_cost_cents !== undefined ? v.unit_cost_cents : p.cost_cents;
      let variant = null;
      if (p.ask_variant) {
        const vr = await upsertVariant(cq, tid(req), p.id, v.variant_name);
        variant = (await c.query(`UPDATE product_variants SET stock_qty=LEAST(999999,GREATEST(-999999,coalesce(stock_qty,0)+$1)),
          restock_pending=CASE WHEN $1>0 THEN GREATEST(0,restock_pending-$1) ELSE restock_pending END WHERE id=$2 RETURNING id,name,stock_qty,restock_pending`, [v.add, vr.id])).rows[0];
      } else {
        await c.query(`UPDATE products SET stock_qty=LEAST(999999,GREATEST(-999999,coalesce(stock_qty,0)+$1)),
          restock_pending=CASE WHEN $1>0 THEN GREATEST(0,restock_pending-$1) ELSE restock_pending END,updated_at=now() WHERE id=$2`, [v.add, p.id]);
      }
      await ledger(cq, tid(req), p.id, variant?.id || null, v.add > 0 ? 'entry' : 'adjust', v.add, v.add > 0 ? cost : null, null, req.user.id,
        p.ask_variant ? {} : { before: p.stock_qty, note: p.stock_qty == null ? 'Passou a controlar estoque' : undefined });
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'stock', 'product', p.id]);
      await c.query('COMMIT');
      const out = (await q(`SELECT ${productFields} FROM products WHERE id=$1`, [p.id])).rows[0];
      res.json({ ...out, variant });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));
  // Modelos de um produto (película, capinha): os mais vendidos primeiro; filtra pelo que já foi digitado.
  app.get('/api/store/products/:id/variants', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Produto inválido');
    const term = String(req.query.q || '').trim().slice(0, 80);
    const r = await q(`SELECT v.id,v.name,v.stock_qty,v.restock_pending,v.sold_count,v.last_sold_at FROM product_variants v JOIN products p ON p.id=v.product_id
      WHERE v.product_id=$1 AND p.tenant_id=$2 AND v.active AND ($3='' OR fp_fold(v.name) LIKE '%'||fp_fold($3)||'%')
      ORDER BY (fp_fold(v.name) LIKE fp_fold($3)||'%') DESC, v.sold_count DESC, v.last_sold_at DESC NULLS LAST, v.name LIMIT 60`, [req.params.id, tid(req), term]);
    res.set('Cache-Control', 'no-store'); res.json(r.rows);
  }));
  app.delete('/api/store/products/:id/variants/:vid', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success || !uuid.safeParse(req.params.vid).success) return bad(res, 400, 'Modelo inválido');
    const r = await q('UPDATE product_variants SET active=false WHERE id=$1 AND product_id=$2 AND tenant_id=$3 RETURNING id,name,stock_qty', [req.params.vid, req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'Modelo não encontrado');
    await ledger(q, tid(req), req.params.id, req.params.vid, 'delete', 0, null, null, req.user.id,
      { note: `Modelo ${r.rows[0].name} excluído` + (r.rows[0].stock_qty ? ` com ${r.rows[0].stock_qty} no estoque` : '') });
    res.json({ deleted: true });
  }));
  // Reposição: o que foi vendido e ainda não teve entrada de estoque, por produto e por modelo.
  app.get('/api/store/stock/restock', ...guard, route(async (req, res) => {
    res.set('Cache-Control', 'no-store'); res.json(await restockRows(tid(req)));
  }));
  // Histórico (log) do estoque: mais recentes primeiro. Filtros: produto, tipo, texto (nome/código), período.
  // Paginação: "before" = created_at do último item recebido.
  const LOG_KINDS = ['entry', 'sale', 'cancel', 'adjust', 'edit', 'restore', 'delete'];
  app.get('/api/store/stock/log', ...guard, route(async (req, res) => {
    const pid = String(req.query.product_id || ''), kind = String(req.query.kind || ''), term = String(req.query.q || '').trim().slice(0, 80);
    if (pid && !uuid.safeParse(pid).success) return bad(res, 400, 'Produto inválido');
    if (kind && !LOG_KINDS.includes(kind)) return bad(res, 400, 'Tipo inválido');
    const day = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
    const from = day(req.query.from), to = day(req.query.to);
    const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before).toISOString() : '';
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 100));
    const r = await q(`SELECT m.id,m.created_at,m.kind,m.quantity,m.stock_before,m.stock_after,m.unit_cost_cents,m.note,
        p.id product_id,p.name,p.kind product_kind,p.barcode,p.device_model,v.name variant,x.sale_number,u.name who
      FROM stock_movements m JOIN products p ON p.id=m.product_id LEFT JOIN product_variants v ON v.id=m.variant_id
      LEFT JOIN sales x ON x.id=m.sale_id LEFT JOIN users u ON u.id=m.created_by
      WHERE m.tenant_id=$1 AND ($2='' OR m.product_id=$2::uuid) AND ($3='' OR m.kind=$3)
        AND ($4='' OR fp_fold(p.name || ' ' || COALESCE(v.name,'') || ' ' || COALESCE(p.device_model,'')) LIKE '%'||fp_fold($4)||'%' OR p.barcode=$4)
        AND ($5='' OR m.created_at >= ($5::date)::timestamp AT TIME ZONE $8) AND ($6='' OR m.created_at < ($6::date + 1)::timestamp AT TIME ZONE $8)
        AND ($7='' OR m.created_at < $7::timestamptz)
      ORDER BY m.created_at DESC,m.id DESC LIMIT $9`, [tid(req), pid, kind, term, from, to, before, TZ, limit]);
    res.set('Cache-Control', 'no-store'); res.json({ rows: r.rows, more: r.rowCount === limit });
  }));

  // ---------- Fila de etiquetas ----------
  // Produto entra na fila com a quantidade de etiquetas; a aba "Etiquetas" imprime vários produtos na mesma folha.
  const labelFields = 'id,name,barcode,price_cents,stock_qty,ask_variant,generated_barcode,labels_pending,labels_queued_at';
  app.get('/api/store/labels', ...guard, route(async (req, res) => {
    const r = await q(`SELECT ${labelFields} FROM products WHERE tenant_id=$1 AND active AND labels_pending>0 AND barcode IS NOT NULL ORDER BY labels_queued_at,name`, [tid(req)]);
    res.set('Cache-Control', 'no-store'); res.json(r.rows);
  }));
  // add: soma à fila; qty: define a quantidade (0 tira da fila).
  app.post('/api/store/labels', ...guard, route(async (req, res) => {
    const v = valid(z.object({ product_id: uuid, add: z.number().int().min(1).max(500).optional(), qty: z.number().int().min(0).max(500).optional() }).strict()
      .refine(x => (x.add == null) !== (x.qty == null), 'Informe add ou qty'), req, res); if (!v) return;
    const r = await q(`UPDATE products SET labels_pending=LEAST(500,CASE WHEN $3::int IS NULL THEN labels_pending+$4 ELSE $3 END),
        labels_queued_at=CASE WHEN labels_pending=0 THEN now() ELSE labels_queued_at END
      WHERE id=$1 AND tenant_id=$2 AND active AND barcode IS NOT NULL RETURNING ${labelFields}`, [v.product_id, tid(req), v.qty ?? null, v.add ?? 0]);
    if (!r.rowCount) return bad(res, 404, 'Produto não encontrado ou sem código de barras');
    res.json(r.rows[0]);
  }));
  // Etiquetas impressas: saem da fila.
  app.post('/api/store/labels/printed', ...guard, route(async (req, res) => {
    const v = valid(z.object({ product_ids: z.array(uuid).min(1).max(500) }).strict(), req, res); if (!v) return;
    const r = await q('UPDATE products SET labels_pending=0,labels_queued_at=NULL WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND labels_pending>0', [tid(req), v.product_ids]);
    res.json({ cleared: r.rowCount });
  }));
  // Excluir só desativa: vendas antigas continuam com nome e preço do item.
  app.delete('/api/store/products/:id', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Produto inválido');
    const r = await q('UPDATE products SET active=false,labels_pending=0,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND active RETURNING id,stock_qty', [req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'Produto não encontrado');
    await ledger(q, tid(req), req.params.id, null, 'delete', 0, null, null, req.user.id,
      { note: 'Produto excluído' + (r.rows[0].stock_qty ? ` com ${r.rows[0].stock_qty} no estoque` : '') });
    await audit(req, 'delete', 'product', req.params.id); res.json({ deleted: true });
  }));

  // ---------- Sugestões: fornecedores, modelos de aparelho e serviços ----------
  // Os mais usados primeiro; quem começa com o que foi digitado vem antes.
  const suggest = table => route(async (req, res) => {
    const term = String(req.query.q || '').trim().slice(0, 80);
    const r = await q(`SELECT id,name,uses${table === 'suppliers' ? ',phone' : ''} FROM ${table} WHERE tenant_id=$1 AND active AND ($2='' OR fp_fold(name) LIKE '%'||fp_fold($2)||'%')
      ORDER BY (fp_fold(name) LIKE fp_fold($2)||'%') DESC,uses DESC,last_used_at DESC NULLS LAST,lower(name) LIMIT ${term ? 15 : 200}`, [tid(req), term]);
    res.set('Cache-Control', 'no-store'); res.json(r.rows);
  });
  const nameBody = z.object({ name: z.string().trim().min(1).max(80), phone: z.string().trim().max(30).optional() }).strict();
  for (const [path, table] of [['suppliers', 'suppliers'], ['device-models', 'device_models']]) {
    app.get('/api/store/' + path, ...guard, suggest(table));
    app.post('/api/store/' + path, ...guard, route(async (req, res) => {
      const v = valid(nameBody, req, res); if (!v) return;
      const row = await touchName(q, table, tid(req), v.name, false);
      if (table === 'suppliers' && v.phone !== undefined) await q('UPDATE suppliers SET phone=NULLIF($1,\'\') WHERE id=$2', [v.phone, row.id]);
      await audit(req, 'create', table === 'suppliers' ? 'supplier' : 'device_model', row.id); res.status(201).json(row);
    }));
    // Tirar da lista de sugestões: vendas e peças antigas continuam com o nome.
    app.delete('/api/store/' + path + '/:id', ...guard, route(async (req, res) => {
      if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Item inválido');
      const r = await q(`UPDATE ${table} SET active=false WHERE id=$1 AND tenant_id=$2 RETURNING id`, [req.params.id, tid(req)]);
      if (!r.rowCount) return bad(res, 404, 'Não encontrado');
      res.json({ deleted: true });
    }));
  }
  // Serviços pré-cadastrados (botões no modo Serviço). A loja recebe uma lista inicial uma única vez;
  // o que ela excluir não volta.
  const SERVICE_DEFAULTS = ['Troca de tela', 'Troca de bateria', 'Troca de conector de carga', 'Troca de tampa traseira', 'Troca de vidro da câmera', 'Reparo comum', 'Limpeza / banho químico', 'Software / formatação', 'Diagnóstico'];
  const catalogFields = 'id,name,price_cents,cost_cents,position';
  app.get('/api/store/sales/service-items', ...guard, route(async (req, res) => {
    const seeded = await q('UPDATE tenants SET service_catalog_seeded=true WHERE id=$1 AND NOT service_catalog_seeded RETURNING id', [tid(req)]);
    if (seeded.rowCount) await q(`INSERT INTO service_catalog(tenant_id,name,position) SELECT $1,n,o FROM unnest($2::text[]) WITH ORDINALITY AS d(n,o)
      ON CONFLICT DO NOTHING`, [tid(req), SERVICE_DEFAULTS]);
    const r = await q(`SELECT ${catalogFields} FROM service_catalog WHERE tenant_id=$1 AND active ORDER BY position,lower(name)`, [tid(req)]);
    res.set('Cache-Control', 'no-store'); res.json(r.rows);
  }));
  const catalogBody = z.object({ name: z.string().trim().min(2).max(80), price_cents: cents.nullable().optional(), cost_cents: cents.nullable().optional() }).strict();
  app.post('/api/store/sales/service-items', ...guard, route(async (req, res) => {
    const v = valid(catalogBody, req, res); if (!v) return;
    const n = (await q('SELECT count(*)::int n FROM service_catalog WHERE tenant_id=$1 AND active', [tid(req)])).rows[0].n;
    if (n >= 60) return bad(res, 409, 'Limite de 60 serviços. Exclua algum antes de cadastrar outro.');
    // Mesmo nome: atualiza preço e custo em vez de duplicar.
    const up = await q(`UPDATE service_catalog SET price_cents=$3,cost_cents=$4 WHERE tenant_id=$1 AND active AND lower(name)=lower($2) RETURNING ${catalogFields}`, [tid(req), v.name, v.price_cents ?? null, v.cost_cents ?? null]);
    const r = up.rowCount ? up : await q(`INSERT INTO service_catalog(tenant_id,name,price_cents,cost_cents,position) VALUES($1,$2,$3,$4,
      (SELECT coalesce(max(position),0)+1 FROM service_catalog WHERE tenant_id=$1)) RETURNING ${catalogFields}`, [tid(req), v.name.replace(/\s+/g, ' '), v.price_cents ?? null, v.cost_cents ?? null]);
    await audit(req, 'create', 'service_catalog', r.rows[0].id); res.status(201).json(r.rows[0]);
  }));
  app.patch('/api/store/sales/service-items/:id', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Serviço inválido');
    const v = valid(catalogBody.partial().strict(), req, res); if (!v) return;
    try {
      const r = await q(`UPDATE service_catalog SET name=COALESCE($3,name),price_cents=CASE WHEN $4 THEN $5::int ELSE price_cents END,cost_cents=CASE WHEN $6 THEN $7::int ELSE cost_cents END
        WHERE id=$1 AND tenant_id=$2 AND active RETURNING ${catalogFields}`, [req.params.id, tid(req), v.name ?? null, 'price_cents' in v, v.price_cents ?? null, 'cost_cents' in v, v.cost_cents ?? null]);
      if (!r.rowCount) return bad(res, 404, 'Serviço não encontrado');
      await audit(req, 'update', 'service_catalog', req.params.id); res.json(r.rows[0]);
    } catch (e) { if (e.code === '23505') return bad(res, 409, 'Já existe um serviço com este nome'); throw e; }
  }));
  app.delete('/api/store/sales/service-items/:id', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Serviço inválido');
    const r = await q('UPDATE service_catalog SET active=false WHERE id=$1 AND tenant_id=$2 AND active RETURNING id', [req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'Serviço não encontrado');
    await audit(req, 'delete', 'service_catalog', req.params.id); res.json({ deleted: true });
  }));

  // Nomes de serviço já lançados (troca de tela, troca de bateria…), os mais feitos primeiro.
  app.get('/api/store/sales/services', ...guard, route(async (req, res) => {
    const r = await q(`SELECT min(i.name) name,count(*)::int uses,(array_agg(i.unit_price_cents ORDER BY x.created_at DESC))[1] last_price_cents
      FROM sale_items i JOIN sales x ON x.id=i.sale_id WHERE x.tenant_id=$1 AND i.service AND x.canceled_at IS NULL
      GROUP BY lower(i.name) ORDER BY 2 DESC,1 LIMIT 40`, [tid(req)]);
    res.set('Cache-Control', 'no-store'); res.json(r.rows);
  }));

  // ---------- Vendedores ----------
  // Logins ativos da loja (dono e operadores, cadastrados na central). Pré-seleciona quem fez a última venda.
  app.get('/api/store/sales/sellers', ...guard, route(async (req, res) => {
    const u = await q("SELECT id,name,role FROM users WHERE tenant_id=$1 AND active AND role IN ('owner','operator') ORDER BY lower(name)", [tid(req)]);
    const last = await q('SELECT seller_id FROM sales WHERE tenant_id=$1 AND seller_id IS NOT NULL ORDER BY created_at DESC LIMIT 1', [tid(req)]);
    const lastId = last.rows[0]?.seller_id;
    res.set('Cache-Control', 'no-store');
    res.json({ sellers: u.rows, last_seller_id: u.rows.some(x => x.id === lastId) ? lastId : null, me: req.user.id });
  }));

  // ---------- Vendas ----------
  app.post('/api/store/sales', ...guard, route(async (req, res) => {
    const v = valid(z.object({
      customer_id: uuid.optional(),
      new_customer: z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().max(30).default('') }).optional(),
      anonymous: z.boolean().default(false),
      total_cents: cents.min(1).optional(),
      // Item de produto (preço do cadastro, ou unit_price_cents se o vendedor mudou) ou linha avulsa (nome + preço).
      items: z.array(z.union([
        z.object({ product_id: uuid, quantity: z.number().int().min(1).max(9999), unit_price_cents: cents.optional(), variant_name: z.string().trim().min(1).max(80).optional() }).strict(),
        z.object({ name: z.string().trim().min(1).max(120), quantity: z.number().int().min(1).max(9999), unit_price_cents: cents }).strict(),
        // Serviço: preço cobrado, custo, fornecedor, aparelho e garantia. part_id = peça do estoque usada (baixa 1).
        z.object({ service: z.string().trim().min(2).max(120), unit_price_cents: cents, cost_cents: cents.nullable().optional(), supplier: z.string().trim().max(80).optional(),
          device_model: z.string().trim().max(80).optional(), part_id: uuid.optional(), warranty_days: z.number().int().min(0).max(3650).optional() }).strict()
      ])).min(1).max(200).optional(),
      discount_cents: cents.optional(),
      seller_id: uuid.optional(),
      payment_method: z.enum(['cash', 'pix', 'debit', 'credit', 'other']),
      description: z.string().trim().max(300).default(''),
      order_id: uuid.optional(),
      // Saldo de cashback que o cliente quis usar nesta venda (abate do total; o resto é pago na forma escolhida).
      cashback_use_cents: cents.optional()
    }).strict(), req, res); if (!v) return;
    if (v.cashback_use_cents && !v.customer_id) return bad(res, 400, 'Cashback só pode ser usado por cliente já cadastrado');
    if ([v.customer_id, v.new_customer, v.anonymous || undefined].filter(Boolean).length !== 1) return bad(res, 400, 'Escolha o cliente da venda');
    if (v.order_id && !v.customer_id) return bad(res, 400, 'Pedido exige cliente');
    if (v.items && v.total_cents != null) return bad(res, 400, 'Com produtos, o total é calculado pelos itens');
    if (!v.items && v.total_cents == null) return bad(res, 400, 'Informe o valor da venda ou os produtos');
    if (v.discount_cents && !v.items) return bad(res, 400, 'Desconto é só para venda com produtos; sem produtos, digite o valor final');
    if (req.user.access_level === 'basic' && v.discount_cents) return bad(res, 403, 'Operador novato não pode dar desconto. Peça a um operador livre ou ao dono.');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fp-sale:'||$1))", [tid(req)]);
      const s = await c.query(`SELECT id FROM cash_sessions WHERE tenant_id=$1 AND status='open'`, [tid(req)]);
      if (!s.rowCount) { await c.query('ROLLBACK'); return bad(res, 409, 'Abra o caixa antes de registrar vendas'); }
      const sellerId = v.seller_id || req.user.id;
      if (!(await c.query("SELECT 1 FROM users WHERE id=$1 AND tenant_id=$2 AND active AND role IN ('owner','operator')", [sellerId, tid(req)])).rowCount) { await c.query('ROLLBACK'); return bad(res, 400, 'Vendedor inválido. Atualize a página.'); }
      let customerId = v.customer_id || null, created = false;
      if (customerId && !(await c.query('SELECT 1 FROM customers WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [customerId, tid(req)])).rowCount) { await c.query('ROLLBACK'); return bad(res, 400, 'Cliente inválido'); }
      if (v.new_customer) {
        const phone = v.new_customer.phone ? phoneDigits(v.new_customer.phone) : '';
        const same = phone ? await c.query('SELECT id FROM customers WHERE tenant_id=$1 AND deleted_at IS NULL AND phone_key=fp_phone_key($2) ORDER BY created_at LIMIT 1', [tid(req), phone]) : { rowCount: 0 };
        if (same.rowCount) customerId = same.rows[0].id;
        else { customerId = (await c.query("INSERT INTO customers(tenant_id,name,phone,source) VALUES($1,$2,$3,'caixa') RETURNING id", [tid(req), v.new_customer.name, phone || null])).rows[0].id; created = true; }
      }
      if (v.order_id && !(await c.query('SELECT 1 FROM orders WHERE id=$1 AND tenant_id=$2 AND customer_id=$3 AND deleted_at IS NULL', [v.order_id, tid(req), customerId])).rowCount) { await c.query('ROLLBACK'); return bad(res, 400, 'Pedido não pertence a este cliente'); }
      // Itens: nome, código e custo vêm do cadastro; o preço é o do cadastro, a não ser que o vendedor
      // tenha mudado (unit_price_cents). O mesmo produto com o mesmo preço soma. O desconto geral é
      // distribuído entre os itens, para cada linha mostrar o valor de fato cobrado.
      let items = [], total = v.total_cents, description = v.description;
      if (v.items) {
        const ids = [...new Set(v.items.filter(it => it.product_id).map(it => it.product_id))];
        const p = ids.length ? await c.query('SELECT id,name,barcode,price_cents,cost_cents,ask_variant FROM products WHERE tenant_id=$1 AND active AND id=ANY($2::uuid[])', [tid(req), ids]) : { rows: [], rowCount: 0 };
        if (p.rowCount !== ids.length) { await c.query('ROLLBACK'); return bad(res, 400, 'Produto não encontrado ou excluído. Atualize a venda.'); }
        const byId = new Map(p.rows.map(x => [x.id, x])), merged = new Map();
        const partIds = [...new Set(v.items.filter(it => it.part_id).map(it => it.part_id))];
        const parts = partIds.length ? await c.query(`SELECT p.id,p.name,p.cost_cents,p.device_model,s.name supplier_name FROM products p LEFT JOIN suppliers s ON s.id=p.supplier_id
          WHERE p.tenant_id=$1 AND p.active AND p.kind='part' AND p.id=ANY($2::uuid[])`, [tid(req), partIds]) : { rows: [], rowCount: 0 };
        if (parts.rowCount !== partIds.length) { await c.query('ROLLBACK'); return bad(res, 400, 'Peça não encontrada ou excluída. Escolha a peça de novo.'); }
        const partById = new Map(parts.rows.map(x => [x.id, x]));
        for (const [n, it] of v.items.entries()) {
          if (it.service) {
            // O que o operador digitou vale; o que ficou em branco vem da peça escolhida.
            const part = it.part_id ? partById.get(it.part_id) : null;
            merged.set('s:' + n, { id: part?.id || null, service: true, name: it.service.replace(/\s+/g, ' '), barcode: null,
              cost_cents: it.cost_cents !== undefined && it.cost_cents !== null ? it.cost_cents : part?.cost_cents ?? null,
              supplier: cleanName(it.supplier) || part?.supplier_name || null, device_model: cleanName(it.device_model) || part?.device_model || null,
              warranty_days: it.warranty_days ?? null, list_price_cents: null, unit_price_cents: it.unit_price_cents, quantity: 1 });
            continue;
          }
          const prod = it.product_id ? byId.get(it.product_id) : null;
          const unit = it.unit_price_cents ?? prod.price_cents;
          if (prod && unit !== prod.price_cents && req.user.access_level === 'basic') { await c.query('ROLLBACK'); return bad(res, 403, 'Operador novato não pode mudar o preço do produto. Peça a um operador livre ou ao dono.'); }
          const variant = prod?.ask_variant ? (it.variant_name || '').replace(/\s+/g, ' ') : null;
          if (prod?.ask_variant && !variant) { await c.query('ROLLBACK'); return bad(res, 400, `Informe o modelo de "${prod.name}".`); }
          const key = prod ? prod.id + ':' + (variant || '').toLowerCase() + ':' + unit : 'l:' + it.name.toLowerCase() + ':' + unit;
          const cur = merged.get(key);
          if (cur) cur.quantity += it.quantity;
          else merged.set(key, prod ? { id: prod.id, name: prod.name, variant, barcode: prod.barcode, cost_cents: prod.cost_cents, list_price_cents: prod.price_cents, unit_price_cents: unit, quantity: it.quantity }
            : { id: null, name: it.name, barcode: null, cost_cents: null, list_price_cents: null, unit_price_cents: unit, quantity: it.quantity });
        }
        items = [...merged.values()].map((x, position) => ({ ...x, total_cents: x.unit_price_cents * x.quantity, position }));
        const gross = items.reduce((a, x) => a + x.total_cents, 0), disc = v.discount_cents || 0;
        total = gross - disc;
        if (items.some(x => x.quantity > 9999 || x.total_cents > 100000000) || total < 1 || total > 100000000) { await c.query('ROLLBACK'); return bad(res, 400, disc ? 'O desconto não pode ser igual ou maior que o valor dos itens' : 'Total da venda inválido (confira preços e quantidades)'); }
        if (disc) { let left = disc; items.forEach((x, i) => { const cut = i === items.length - 1 ? left : Math.min(left, Math.round(disc * x.total_cents / gross)); x.total_cents -= cut; left -= cut; }); }
        // Modelo (película/capinha): acha ou cria, com o nome já salvo (fica para sugerir nas próximas vendas).
        for (const x of items) if (x.variant) { const vr = await upsertVariant((sql, params) => c.query(sql, params), tid(req), x.id, x.variant); x.variant = vr.name; x.vid = vr.id; }
        // Serviço: fornecedor e aparelho entram (ou sobem) na lista de sugestões, com o nome como já está salvo.
        for (const x of items) if (x.service) {
          const cq = (sql, params) => c.query(sql, params);
          if (x.supplier) x.supplier = (await touchName(cq, 'suppliers', tid(req), x.supplier)).name;
          if (x.device_model) x.device_model = (await touchName(cq, 'device_models', tid(req), x.device_model)).name;
        }
        const auto = items.map(x => x.service ? x.name + (x.device_model ? ' · ' + x.device_model : '') : (x.quantity > 1 ? x.quantity + 'x ' : '') + x.name + (x.variant ? ' ' + x.variant : '')).join(', ');
        // Serviço com observação: a descrição fica "Troca de tela · Galaxy A12 · cliente vai buscar amanhã".
        if (!description) description = auto.slice(0, 300);
        else if (items.some(x => x.service)) description = (auto + ' · ' + description).slice(0, 300);
      }
      // Cashback usado: confere saldo e limite por compra, abate do total (e de cada item, como o desconto).
      const cbCfg = (await c.query(`SELECT ${CB_CONFIG} FROM tenants WHERE id=$1`, [tid(req)])).rows[0];
      let cbUsed = 0, cbLots = [];
      if (v.cashback_use_cents) {
        if (!cbCfg.cashback_enabled) { await c.query('ROLLBACK'); return bad(res, 409, 'O cashback está desligado nas Configurações'); }
        cbLots = (await c.query(`SELECT id,remaining_cents FROM cashback_lots WHERE tenant_id=$1 AND customer_id=$2 AND ${CB_ACTIVE}
          ORDER BY expires_on,created_at,id FOR UPDATE`, [tid(req), customerId])).rows;
        const allowed = cbAllowed(total, cbLots.reduce((a, l) => a + l.remaining_cents, 0), cbCfg.cashback_max_use_percent);
        if (v.cashback_use_cents > allowed) { await c.query('ROLLBACK'); return bad(res, 400, allowed ? `O cliente pode usar no máximo ${money(allowed)} de cashback nesta venda. Atualize a venda.` : 'O cliente não tem cashback disponível para esta venda. Atualize a venda.'); }
        cbUsed = v.cashback_use_cents; total -= cbUsed; spread(items, cbUsed);
      }
      const n = (await c.query('SELECT coalesce(max(sale_number),0)+1 n FROM sales WHERE tenant_id=$1', [tid(req)])).rows[0].n;
      const sale = (await c.query(`INSERT INTO sales(tenant_id,session_id,sale_number,customer_id,order_id,total_cents,discount_cents,payment_method,description,created_by,seller_id,cashback_used_cents)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [tid(req), s.rows[0].id, n, customerId, v.order_id || null, total, v.items ? v.discount_cents || 0 : 0, v.payment_method, description, req.user.id, sellerId, cbUsed])).rows[0];
      if (cbUsed) {
        const use = (await c.query('INSERT INTO cashback_uses(tenant_id,customer_id,sale_id,amount_cents) VALUES($1,$2,$3,$4) RETURNING id', [tid(req), customerId, sale.id, cbUsed])).rows[0];
        let left = cbUsed; // consome primeiro o que vence antes
        for (const l of cbLots) {
          if (!left) break; const take = Math.min(left, l.remaining_cents); left -= take;
          await c.query('UPDATE cashback_lots SET remaining_cents=remaining_cents-$1 WHERE id=$2', [take, l.id]);
          await c.query('INSERT INTO cashback_use_lots(use_id,lot_id,amount_cents) VALUES($1,$2,$3)', [use.id, l.id, take]);
        }
      }
      // Cashback ganho: sobre o valor pago (já sem desconto e sem o cashback usado). Só vale a partir da próxima compra.
      if (customerId && cbCfg.cashback_enabled && total >= cbCfg.cashback_min_sale_cents) {
        const earned = cbEarn(total, cbCfg.cashback_percent);
        if (earned >= 1) {
          await c.query(`INSERT INTO cashback_lots(tenant_id,customer_id,sale_id,amount_cents,remaining_cents,percent_snapshot,expires_on)
            VALUES($1,$2,$3,$4,$4,$5,(now() AT TIME ZONE $6)::date+$7::int)`, [tid(req), customerId, sale.id, earned, cbCfg.cashback_percent, TZ, cbCfg.cashback_valid_days]);
          await c.query('UPDATE sales SET cashback_earned_cents=$1 WHERE id=$2', [earned, sale.id]);
          sale.cashback_earned_cents = earned;
        }
      }
      const cq = (sql, params) => c.query(sql, params);
      for (const x of items) {
        const vr = x.vid ? { id: x.vid } : null;
        await c.query(`INSERT INTO sale_items(tenant_id,sale_id,product_id,name,barcode,quantity,unit_price_cents,total_cents,position,unit_cost_cents,list_price_cents,variant_id,variant_name,service,supplier_name,device_model,warranty_days)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [tid(req), sale.id, x.id, x.name, x.barcode, x.quantity, x.unit_price_cents, x.total_cents, x.position, x.cost_cents, x.list_price_cents, vr?.id || null, x.variant || null,
          !!x.service, x.service ? x.supplier : null, x.service ? x.device_model : null, x.service ? x.warranty_days : null]);
        if (!x.id) continue;
        // Baixa no estoque (do modelo, ou do produto quando controla estoque) e marca para reposição.
        if (vr) await c.query('UPDATE product_variants SET stock_qty=CASE WHEN stock_qty IS NULL THEN NULL ELSE GREATEST(-999999,stock_qty-$1) END,restock_pending=restock_pending+$1,sold_count=sold_count+$1,last_sold_at=now() WHERE id=$2', [x.quantity, vr.id]);
        else await c.query('UPDATE products SET stock_qty=CASE WHEN stock_qty IS NULL THEN NULL ELSE GREATEST(-999999,stock_qty-$1) END,restock_pending=restock_pending+$1,updated_at=now() WHERE id=$2 AND tenant_id=$3', [x.quantity, x.id, tid(req)]);
        await ledger(cq, tid(req), x.id, vr?.id || null, 'sale', -x.quantity, x.cost_cents, sale.id, req.user.id);
      }
      sale.items = items.map(({ id, name, variant, barcode, quantity, unit_price_cents, list_price_cents, total_cents, service, supplier, device_model, warranty_days, cost_cents }) => ({ product_id: id, name, variant_name: variant || null, barcode, quantity, unit_price_cents, list_price_cents, total_cents,
        ...(service ? { service: true, supplier_name: supplier, device_model, warranty_days, unit_cost_cents: cost_cents } : {}) }));
      // Pagamento de um pedido de serviço não soma de novo: o pedido já conta ao ser concluído.
      let counted = false;
      if (customerId && !v.order_id) {
        const ck = await c.query(`INSERT INTO loyalty_checkins(tenant_id,customer_id,sale_id) SELECT $1,$2,$3
          WHERE EXISTS(SELECT 1 FROM tenants WHERE id=$1 AND loyalty_enabled AND $4>=loyalty_min_sale_cents) RETURNING id`, [tid(req), customerId, sale.id, total]);
        counted = ck.rowCount > 0;
      }
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'create', 'sale', sale.id]);
      await c.query('COMMIT');
      const progress = customerId ? (await progressFor(tid(req), [customerId])).get(customerId) : null;
      const customer = customerId ? (await q('SELECT id,name,phone,offers_opt_out FROM customers WHERE id=$1', [customerId])).rows[0] : null;
      const cashback = customerId ? (await cashbackFor(tid(req), [customerId])).get(customerId) : null;
      res.status(201).json({ sale, customer, customer_created: created, loyalty_counted: counted, loyalty: progress,
        cashback: cashback && { ...cashback, used_cents: sale.cashback_used_cents, earned_cents: sale.cashback_earned_cents } });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // Comprovante de uma venda (impressora térmica 80 mm). Não é documento fiscal.
  app.get('/api/store/sales/:id/receipt', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Venda inválida');
    const r = await q(`SELECT x.id,x.sale_number,x.total_cents,x.discount_cents,x.cashback_used_cents,x.cashback_earned_cents,x.payment_method,x.description,x.created_at,x.canceled_at,x.cancel_reason,x.customer_id,
        c.name customer_name,c.phone customer_phone,o.order_number,u.name created_by_name,COALESCE(sl.name,u.name) seller_name,
        t.name store_name,t.city,t.state,t.whatsapp,
        COALESCE((SELECT json_agg(json_build_object('name',i.name || COALESCE(' ' || i.variant_name,'') || CASE WHEN i.service AND i.device_model IS NOT NULL THEN ' · ' || i.device_model ELSE '' END,
            'quantity',i.quantity,'unit_price_cents',i.unit_price_cents,'list_price_cents',i.list_price_cents,'total_cents',i.total_cents,'service',i.service,'warranty_days',i.warranty_days) ORDER BY i.position)
          FROM sale_items i WHERE i.sale_id=x.id),'[]'::json) items
      FROM sales x JOIN tenants t ON t.id=x.tenant_id LEFT JOIN customers c ON c.id=x.customer_id LEFT JOIN orders o ON o.id=x.order_id JOIN users u ON u.id=x.created_by LEFT JOIN users sl ON sl.id=x.seller_id
      WHERE x.id=$1 AND x.tenant_id=$2`, [req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'Venda não encontrada');
    const sale = r.rows[0];
    const loyalty = sale.customer_id && !sale.canceled_at ? (await progressFor(tid(req), [sale.customer_id])).get(sale.customer_id) : null;
    const cbOn = (await q('SELECT cashback_enabled FROM tenants WHERE id=$1', [tid(req)])).rows[0]?.cashback_enabled;
    const cashback = cbOn && sale.customer_id && !sale.canceled_at ? (await cashbackFor(tid(req), [sale.customer_id])).get(sale.customer_id) : null;
    res.set('Cache-Control', 'no-store'); res.json({ ...sale, timezone: TZ, generated_at: new Date().toISOString(), loyalty: loyalty?.enabled ? loyalty : null, cashback });
  }));

  app.post('/api/store/sales/:id/cancel', ...full, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Venda inválida');
    const v = valid(z.object({ reason: z.string().trim().min(3).max(200) }).strict(), req, res); if (!v) return;
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fp-sale:'||$1))", [tid(req)]); // mesma fila das vendas (saldo de cashback)
      const s = await c.query(`SELECT x.id FROM sales x JOIN cash_sessions s ON s.id=x.session_id WHERE x.id=$1 AND x.tenant_id=$2 AND x.canceled_at IS NULL AND s.status='open' FOR UPDATE OF x`, [req.params.id, tid(req)]);
      if (!s.rowCount) { await c.query('ROLLBACK'); return bad(res, 409, 'Só é possível cancelar vendas do caixa aberto'); }
      await c.query('UPDATE sales SET canceled_at=now(),canceled_by=$1,cancel_reason=$2 WHERE id=$3', [req.user.id, v.reason, req.params.id]);
      // Devolve ao estoque o que a venda baixou.
      await c.query(`UPDATE products p SET stock_qty=CASE WHEN p.stock_qty IS NULL THEN NULL ELSE LEAST(999999,p.stock_qty+i.qty) END,restock_pending=GREATEST(0,p.restock_pending-i.qty),updated_at=now()
        FROM (SELECT product_id,sum(quantity)::int qty FROM sale_items WHERE sale_id=$1 AND product_id IS NOT NULL AND variant_id IS NULL GROUP BY product_id) i
        WHERE p.id=i.product_id AND p.tenant_id=$2`, [req.params.id, tid(req)]);
      await c.query(`UPDATE product_variants v SET stock_qty=CASE WHEN v.stock_qty IS NULL THEN NULL ELSE LEAST(999999,v.stock_qty+i.qty) END,restock_pending=GREATEST(0,v.restock_pending-i.qty),sold_count=GREATEST(0,v.sold_count-i.qty)
        FROM (SELECT variant_id,sum(quantity)::int qty FROM sale_items WHERE sale_id=$1 AND variant_id IS NOT NULL GROUP BY variant_id) i
        WHERE v.id=i.variant_id AND v.tenant_id=$2`, [req.params.id, tid(req)]);
      await c.query(`INSERT INTO stock_movements(tenant_id,product_id,variant_id,kind,quantity,unit_cost_cents,sale_id,created_by,stock_after,stock_before,note)
        SELECT i.tenant_id,i.product_id,i.variant_id,'cancel',i.quantity,i.unit_cost_cents,i.sale_id,$2,a.s,a.s-i.quantity,'Venda cancelada: ' || $3
        FROM sale_items i CROSS JOIN LATERAL (SELECT CASE WHEN i.variant_id IS NULL THEN (SELECT stock_qty FROM products WHERE id=i.product_id)
          ELSE (SELECT stock_qty FROM product_variants WHERE id=i.variant_id) END s) a WHERE i.sale_id=$1 AND i.product_id IS NOT NULL`, [req.params.id, req.user.id, v.reason]);
      const removed = await c.query('DELETE FROM loyalty_checkins WHERE sale_id=$1 AND redemption_id IS NULL', [req.params.id]);
      const kept = await c.query('SELECT 1 FROM loyalty_checkins WHERE sale_id=$1', [req.params.id]);
      // Cashback: devolve aos lotes o que a venda usou e anula o que ela gerou. Se o cliente já gastou parte do
      // que esta venda gerou, essa parte não volta (fica informada na resposta).
      const use = (await c.query('UPDATE cashback_uses SET reversed_at=now() WHERE sale_id=$1 AND reversed_at IS NULL RETURNING id,amount_cents', [req.params.id])).rows[0];
      if (use) await c.query(`UPDATE cashback_lots l SET remaining_cents=l.remaining_cents+u.amount_cents FROM cashback_use_lots u
        WHERE u.use_id=$1 AND l.id=u.lot_id AND l.reversed_at IS NULL`, [use.id]);
      const lot = (await c.query(`UPDATE cashback_lots n SET reversed_at=now(),remaining_cents=0 FROM cashback_lots o
        WHERE n.id=o.id AND n.sale_id=$1 AND n.reversed_at IS NULL RETURNING o.amount_cents,o.remaining_cents`, [req.params.id])).rows[0];
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'cancel', 'sale', req.params.id]);
      await c.query('COMMIT');
      res.json({ canceled: true, loyalty_removed: removed.rowCount > 0, loyalty_already_redeemed: kept.rowCount > 0,
        cashback_returned_cents: use?.amount_cents || 0, cashback_removed_cents: lot?.amount_cents || 0,
        cashback_already_spent_cents: lot ? lot.amount_cents - lot.remaining_cents : 0 });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // ---------- Mensagens do dia ----------
  // Clientes que compraram no dia (vendas do caixa e pedidos concluídos), com progresso
  // do cartão e se já receberam o status depois da compra.
  app.get('/api/store/messages/status', ...guard, route(async (req, res) => {
    const day = dayField.safeParse(req.query.day).success ? req.query.day : null;
    const r = await q(`WITH buys AS (
        SELECT x.customer_id,x.created_at at,x.total_cents,'sale' kind,x.sale_number::text ref,x.description,x.cashback_earned_cents,x.cashback_used_cents
          FROM sales x WHERE x.tenant_id=$1 AND x.customer_id IS NOT NULL AND x.canceled_at IS NULL
          AND (x.created_at AT TIME ZONE $3)::date=COALESCE($2::date,(now() AT TIME ZONE $3)::date)
        UNION ALL
        SELECT o.customer_id,o.completed_at,NULL,'order',o.order_number::text,o.process_snapshot->>'name',0,0
          FROM orders o WHERE o.tenant_id=$1 AND o.customer_id IS NOT NULL AND o.status='completed' AND o.deleted_at IS NULL
          AND (o.completed_at AT TIME ZONE $3)::date=COALESCE($2::date,(now() AT TIME ZONE $3)::date)
      )
      SELECT c.id,c.name,c.phone,c.offers_opt_out,max(b.at) last_buy,
        json_agg(json_build_object('kind',b.kind,'ref',b.ref,'total_cents',b.total_cents,'description',b.description,'at',b.at,'cashback_earned_cents',b.cashback_earned_cents,'cashback_used_cents',b.cashback_used_cents) ORDER BY b.at) purchases,
        sum(b.cashback_earned_cents)::int cashback_earned_cents,
        (SELECT max(m.created_at) FROM customer_messages m WHERE m.tenant_id=c.tenant_id AND m.customer_id=c.id AND m.kind='status') last_status_at
      FROM buys b JOIN customers c ON c.id=b.customer_id AND c.tenant_id=$1
      GROUP BY c.id ORDER BY max(b.at) DESC`, [tid(req), day, TZ]);
    const progress = await progressFor(tid(req), r.rows.map(x => x.id));
    const cashback = await cashbackFor(tid(req), r.rows.map(x => x.id));
    res.set('Cache-Control', 'no-store');
    res.json({
      day: day || (await q(`SELECT to_char(now() AT TIME ZONE $1,'YYYY-MM-DD') d`, [TZ])).rows[0].d,
      customers: r.rows.map(({ cashback_earned_cents, ...x }) => ({ ...x, loyalty: progress.get(x.id), cashback: { ...cashback.get(x.id), earned_cents: cashback_earned_cents || 0 },
        sent: !!x.last_status_at && new Date(x.last_status_at) >= new Date(x.last_buy) }))
    });
  }));

  // Público de ofertas: clientes com telefone que não pediram para sair.
  app.get('/api/store/messages/offers', ...guard, route(async (req, res) => {
    const days = Number.parseInt(req.query.days, 10);
    const campaign = String(req.query.campaign || '').slice(0, 64);
    const r = await q(`SELECT c.id,c.name,c.phone,
        (SELECT max(at) FROM (SELECT max(created_at) at FROM sales x WHERE x.customer_id=c.id AND x.tenant_id=c.tenant_id AND x.canceled_at IS NULL
           UNION ALL SELECT max(created_at) FROM orders o WHERE o.customer_id=c.id AND o.tenant_id=c.tenant_id AND o.deleted_at IS NULL) z) last_buy,
        EXISTS(SELECT 1 FROM customer_messages m WHERE m.tenant_id=c.tenant_id AND m.customer_id=c.id AND m.kind='offer' AND m.campaign=$2 AND $2<>'') sent
      FROM customers c WHERE c.tenant_id=$1 AND c.deleted_at IS NULL AND NOT c.offers_opt_out AND c.phone_key IS NOT NULL
      ORDER BY c.name`, [tid(req), campaign]);
    let rows = r.rows;
    if (Number.isInteger(days) && days > 0) { const since = Date.now() - days * 86400000; rows = rows.filter(x => x.last_buy && new Date(x.last_buy).getTime() >= since); }
    res.set('Cache-Control', 'no-store'); res.json(rows);
  }));

  // Avisos de cashback perto de vencer: um aviso por etapa (faltando 15, 10, 5 e 1 dia) para o saldo que vence primeiro.
  // A etapa é a menor entre 15/10/5/1 que ainda cobre os dias que faltam; se uma etapa passou sem aviso, só a atual aparece.
  // all=1 lista também quem tem saldo mas ainda não está perto de vencer.
  const CB_STAGES = [1, 5, 10, 15];
  app.get('/api/store/messages/cashback', ...guard, route(async (req, res) => {
    const all = req.query.all === '1';
    const r = await q(`WITH l AS (SELECT customer_id,remaining_cents,expires_on FROM cashback_lots WHERE tenant_id=$1 AND ${CB_ACTIVE}),
        n AS (SELECT customer_id,min(expires_on) next_on,sum(remaining_cents)::int balance FROM l GROUP BY 1),
        t AS (SELECT (now() AT TIME ZONE $2)::date d)
      SELECT c.id,c.name,c.phone,n.balance balance_cents,to_char(n.next_on,'YYYY-MM-DD') expires_on,(n.next_on-t.d)::int days_left,
        (SELECT sum(remaining_cents)::int FROM l WHERE l.customer_id=n.customer_id AND l.expires_on=n.next_on) expiring_cents
      FROM n CROSS JOIN t JOIN customers c ON c.id=n.customer_id AND c.tenant_id=$1 AND c.deleted_at IS NULL
      WHERE $3 OR n.next_on-t.d<=15 ORDER BY n.next_on,c.name`, [tid(req), TZ, all]);
    const sent = await q(`SELECT customer_id,campaign,max(created_at) at FROM customer_messages WHERE tenant_id=$1 AND kind='cashback' AND created_at>now()-interval '30 days' GROUP BY 1,2`, [tid(req)]);
    const sentKey = new Map(sent.rows.map(x => [x.customer_id + '|' + x.campaign, x.at]));
    const totals = (await q(`SELECT coalesce(sum(remaining_cents),0)::bigint balance,count(DISTINCT customer_id)::int customers FROM cashback_lots WHERE tenant_id=$1 AND ${CB_ACTIVE}`, [tid(req)])).rows[0];
    const rows = r.rows.map(x => {
      const stage = x.days_left <= 15 ? CB_STAGES.find(m => x.days_left <= m) : null;
      const campaign = stage ? `cb:${x.expires_on}:${stage}` : null, at = campaign ? sentKey.get(x.id + '|' + campaign) : null;
      return { ...x, stage, campaign, sent: !!at, sent_at: at || null };
    });
    res.set('Cache-Control', 'no-store');
    res.json({ total_balance_cents: Number(totals.balance), customers_with_balance: totals.customers, customers: rows });
  }));

  app.post('/api/store/messages/sent', ...guard, route(async (req, res) => {
    const v = valid(z.object({ customer_id: uuid, kind: z.enum(['status', 'offer', 'cashback']), campaign: z.string().trim().max(64).optional() }).strict(), req, res); if (!v) return;
    if (v.kind !== 'status' && !v.campaign) return bad(res, 400, 'Mensagem sem identificação');
    const r = await q(`INSERT INTO customer_messages(tenant_id,customer_id,kind,campaign,created_by)
      SELECT $1,c.id,$3,$4,$5 FROM customers c WHERE c.id=$2 AND c.tenant_id=$1 RETURNING id,created_at`, [tid(req), v.customer_id, v.kind, v.campaign || null, req.user.id]);
    if (!r.rowCount) return bad(res, 404, 'Cliente não encontrado');
    res.status(201).json(r.rows[0]);
  }));

  // ---------- Itens frequentes (botões de acesso rápido na venda) ----------
  const QUICK_LIMIT = 60;
  app.get('/api/store/sales/quick-items', ...guard, route(async (req, res) => {
    const r = await q('SELECT id,label,price_cents FROM sale_quick_items WHERE tenant_id=$1 ORDER BY lower(label)', [tid(req)]);
    res.set('Cache-Control', 'no-store'); res.json(r.rows);
  }));
  app.post('/api/store/sales/quick-items', ...guard, route(async (req, res) => {
    const v = valid(z.object({ label: z.string().trim().min(1).max(60), price_cents: cents.nullable().optional() }).strict(), req, res); if (!v) return;
    const count = (await q('SELECT count(*)::int n FROM sale_quick_items WHERE tenant_id=$1', [tid(req)])).rows[0].n;
    if (count >= QUICK_LIMIT) return bad(res, 409, `Limite de ${QUICK_LIMIT} itens frequentes. Exclua algum antes de cadastrar outro.`);
    const r = await q(`INSERT INTO sale_quick_items(tenant_id,label,price_cents,created_by) VALUES($1,$2,$3,$4)
      ON CONFLICT (tenant_id, lower(label)) DO UPDATE SET price_cents=EXCLUDED.price_cents
      RETURNING id,label,price_cents`, [tid(req), v.label, v.price_cents ?? null, req.user.id]);
    await audit(req, 'create', 'sale_quick_item', r.rows[0].id); res.status(201).json(r.rows[0]);
  }));
  app.delete('/api/store/sales/quick-items/:id', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const r = await q('DELETE FROM sale_quick_items WHERE id=$1 AND tenant_id=$2 RETURNING id', [req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'Item não encontrado');
    await audit(req, 'delete', 'sale_quick_item', req.params.id); res.json({ ok: true });
  }));

  // ---------- Importação de contatos (WhatsApp, agenda, planilha) ----------
  app.post('/api/store/customers/import-contacts', ...guard, route(async (req, res) => {
    const v = valid(z.object({
      source: z.string().trim().max(40).default('whatsapp'),
      contacts: z.array(z.object({ name: z.string().trim().max(120).default(''), phone: z.string().trim().max(40) })).min(1).max(5000)
    }).strict(), req, res); if (!v) return;
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fp-import:'||$1))", [tid(req)]);
      const existing = new Set((await c.query('SELECT phone_key FROM customers WHERE tenant_id=$1 AND deleted_at IS NULL AND phone_key IS NOT NULL', [tid(req)])).rows.map(r => r.phone_key));
      const keys = (await c.query('SELECT fp_phone_key(p) k FROM unnest($1::text[]) WITH ORDINALITY AS t(p,i) ORDER BY i', [v.contacts.map(x => x.phone)])).rows.map(r => r.k);
      let created = 0, skippedExisting = 0, invalid = 0, repeated = 0; const seen = new Set();
      for (let i = 0; i < v.contacts.length; i++) {
        const key = keys[i], x = v.contacts[i];
        if (!key) { invalid++; continue; }
        if (seen.has(key)) { repeated++; continue; } seen.add(key);
        if (existing.has(key)) { skippedExisting++; continue; }
        let digits = phoneDigits(x.phone); if (digits.length >= 12 && digits.startsWith('55')) digits = digits.slice(2);
        const name = x.name.length >= 2 ? x.name : 'Contato ' + digits.slice(-4);
        await c.query('INSERT INTO customers(tenant_id,name,phone,source) VALUES($1,$2,$3,$4)', [tid(req), name, digits, v.source]);
        created++;
      }
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'import', 'customers', String(created)]);
      await c.query('COMMIT');
      res.status(201).json({ created, skipped_existing: skippedExisting, invalid, repeated_in_file: repeated, total: v.contacts.length });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));
}
