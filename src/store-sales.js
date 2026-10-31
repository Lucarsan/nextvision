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

  async function cashSummary(tenant, sessionId, client = { query: q }) {
    const totals = await client.query(`SELECT payment_method,count(*)::int n,coalesce(sum(total_cents),0)::bigint total
      FROM sales WHERE session_id=$1 AND tenant_id=$2 AND canceled_at IS NULL GROUP BY payment_method`, [sessionId, tenant]);
    const moves = await client.query(`SELECT kind,method,count(*)::int n,coalesce(sum(amount_cents),0)::bigint total FROM cash_movements
      WHERE session_id=$1 AND tenant_id=$2 AND canceled_at IS NULL GROUP BY kind,method`, [sessionId, tenant]);
    const s = await client.query('SELECT opening_cents FROM cash_sessions WHERE id=$1', [sessionId]);
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
      expected_cash_cents: opening + (by.cash?.total_cents || 0) + sum('deposit') - sum('withdrawal') - (expensesBy.cash?.total_cents || 0)
    };
  }

  async function sessionDetail(tenant, sessionId) {
    const sales = await q(`SELECT x.id,x.sale_number,x.total_cents,x.payment_method,x.description,x.created_at,x.canceled_at,x.cancel_reason,
        x.customer_id,c.name customer_name,c.phone customer_phone,o.order_number,u.name created_by_name,uc.name canceled_by_name,COALESCE(sl.name,u.name) seller_name,
        COALESCE((SELECT json_agg(json_build_object('name',i.name || COALESCE(' ' || i.variant_name,''),'barcode',i.barcode,'quantity',i.quantity,'unit_price_cents',i.unit_price_cents,'total_cents',i.total_cents) ORDER BY i.position)
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
      loyalty_min_sale_cents,status_message,offer_message,name,slug FROM tenants WHERE id=$1`, [tid(req)]);
    const t = r.rows[0] || {};
    if (!t.sales_enabled) return res.json({ enabled: false });
    const { sales_enabled, ...rest } = t;
    res.json({ enabled: true, timezone: TZ, role: req.user.role, access_level: req.user.access_level, ...rest });
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
    res.json(r.rows.map(x => ({ ...x, loyalty: progress.get(x.id) })));
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
  const productFields = 'id,name,barcode,price_cents,cost_cents,stock_qty,generated_barcode,ask_variant,restock_pending,active,updated_at';
  // Entrada no estoque (compra): guarda quantidade e custo para o relatório de compras.
  const ledger = (cq, tenant, productId, variantId, kind, quantity, unitCost, saleId, userId) => cq(`INSERT INTO stock_movements(tenant_id,product_id,variant_id,kind,quantity,unit_cost_cents,sale_id,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [tenant, productId, variantId, kind, quantity, unitCost ?? null, saleId ?? null, userId ?? null]);
  const restockRows = async tenant => (await q(`SELECT p.id product_id,NULL::uuid variant_id,p.name,NULL::text variant,p.restock_pending pending,p.stock_qty,p.cost_cents,p.barcode
      FROM products p WHERE p.tenant_id=$1 AND p.active AND NOT p.ask_variant AND p.restock_pending>0
    UNION ALL
    SELECT p.id,v.id,p.name,v.name,v.restock_pending,v.stock_qty,p.cost_cents,p.barcode
      FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.tenant_id=$1 AND p.active AND v.active AND v.restock_pending>0
    ORDER BY 3,4`, [tenant])).rows;
  // Modelo de um produto com modelos: acha pelo nome (sem diferenciar maiúsculas) ou cria.
  const upsertVariant = async (cq, tenant, productId, name) => (await cq(`INSERT INTO product_variants(tenant_id,product_id,name) VALUES($1,$2,$3)
    ON CONFLICT (product_id, lower(name)) DO UPDATE SET active=true RETURNING id,name,stock_qty,restock_pending`, [tenant, productId, name.trim().replace(/\s+/g, ' ')])).rows[0];
  const stockQty = z.number().int().min(-999999).max(999999);
  // Código interno EAN-13 começando com 2 (faixa reservada para uso dentro da loja; não colide com códigos de fábrica).
  const ean13 = body12 => { let sum = 0; for (let i = 0; i < 12; i++) sum += Number(body12[i]) * (i % 2 ? 3 : 1); return body12 + ((10 - (sum % 10)) % 10); };
  const productBody = z.object({
    name: z.string().trim().min(2).max(120),
    barcode: z.union([z.literal(''), z.string().trim().regex(/^[!-~]{3,64}$/, 'Código de barras inválido')]).optional(),
    price_cents: cents,
    cost_cents: cents.nullable().optional(),
    stock_qty: stockQty.nullable().optional(),
    ask_variant: z.boolean().optional()
  }).strict();
  const dupBarcode = (e, res) => { if (e.code === '23505') { bad(res, 409, 'Já existe um produto com este código de barras'); return true; } return false; };

  app.get('/api/store/products', ...guard, route(async (req, res) => {
    const term = String(req.query.q || '').trim().slice(0, 80);
    const r = await q(`SELECT ${productFields} FROM products WHERE tenant_id=$1 AND active AND
        ($2='' OR fp_fold(name) LIKE '%'||fp_fold($2)||'%' OR barcode=$2)
      ORDER BY (barcode=$2) DESC NULLS LAST,name LIMIT 500`, [tid(req), term]);
    res.set('Cache-Control', 'no-store'); res.json(r.rows);
  }));
  app.get('/api/store/products/barcode/:code', ...guard, route(async (req, res) => {
    const code = String(req.params.code || '').trim();
    if (!/^[!-~]{3,64}$/.test(code)) return bad(res, 400, 'Código de barras inválido');
    const r = await q(`SELECT ${productFields} FROM products WHERE tenant_id=$1 AND active AND barcode=$2`, [tid(req), code]);
    if (!r.rowCount) return bad(res, 404, 'Produto não cadastrado');
    res.set('Cache-Control', 'no-store'); res.json(r.rows[0]);
  }));
  app.post('/api/store/products', ...guard, route(async (req, res) => {
    const v = valid(productBody, req, res); if (!v) return;
    try {
      const r = await q(`INSERT INTO products(tenant_id,name,barcode,price_cents,cost_cents,stock_qty,ask_variant,created_by) VALUES($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8) RETURNING ${productFields}`,
        [tid(req), v.name, v.barcode || '', v.price_cents, v.cost_cents ?? null, v.ask_variant ? null : v.stock_qty ?? null, !!v.ask_variant, req.user.id]);
      if (!v.ask_variant && v.stock_qty > 0) await ledger(q, tid(req), r.rows[0].id, null, 'entry', v.stock_qty, v.cost_cents, null, req.user.id);
      await audit(req, 'create', 'product', r.rows[0].id); res.status(201).json(r.rows[0]);
    } catch (e) { if (!dupBarcode(e, res)) throw e; }
  }));
  app.patch('/api/store/products/:id', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Produto inválido');
    const v = valid(productBody.partial().strict(), req, res); if (!v) return;
    try {
      const r = await q(`UPDATE products SET name=COALESCE($1,name),
          barcode=CASE WHEN $2::text IS NULL THEN barcode ELSE NULLIF($2,'') END,
          price_cents=COALESCE($3,price_cents),
          cost_cents=CASE WHEN $6 THEN $7::int ELSE cost_cents END,
          stock_qty=CASE WHEN $8 THEN $9::int ELSE stock_qty END,
          ask_variant=COALESCE($10,ask_variant),updated_at=now()
        WHERE id=$4 AND tenant_id=$5 AND active RETURNING ${productFields}`, [v.name ?? null, v.barcode ?? null, v.price_cents ?? null, req.params.id, tid(req),
        'cost_cents' in v, v.cost_cents ?? null, 'stock_qty' in v, v.stock_qty ?? null, v.ask_variant ?? null]);
      if (!r.rowCount) return bad(res, 404, 'Produto não encontrado');
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
        await ledger(q, tid(req), r.rows[0].id, null, 'entry', v.quantity, v.cost_cents, null, req.user.id);
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
      await ledger(cq, tid(req), p.id, variant?.id || null, v.add > 0 ? 'entry' : 'adjust', v.add, v.add > 0 ? cost : null, null, req.user.id);
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
    const r = await q('UPDATE product_variants SET active=false WHERE id=$1 AND product_id=$2 AND tenant_id=$3 RETURNING id', [req.params.vid, req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'Modelo não encontrado');
    res.json({ deleted: true });
  }));
  // Reposição: o que foi vendido e ainda não teve entrada de estoque, por produto e por modelo.
  app.get('/api/store/stock/restock', ...guard, route(async (req, res) => {
    res.set('Cache-Control', 'no-store'); res.json(await restockRows(tid(req)));
  }));
  // Excluir só desativa: vendas antigas continuam com nome e preço do item.
  app.delete('/api/store/products/:id', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Produto inválido');
    const r = await q('UPDATE products SET active=false,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND active RETURNING id', [req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'Produto não encontrado');
    await audit(req, 'delete', 'product', req.params.id); res.json({ deleted: true });
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
        z.object({ name: z.string().trim().min(1).max(120), quantity: z.number().int().min(1).max(9999), unit_price_cents: cents }).strict()
      ])).min(1).max(200).optional(),
      discount_cents: cents.optional(),
      seller_id: uuid.optional(),
      payment_method: z.enum(['cash', 'pix', 'debit', 'credit', 'other']),
      description: z.string().trim().max(300).default(''),
      order_id: uuid.optional()
    }).strict(), req, res); if (!v) return;
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
        for (const it of v.items) {
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
        if (!description) description = items.map(x => (x.quantity > 1 ? x.quantity + 'x ' : '') + x.name + (x.variant ? ' ' + x.variant : '')).join(', ').slice(0, 300);
      }
      const n = (await c.query('SELECT coalesce(max(sale_number),0)+1 n FROM sales WHERE tenant_id=$1', [tid(req)])).rows[0].n;
      const sale = (await c.query(`INSERT INTO sales(tenant_id,session_id,sale_number,customer_id,order_id,total_cents,discount_cents,payment_method,description,created_by,seller_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [tid(req), s.rows[0].id, n, customerId, v.order_id || null, total, v.items ? v.discount_cents || 0 : 0, v.payment_method, description, req.user.id, sellerId])).rows[0];
      const cq = (sql, params) => c.query(sql, params);
      for (const x of items) {
        const vr = x.vid ? { id: x.vid } : null;
        await c.query(`INSERT INTO sale_items(tenant_id,sale_id,product_id,name,barcode,quantity,unit_price_cents,total_cents,position,unit_cost_cents,list_price_cents,variant_id,variant_name)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [tid(req), sale.id, x.id, x.name, x.barcode, x.quantity, x.unit_price_cents, x.total_cents, x.position, x.cost_cents, x.list_price_cents, vr?.id || null, x.variant || null]);
        if (!x.id) continue;
        // Baixa no estoque (do modelo, ou do produto quando controla estoque) e marca para reposição.
        if (vr) await c.query('UPDATE product_variants SET stock_qty=CASE WHEN stock_qty IS NULL THEN NULL ELSE GREATEST(-999999,stock_qty-$1) END,restock_pending=restock_pending+$1,sold_count=sold_count+$1,last_sold_at=now() WHERE id=$2', [x.quantity, vr.id]);
        else await c.query('UPDATE products SET stock_qty=CASE WHEN stock_qty IS NULL THEN NULL ELSE GREATEST(-999999,stock_qty-$1) END,restock_pending=restock_pending+$1,updated_at=now() WHERE id=$2 AND tenant_id=$3', [x.quantity, x.id, tid(req)]);
        await ledger(cq, tid(req), x.id, vr?.id || null, 'sale', -x.quantity, x.cost_cents, sale.id, req.user.id);
      }
      sale.items = items.map(({ id, name, variant, barcode, quantity, unit_price_cents, list_price_cents, total_cents }) => ({ product_id: id, name, variant_name: variant || null, barcode, quantity, unit_price_cents, list_price_cents, total_cents }));
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
      res.status(201).json({ sale, customer, customer_created: created, loyalty_counted: counted, loyalty: progress });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // Comprovante de uma venda (impressora térmica 80 mm). Não é documento fiscal.
  app.get('/api/store/sales/:id/receipt', ...guard, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Venda inválida');
    const r = await q(`SELECT x.id,x.sale_number,x.total_cents,x.discount_cents,x.payment_method,x.description,x.created_at,x.canceled_at,x.cancel_reason,x.customer_id,
        c.name customer_name,c.phone customer_phone,o.order_number,u.name created_by_name,COALESCE(sl.name,u.name) seller_name,
        t.name store_name,t.city,t.state,t.whatsapp,
        COALESCE((SELECT json_agg(json_build_object('name',i.name || COALESCE(' ' || i.variant_name,''),'quantity',i.quantity,'unit_price_cents',i.unit_price_cents,'list_price_cents',i.list_price_cents,'total_cents',i.total_cents) ORDER BY i.position)
          FROM sale_items i WHERE i.sale_id=x.id),'[]'::json) items
      FROM sales x JOIN tenants t ON t.id=x.tenant_id LEFT JOIN customers c ON c.id=x.customer_id LEFT JOIN orders o ON o.id=x.order_id JOIN users u ON u.id=x.created_by LEFT JOIN users sl ON sl.id=x.seller_id
      WHERE x.id=$1 AND x.tenant_id=$2`, [req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'Venda não encontrada');
    const sale = r.rows[0];
    const loyalty = sale.customer_id && !sale.canceled_at ? (await progressFor(tid(req), [sale.customer_id])).get(sale.customer_id) : null;
    res.set('Cache-Control', 'no-store'); res.json({ ...sale, timezone: TZ, generated_at: new Date().toISOString(), loyalty: loyalty?.enabled ? loyalty : null });
  }));

  app.post('/api/store/sales/:id/cancel', ...full, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Venda inválida');
    const v = valid(z.object({ reason: z.string().trim().min(3).max(200) }).strict(), req, res); if (!v) return;
    const c = await db.connect();
    try {
      await c.query('BEGIN');
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
      await c.query(`INSERT INTO stock_movements(tenant_id,product_id,variant_id,kind,quantity,unit_cost_cents,sale_id,created_by)
        SELECT tenant_id,product_id,variant_id,'cancel',quantity,unit_cost_cents,sale_id,$2 FROM sale_items WHERE sale_id=$1 AND product_id IS NOT NULL`, [req.params.id, req.user.id]);
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
      FROM customers c WHERE c.tenant_id=$1 AND c.deleted_at IS NULL AND NOT c.offers_opt_out AND c.phone_key IS NOT NULL
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
