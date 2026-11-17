// Ordens de serviço (OS) da assistência técnica — só lojas do nicho "electronics" (ELITECH).
// Abas no painel: Orçamentos pendentes (quote) → Fila de serviços (queue) → Concluídos (done) → Entregues (delivered).
// Com valor e já aprovada, a OS tem uma venda "A receber": o caixa recebe por ela e a OS mostra "Pago".
// A garantia conta da entrega (ou da conclusão, se ainda não entregue) e sai impressa ou pelo WhatsApp da loja.
import { z } from 'zod';

const TZ = process.env.STORE_TIMEZONE || 'America/Fortaleza';
const cents = z.number().int().min(0).max(100000000);
const phoneDigits = v => String(v || '').replace(/\D/g, '');
const txt = n => z.string().trim().max(n);
const STATUSES = ['quote', 'queue', 'done', 'delivered'];

const fields = {
  device_type: txt(40), brand: txt(60), model: txt(80), serial: txt(60), color: txt(40), accessories: txt(200),
  condition: txt(500), problem: txt(500), service: txt(300), price_cents: cents,
  due_on: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]), warranty_days: z.number().int().min(0).max(3650),
  stage: txt(60), stage_note: txt(300)
};
const createSchema = z.object({
  customer_id: z.string().uuid().optional(),
  new_customer: z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().max(30).default('') }).strict().optional(),
  quote: z.boolean().default(false),
  ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()]))
}).strict();
const editSchema = z.object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()]))).strict();

export const deviceLabel = o => [o.brand, o.model].map(s => String(s || '').trim()).filter(Boolean).join(' ') || o.device_type || 'Aparelho';

