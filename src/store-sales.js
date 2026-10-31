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

  async function cashSummary(tenant, sessionId, client = { query: q }) {
    const totals = await client.query(`SELECT payment_method,count(*)::int n,coalesce(sum(total_cents),0)::bigint total
      FROM sales WHERE session_id=$1 AND tenant_id=$2 AND canceled_at IS NULL GROUP BY payment_method`, [sessionId, tenant]);
    const moves = await client.query(`SELECT kind,coalesce(sum(amount_cents),0)::bigint total FROM cash_movements WHERE session_id=$1 AND tenant_id=$2 GROUP BY kind`, [sessionId, tenant]);
    const s = await client.query('SELECT opening_cents FROM cash_sessions WHERE id=$1', [sessionId]);
    const by = Object.fromEntries(totals.rows.map(r => [r.payment_method, { count: r.n, total_cents: Number(r.total) }]));
    const mv = Object.fromEntries(moves.rows.map(r => [r.kind, Number(r.total)]));
    const opening = s.rows[0]?.opening_cents || 0;
    const cashSales = by.cash?.total_cents || 0;
    return {
      by_method: by,
      sales_count: totals.rows.reduce((a, r) => a + r.n, 0),
      sales_total_cents: totals.rows.reduce((a, r) => a + Number(r.total), 0),
      opening_cents: opening, deposits_cents: mv.deposit || 0, withdrawals_cents: mv.withdrawal || 0,
      expected_cash_cents: opening + cashSales + (mv.deposit || 0) - (mv.withdrawal || 0)
    };
  }

  // ---------- Configuração ----------
  app.get('/api/store/sales/config', ...staff, route(async (req, res) => {
    const r = await q(`SELECT sales_enabled,google_review_url,loyalty_enabled,loyalty_target,loyalty_reward,loyalty_rules,
      loyalty_min_sale_cents,status_message,offer_message,name,slug FROM tenants WHERE id=$1`, [tid(req)]);
    const t = r.rows[0] || {};
    if (!t.sales_enabled) return res.json({ enabled: false });
    const { sales_enabled, ...rest } = t;
    res.json({ enabled: true, timezone: TZ, role: req.user.role, ...rest });
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
    const sales = await q(`SELECT x.id,x.sale_number,x.total_cents,x.payment_method,x.description,x.created_at,x.canceled_at,x.cancel_reason,
        x.customer_id,c.name customer_name,c.phone customer_phone,o.order_number,u.name created_by_name
      FROM sales x LEFT JOIN customers c ON c.id=x.customer_id LEFT JOIN orders o ON o.id=x.order_id JOIN users u ON u.id=x.created_by
      WHERE x.session_id=$1 AND x.tenant_id=$2 ORDER BY x.created_at DESC,x.sale_number DESC`, [s.id, tid(req)]);
    const moves = await q(`SELECT m.id,m.kind,m.amount_cents,m.note,m.created_at,u.name created_by_name FROM cash_movements m JOIN users u ON u.id=m.created_by
      WHERE m.session_id=$1 AND m.tenant_id=$2 ORDER BY m.created_at DESC`, [s.id, tid(req)]);
    res.json({ session: s, sales: sales.rows, movements: moves.rows, summary: await cashSummary(tid(req), s.id), last_closed: last.rows[0] || null });
  }));

  app.post('/api/store/cash/open', ...guard, route(async (req, res) => {
    const v = valid(z.object({ opening_cents: cents.default(0) }).strict(), req, res); if (!v) return;
    try {
      const r = await q(`INSERT INTO cash_sessions(tenant_id,opening_cents,opened_by) VALUES($1,$2,$3) RETURNING *`, [tid(req), v.opening_cents, req.user.id]);
      await audit(req, 'open', 'cash_session', r.rows[0].id); res.status(201).json(r.rows[0]);
    } catch (e) { if (e.code === '23505') return bad(res, 409, 'O caixa já está aberto'); throw e; }
  }));

  app.post('/api/store/cash/movements', ...guard, route(async (req, res) => {
    const v = valid(z.object({ kind: z.enum(['withdrawal', 'deposit']), amount_cents: cents.min(1), note: z.string().trim().max(200).default('') }).strict(), req, res); if (!v) return;
    const r = await q(`INSERT INTO cash_movements(tenant_id,session_id,kind,amount_cents,note,created_by)
      SELECT $1,s.id,$2,$3,$4,$5 FROM cash_sessions s WHERE s.tenant_id=$1 AND s.status='open' RETURNING *`, [tid(req), v.kind, v.amount_cents, v.note, req.user.id]);
    if (!r.rowCount) return bad(res, 409, 'Abra o caixa primeiro');
    await audit(req, v.kind, 'cash_movement', r.rows[0].id); res.status(201).json(r.rows[0]);
  }));

  app.post('/api/store/cash/close', ...guard, route(async (req, res) => {
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
        (SELECT count(*)::int FROM sales x WHERE x.session_id=s.id AND x.canceled_at IS NULL AND x.customer_id IS NOT NULL) linked_count
      FROM cash_sessions s JOIN users uo ON uo.id=s.opened_by LEFT JOIN users uc ON uc.id=s.closed_by
      WHERE s.tenant_id=$1 ORDER BY s.opened_at DESC LIMIT 30`, [tid(req)]);
    res.json(r.rows.map(x => ({ ...x, sales_total_cents: Number(x.sales_total_cents) })));
  }));

  // ---------- Clientes (busca rápida no caixa) ----------
  app.get('/api/store/sales/customers', ...guard, route(async (req, res) => {
    const term = String(req.query.q || '').trim().slice(0, 80);
    if (term.length < 2) return res.json([]);
    const digits = phoneDigits(term);
    const r = await q(`SELECT id,name,phone,offers_opt_out FROM customers WHERE tenant_id=$1 AND
        (fp_fold(name) LIKE '%'||fp_fold($2)||'%' OR ($3<>'' AND length($3)>=4 AND regexp_replace(coalesce(phone,''),'\\D','','g') LIKE '%'||$3||'%'))
      ORDER BY (fp_fold(name) LIKE fp_fold($2)||'%') DESC,name LIMIT 12`, [tid(req), term, digits]);
    const progress = await progressFor(tid(req), r.rows.map(x => x.id));
    res.json(r.rows.map(x => ({ ...x, loyalty: progress.get(x.id) })));
  }));

  app.get('/api/store/sales/customers/:id', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Cliente inválido');
    const c = await q('SELECT id,name,phone,offers_opt_out FROM customers WHERE id=$1 AND tenant_id=$2', [req.params.id, tid(req)]);
    if (!c.rowCount) return bad(res, 404, 'Cliente não encontrado');
    const orders = await q(`SELECT o.id,o.order_number,o.status,o.created_at,o.process_snapshot->>'name' process,o.details
      FROM orders o WHERE o.tenant_id=$1 AND o.customer_id=$2 AND o.deleted_at IS NULL AND o.created_at>now()-interval '60 days'
      AND NOT EXISTS(SELECT 1 FROM sales s WHERE s.order_id=o.id AND s.canceled_at IS NULL) ORDER BY o.created_at DESC LIMIT 8`, [tid(req), req.params.id]);
    const recent = await q(`SELECT sale_number,total_cents,payment_method,description,created_at FROM sales WHERE tenant_id=$1 AND customer_id=$2 AND canceled_at IS NULL ORDER BY created_at DESC LIMIT 5`, [tid(req), req.params.id]);
    const progress = await progressFor(tid(req), [req.params.id]);
    res.json({ ...c.rows[0], loyalty: progress.get(req.params.id), orders: orders.rows, recent_sales: recent.rows });
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
      const cust = await c.query('SELECT id FROM customers WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [req.params.id, tid(req)]);
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

  // ---------- Vendas ----------
  app.post('/api/store/sales', ...guard, route(async (req, res) => {
    const v = valid(z.object({
      customer_id: uuid.optional(),
      new_customer: z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().max(30).default('') }).optional(),
      anonymous: z.boolean().default(false),
      total_cents: cents.min(1),
      payment_method: z.enum(['cash', 'pix', 'debit', 'credit', 'other']),
      description: z.string().trim().max(300).default(''),
      order_id: uuid.optional()
    }).strict(), req, res); if (!v) return;
    if ([v.customer_id, v.new_customer, v.anonymous || undefined].filter(Boolean).length !== 1) return bad(res, 400, 'Escolha o cliente da venda');
    if (v.order_id && !v.customer_id) return bad(res, 400, 'Pedido exige cliente');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fp-sale:'||$1))", [tid(req)]);
      const s = await c.query(`SELECT id FROM cash_sessions WHERE tenant_id=$1 AND status='open'`, [tid(req)]);
      if (!s.rowCount) { await c.query('ROLLBACK'); return bad(res, 409, 'Abra o caixa antes de registrar vendas'); }
      let customerId = v.customer_id || null, created = false;
      if (customerId && !(await c.query('SELECT 1 FROM customers WHERE id=$1 AND tenant_id=$2', [customerId, tid(req)])).rowCount) { await c.query('ROLLBACK'); return bad(res, 400, 'Cliente inválido'); }
      if (v.new_customer) {
        const phone = v.new_customer.phone ? phoneDigits(v.new_customer.phone) : '';
        const same = phone ? await c.query('SELECT id FROM customers WHERE tenant_id=$1 AND phone_key=fp_phone_key($2) ORDER BY created_at LIMIT 1', [tid(req), phone]) : { rowCount: 0 };
        if (same.rowCount) customerId = same.rows[0].id;
        else { customerId = (await c.query("INSERT INTO customers(tenant_id,name,phone,source) VALUES($1,$2,$3,'caixa') RETURNING id", [tid(req), v.new_customer.name, phone || null])).rows[0].id; created = true; }
      }
      if (v.order_id && !(await c.query('SELECT 1 FROM orders WHERE id=$1 AND tenant_id=$2 AND customer_id=$3 AND deleted_at IS NULL', [v.order_id, tid(req), customerId])).rowCount) { await c.query('ROLLBACK'); return bad(res, 400, 'Pedido não pertence a este cliente'); }
      const n = (await c.query('SELECT coalesce(max(sale_number),0)+1 n FROM sales WHERE tenant_id=$1', [tid(req)])).rows[0].n;
      const sale = (await c.query(`INSERT INTO sales(tenant_id,session_id,sale_number,customer_id,order_id,total_cents,payment_method,description,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [tid(req), s.rows[0].id, n, customerId, v.order_id || null, v.total_cents, v.payment_method, v.description, req.user.id])).rows[0];
      // Pagamento de um pedido de serviço não soma de novo: o pedido já conta ao ser concluído.
      let counted = false;
      if (customerId && !v.order_id) {
        const ck = await c.query(`INSERT INTO loyalty_checkins(tenant_id,customer_id,sale_id) SELECT $1,$2,$3
          WHERE EXISTS(SELECT 1 FROM tenants WHERE id=$1 AND loyalty_enabled AND $4>=loyalty_min_sale_cents) RETURNING id`, [tid(req), customerId, sale.id, v.total_cents]);
        counted = ck.rowCount > 0;
      }
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'create', 'sale', sale.id]);
      await c.query('COMMIT');
      const progress = customerId ? (await progressFor(tid(req), [customerId])).get(customerId) : null;
      const customer = customerId ? (await q('SELECT id,name,phone,offers_opt_out FROM customers WHERE id=$1', [customerId])).rows[0] : null;
      res.status(201).json({ sale, customer, customer_created: created, loyalty_counted: counted, loyalty: progress });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  app.post('/api/store/sales/:id/cancel', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Venda inválida');
    const v = valid(z.object({ reason: z.string().trim().min(3).max(200) }).strict(), req, res); if (!v) return;
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const s = await c.query(`SELECT x.id FROM sales x JOIN cash_sessions s ON s.id=x.session_id WHERE x.id=$1 AND x.tenant_id=$2 AND x.canceled_at IS NULL AND s.status='open' FOR UPDATE OF x`, [req.params.id, tid(req)]);
      if (!s.rowCount) { await c.query('ROLLBACK'); return bad(res, 409, 'Só é possível cancelar vendas do caixa aberto'); }
      await c.query('UPDATE sales SET canceled_at=now(),canceled_by=$1,cancel_reason=$2 WHERE id=$3', [req.user.id, v.reason, req.params.id]);
      const removed = await c.query('DELETE FROM loyalty_checkins WHERE sale_id=$1 AND redemption_id IS NULL', [req.params.id]);
      const kept = await c.query('SELECT 1 FROM loyalty_checkins WHERE sale_id=$1', [req.params.id]);
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'cancel', 'sale', req.params.id]);
      await c.query('COMMIT');
      res.json({ canceled: true, loyalty_removed: removed.rowCount > 0, loyalty_already_redeemed: kept.rowCount > 0 });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // ---------- Mensagens do dia ----------
  // Clientes que compraram no dia (vendas do caixa e pedidos concluídos), com progresso
  // do cartão e se já receberam o status depois da compra.
  app.get('/api/store/messages/status', ...guard, route(async (req, res) => {
    const day = dayField.safeParse(req.query.day).success ? req.query.day : null;
    const r = await q(`WITH buys AS (
        SELECT x.customer_id,x.created_at at,x.total_cents,'sale' kind,x.sale_number::text ref,x.description
          FROM sales x WHERE x.tenant_id=$1 AND x.customer_id IS NOT NULL AND x.canceled_at IS NULL
          AND (x.created_at AT TIME ZONE $3)::date=COALESCE($2::date,(now() AT TIME ZONE $3)::date)
        UNION ALL
        SELECT o.customer_id,o.completed_at,NULL,'order',o.order_number::text,o.process_snapshot->>'name'
          FROM orders o WHERE o.tenant_id=$1 AND o.customer_id IS NOT NULL AND o.status='completed' AND o.deleted_at IS NULL
          AND (o.completed_at AT TIME ZONE $3)::date=COALESCE($2::date,(now() AT TIME ZONE $3)::date)
      )
      SELECT c.id,c.name,c.phone,c.offers_opt_out,max(b.at) last_buy,
        json_agg(json_build_object('kind',b.kind,'ref',b.ref,'total_cents',b.total_cents,'description',b.description,'at',b.at) ORDER BY b.at) purchases,
        (SELECT max(m.created_at) FROM customer_messages m WHERE m.tenant_id=c.tenant_id AND m.customer_id=c.id AND m.kind='status') last_status_at
      FROM buys b JOIN customers c ON c.id=b.customer_id AND c.tenant_id=$1
      GROUP BY c.id ORDER BY max(b.at) DESC`, [tid(req), day, TZ]);
    const progress = await progressFor(tid(req), r.rows.map(x => x.id));
    res.set('Cache-Control', 'no-store');
    res.json({
      day: day || (await q(`SELECT to_char(now() AT TIME ZONE $1,'YYYY-MM-DD') d`, [TZ])).rows[0].d,
      customers: r.rows.map(x => ({ ...x, loyalty: progress.get(x.id), sent: !!x.last_status_at && new Date(x.last_status_at) >= new Date(x.last_buy) }))
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
      FROM customers c WHERE c.tenant_id=$1 AND NOT c.offers_opt_out AND c.phone_key IS NOT NULL
      ORDER BY c.name`, [tid(req), campaign]);
    let rows = r.rows;
    if (Number.isInteger(days) && days > 0) { const since = Date.now() - days * 86400000; rows = rows.filter(x => x.last_buy && new Date(x.last_buy).getTime() >= since); }
    res.set('Cache-Control', 'no-store'); res.json(rows);
  }));

  app.post('/api/store/messages/sent', ...guard, route(async (req, res) => {
    const v = valid(z.object({ customer_id: uuid, kind: z.enum(['status', 'offer']), campaign: z.string().trim().max(64).optional() }).strict(), req, res); if (!v) return;
    if (v.kind === 'offer' && !v.campaign) return bad(res, 400, 'Oferta sem identificação');
    const r = await q(`INSERT INTO customer_messages(tenant_id,customer_id,kind,campaign,created_by)
      SELECT $1,c.id,$3,$4,$5 FROM customers c WHERE c.id=$2 AND c.tenant_id=$1 RETURNING id,created_at`, [tid(req), v.customer_id, v.kind, v.campaign || null, req.user.id]);
    if (!r.rowCount) return bad(res, 404, 'Cliente não encontrado');
    res.status(201).json(r.rows[0]);
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
      const existing = new Set((await c.query('SELECT phone_key FROM customers WHERE tenant_id=$1 AND phone_key IS NOT NULL', [tid(req)])).rows.map(r => r.phone_key));
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