export function registerServiceOrders(app, { q, db, route, bad, valid, audit, guard, owner, tid, uuid }) {
  // Só para a assistência técnica: as outras lojas (pet shop etc.) não veem nem usam.
  const electronics = route(async (req, res, next) => {
    const r = await q('SELECT niche FROM tenants WHERE id=$1', [tid(req)]);
    if (r.rows[0]?.niche !== 'electronics') return bad(res, 403, 'Ordem de serviço é só para assistência técnica');
    next();
  });
  const g = [...guard, electronics];
  const o = [...owner, electronics];

  const SELECT = `SELECT so.*,to_char(so.due_on,'YYYY-MM-DD') due_on,c.name customer_name,c.phone customer_phone,u.name created_by_name,
      ps.number pending_number,ps.total_cents pending_total_cents,ps.canceled_at pending_canceled_at,ps.paid_at,x.sale_number,x.id sale_id,
      CASE WHEN ps.paid_sale_id IS NOT NULL THEN 'paid' WHEN ps.id IS NOT NULL AND ps.canceled_at IS NULL THEN 'open' ELSE 'none' END pay_state,
      to_char(((coalesce(so.delivered_at,so.done_at)) AT TIME ZONE '${TZ.replace(/'/g, '')}')::date,'YYYY-MM-DD') warranty_from,
      to_char(((coalesce(so.delivered_at,so.done_at)) AT TIME ZONE '${TZ.replace(/'/g, '')}')::date+so.warranty_days,'YYYY-MM-DD') warranty_until
    FROM service_orders so JOIN customers c ON c.id=so.customer_id LEFT JOIN users u ON u.id=so.created_by
    LEFT JOIN pending_sales ps ON ps.id=so.pending_sale_id LEFT JOIN sales x ON x.id=ps.paid_sale_id`;
  const one = (id, client = { query: q }) => client.query(SELECT + ' WHERE so.id=$1', [id]).then(r => r.rows[0]);

  // Mantém a venda "A receber" igual à OS: cria quando há valor e o serviço foi aprovado, atualiza o valor
  // enquanto não foi paga e cancela se a OS sair do caixa (orçamento, recusado, cancelada ou valor zero).
  async function syncPending(c, tenant, os, userId) {
    const want = ['queue', 'done', 'delivered'].includes(os.status) && os.repaired && os.price_cents > 0;
    const p = os.pending_sale_id ? (await c.query('SELECT id,paid_sale_id,canceled_at,total_cents FROM pending_sales WHERE id=$1 FOR UPDATE', [os.pending_sale_id])).rows[0] : null;
    if (p?.paid_sale_id) return p.total_cents === os.price_cents || !want ? null : 'paid';
    const item = { service: `OS ${os.number} · ${os.service || os.problem || 'Serviço'}`.slice(0, 120), unit_price_cents: os.price_cents };
    const dev = deviceLabel(os).slice(0, 80); if (dev) item.device_model = dev;
    if (os.warranty_days) item.warranty_days = os.warranty_days;
    if (p && !p.canceled_at) {
      if (want) {
        const old = (await c.query('SELECT payload FROM pending_sales WHERE id=$1', [p.id])).rows[0].payload;
        await c.query('UPDATE pending_sales SET payload=$1,total_cents=$2,description=$3 WHERE id=$4', [JSON.stringify({ ...old, items: [item], description: 'OS ' + os.number }), os.price_cents, 'OS ' + os.number, p.id]);
      } else await c.query("UPDATE pending_sales SET canceled_at=now(),canceled_by=$2,cancel_reason=$3 WHERE id=$1", [p.id, userId, `OS ${os.number} saiu do caixa`]);
      return null;
    }
    if (!want) return null;
    await c.query("SELECT pg_advisory_xact_lock(hashtext('fp-pending:'||$1))", [tenant]);
    const n = (await c.query('SELECT coalesce(max(number),0)+1 n FROM pending_sales WHERE tenant_id=$1', [tenant])).rows[0].n;
    const payload = { customer_id: os.customer_id, seller_id: userId, items: [item], description: 'OS ' + os.number };
    const id = (await c.query(`INSERT INTO pending_sales(tenant_id,number,customer_id,seller_id,payload,total_cents,description,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$4) RETURNING id`, [tenant, n, os.customer_id, userId, JSON.stringify(payload), os.price_cents, 'OS ' + os.number])).rows[0].id;
    await c.query('UPDATE service_orders SET pending_sale_id=$1 WHERE id=$2', [id, os.id]);
    return null;
  }

  async function tx(res, fn) {
    const c = await db.connect();
    try { await c.query('BEGIN'); const out = await fn(c); if (out === undefined) await c.query('ROLLBACK'); else await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }

  app.get('/api/store/service-orders/settings', ...g, route(async (req, res) => {
    const r = await q(`SELECT name,address,city,state,whatsapp,os_warranty_days,os_warranty_terms,os_ready_message,os_quote_message FROM tenants WHERE id=$1`, [tid(req)]);
    res.set('Cache-Control', 'no-store'); res.json({ ...r.rows[0], timezone: TZ, role: req.user.role });
  }));
  app.patch('/api/store/service-orders/settings', ...o, route(async (req, res) => {
    const v = valid(z.object({ os_warranty_days: z.number().int().min(0).max(3650).optional(), os_warranty_terms: txt(1500).optional(),
      os_ready_message: txt(1000).optional(), os_quote_message: txt(1000).optional() }).strict(), req, res); if (!v) return;
    const keys = Object.keys(v); if (!keys.length) return bad(res, 400, 'Nada para salvar');
    await q(`UPDATE tenants SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1}`, [...keys.map(k => v[k]), tid(req)]);
    await audit(req, 'update', 'service_order_settings', tid(req)); res.json({ saved: true });
  }));

  // Lista de uma aba (quote, queue, done, delivered) e quantas há em cada aba aberta.
  app.get('/api/store/service-orders', ...g, route(async (req, res) => {
    const status = String(req.query.status || 'queue');
    if (!STATUSES.includes(status)) return bad(res, 400, 'Aba inválida');
    const term = String(req.query.q || '').trim().slice(0, 80), digits = phoneDigits(term);
    const order = status === 'queue' ? 'so.due_on NULLS LAST,so.created_at' : status === 'quote' ? 'so.created_at' : status === 'done' ? 'so.done_at DESC' : 'so.delivered_at DESC';
    const r = await q(SELECT + ` WHERE so.tenant_id=$1 AND so.status=$2 AND ($3='' OR fp_fold(c.name) LIKE '%'||fp_fold($3)||'%' OR fp_fold(so.brand||' '||so.model) LIKE '%'||fp_fold($3)||'%'
        OR so.number::text=$3 OR so.serial ILIKE '%'||$3||'%' OR ($4<>'' AND length($4)>=4 AND regexp_replace(coalesce(c.phone,''),'\\D','','g') LIKE '%'||$4||'%'))
      ORDER BY ${order} LIMIT ${status === 'delivered' ? 100 : 500}`, [tid(req), status, term, digits]);
    const counts = Object.fromEntries((await q(`SELECT status,count(*)::int n FROM service_orders WHERE tenant_id=$1 AND status IN ('quote','queue','done') GROUP BY 1`, [tid(req)])).rows.map(x => [x.status, x.n]));
    res.set('Cache-Control', 'no-store'); res.json({ status, counts: { quote: counts.quote || 0, queue: counts.queue || 0, done: counts.done || 0 }, rows: r.rows });
  }));
  app.get('/api/store/service-orders/:id', ...g, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'OS inválida');
    const os = await one(req.params.id); if (!os || os.tenant_id !== tid(req)) return bad(res, 404, 'OS não encontrada');
    res.set('Cache-Control', 'no-store'); res.json(os);
  }));

  app.post('/api/store/service-orders', ...g, route(async (req, res) => {
    const v = valid(createSchema, req, res); if (!v) return;
    if (!v.customer_id === !v.new_customer) return bad(res, 400, 'Escolha o cliente da OS');
    if (!v.quote && !(v.service || v.problem)) return bad(res, 400, 'Descreva o serviço ou o defeito');
    const out = await tx(res, async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fp-os:'||$1))", [tid(req)]);
      let customerId = v.customer_id;
      if (customerId && !(await c.query('SELECT 1 FROM customers WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [customerId, tid(req)])).rowCount) return void bad(res, 400, 'Cliente inválido');
      if (v.new_customer) {
        const phone = phoneDigits(v.new_customer.phone);
        const same = phone ? await c.query('SELECT id FROM customers WHERE tenant_id=$1 AND deleted_at IS NULL AND phone_key=fp_phone_key($2) ORDER BY created_at LIMIT 1', [tid(req), phone]) : { rowCount: 0 };
        customerId = same.rowCount ? same.rows[0].id : (await c.query("INSERT INTO customers(tenant_id,name,phone,source) VALUES($1,$2,$3,'caixa') RETURNING id", [tid(req), v.new_customer.name, phone || null])).rows[0].id;
      }
      const dflt = (await c.query('SELECT os_warranty_days FROM tenants WHERE id=$1', [tid(req)])).rows[0].os_warranty_days;
      const n = (await c.query('SELECT coalesce(max(number),0)+1 n FROM service_orders WHERE tenant_id=$1', [tid(req)])).rows[0].n;
      const keys = Object.keys(fields).filter(k => v[k] !== undefined && k !== 'warranty_days');
      const row = (await c.query(`INSERT INTO service_orders(tenant_id,number,customer_id,status,warranty_days,created_by${keys.map(k => ',' + k).join('')})
        VALUES($1,$2,$3,$4,$5,$6${keys.map((_, i) => ',$' + (i + 7)).join('')}) RETURNING *`,
        [tid(req), n, customerId, v.quote ? 'quote' : 'queue', v.warranty_days ?? dflt, req.user.id, ...keys.map(k => v[k])])).rows[0];
      await syncPending(c, tid(req), row, req.user.id);
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'create', 'service_order', row.id]);
      return row.id;
    });
    if (out) res.status(201).json(await one(out));
  }));

  app.patch('/api/store/service-orders/:id', ...g, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'OS inválida');
    const v = valid(editSchema, req, res); if (!v) return;
    const keys = Object.keys(v); if (!keys.length) return bad(res, 400, 'Nada para salvar');
    const out = await tx(res, async c => {
      const cur = (await c.query("SELECT * FROM service_orders WHERE id=$1 AND tenant_id=$2 AND status<>'canceled' FOR UPDATE", [req.params.id, tid(req)])).rows[0];
      if (!cur) return void bad(res, 404, 'OS não encontrada ou cancelada');
      const row = (await c.query(`UPDATE service_orders SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')},updated_at=now() WHERE id=$${keys.length + 1} RETURNING *`, [...keys.map(k => v[k]), cur.id])).rows[0];
      if (await syncPending(c, tid(req), row, req.user.id) === 'paid') return void bad(res, 409, 'Esta OS já foi paga no caixa: o valor não pode mudar.');
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'update', 'service_order', cur.id]);
      return cur.id;
    });
    if (out) res.json(await one(out));
  }));

  // Mudar de aba. quote→queue: orçamento aprovado. quote→done com repaired=false: recusado, devolver o aparelho.
  const MOVES = { quote: ['queue', 'done'], queue: ['done', 'quote'], done: ['delivered', 'queue'], delivered: ['done'] };
  app.post('/api/store/service-orders/:id/status', ...g, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'OS inválida');
    const v = valid(z.object({ status: z.enum(STATUSES), repaired: z.boolean().optional(), price_cents: cents.optional() }).strict(), req, res); if (!v) return;
    const out = await tx(res, async c => {
      const cur = (await c.query('SELECT * FROM service_orders WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [req.params.id, tid(req)])).rows[0];
      if (!cur || cur.status === 'canceled') return void bad(res, 404, 'OS não encontrada ou cancelada');
      if (!MOVES[cur.status].includes(v.status)) return void bad(res, 409, 'Esta OS já mudou de situação. Atualize a lista.');
      const repaired = cur.status === 'quote' && v.status === 'done' ? v.repaired === true : v.status === 'queue' ? true : cur.repaired;
      const stamp = { queue: cur.status === 'quote' ? ',quoted_at=now()' : '', done: cur.status !== 'delivered' ? ',done_at=now()' : '', delivered: ',delivered_at=now()', quote: '' }[v.status];
      const back = cur.status === 'delivered' ? ',delivered_at=NULL' : '';
      const row = (await c.query(`UPDATE service_orders SET status=$1,repaired=$2,price_cents=coalesce($3,price_cents),updated_at=now()${stamp}${back}${v.status === 'queue' ? ",stage=''" : ''} WHERE id=$4 RETURNING *`,
        [v.status, repaired, v.price_cents ?? null, cur.id])).rows[0];
      if (await syncPending(c, tid(req), row, req.user.id) === 'paid') return void bad(res, 409, 'Esta OS já foi paga no caixa: o valor não pode mudar.');
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'status_' + v.status, 'service_order', cur.id]);
      return cur.id;
    });
    if (out) res.json(await one(out));
  }));
  // Registra que o cliente foi avisado pelo WhatsApp (a lista mostra "avisado às …").
  app.post('/api/store/service-orders/:id/notified', ...g, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'OS inválida');
    const r = await q('UPDATE service_orders SET notified_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING id', [req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'OS não encontrada'); res.json(await one(req.params.id));
  }));
  app.post('/api/store/service-orders/:id/cancel', ...g, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'OS inválida');
    const v = valid(z.object({ reason: z.string().trim().min(3).max(200) }).strict(), req, res); if (!v) return;
    const out = await tx(res, async c => {
      const cur = (await c.query("SELECT * FROM service_orders WHERE id=$1 AND tenant_id=$2 AND status NOT IN ('canceled','delivered') FOR UPDATE", [req.params.id, tid(req)])).rows[0];
      if (!cur) return void bad(res, 409, 'OS já entregue ou cancelada. Atualize a lista.');
      if (cur.pending_sale_id && (await c.query('SELECT 1 FROM pending_sales WHERE id=$1 AND paid_sale_id IS NOT NULL', [cur.pending_sale_id])).rowCount) return void bad(res, 409, 'Esta OS já foi paga no caixa. Cancele a venda no caixa antes.');
      const row = (await c.query("UPDATE service_orders SET status='canceled',canceled_at=now(),cancel_reason=$2,updated_at=now() WHERE id=$1 RETURNING *", [cur.id, v.reason])).rows[0];
      await syncPending(c, tid(req), row, req.user.id);
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'cancel', 'service_order', cur.id]);
      return cur.id;
    });
    if (out) res.json({ canceled: true });
  }));
}
