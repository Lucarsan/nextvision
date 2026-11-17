// Cobrança Pix pela InfinitePay (Checkout Integrado), por loja.
// - A loja só tem o recurso se o servidor tiver a chave dela: INFINITEPAY_KEY_<SLUG> (e, se quiser,
//   INFINITEPAY_HANDLE_<SLUG> com a InfiniteTag sem "$"). SLUG = slug da loja em maiúsculas, com "_" no
//   lugar do que não for letra ou número (ex.: elias-tech → INFINITEPAY_KEY_ELIAS_TECH).
// - O painel manda o corpo da venda; o servidor cria o link na InfinitePay (valor, order_nsu = id da
//   cobrança, webhook com token próprio) e devolve o QR desse link.
// - A InfinitePay chama o webhook; o aviso não tem assinatura, então o pagamento só vale depois de
//   conferido no /payment_check. Aí a venda é registrada (forma Pix) com o corpo guardado.
// - Os dados de cartão e o código Pix ficam na página da InfinitePay; aqui não passa nada disso.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

const API = () => (process.env.INFINITEPAY_API_URL || 'https://api.checkout.infinitepay.io').replace(/\/$/, '');
const BASE = () => (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const envName = slug => String(slug || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
export const infinitePayEnvNames = slug => ({ key: 'INFINITEPAY_KEY_' + envName(slug), handle: 'INFINITEPAY_HANDLE_' + envName(slug) });
export function infinitePayAccount(slug) {
  const n = infinitePayEnvNames(slug), key = (process.env[n.key] || '').trim();
  if (!slug || !key) return null;
  return { key, handle: (process.env[n.handle] || '').trim().replace(/^\$/, '') || null };
}
// Token do webhook de cada cobrança (sem ele, o aviso é ignorado). Derivado do JWT_SECRET.
export const webhookToken = id => crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev').update('infinitepay:' + id).digest('base64url');
const sameToken = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const brl = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function call(path, account, body) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(API() + path, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'X-Api-Key': account.key }, body: JSON.stringify(body) });
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { /* resposta não-JSON */ }
    if (!r.ok) { const e = new Error(`InfinitePay ${path} respondeu ${r.status}`); e.status = r.status; e.detail = (data && (data.message || data.error)) || text.slice(0, 200); throw e; }
    return data || {};
  } finally { clearTimeout(timer); }
}

export function registerInfinitePay(app, { q, route, bad, valid, audit, guard, tid, saleSchema, createSale }) {
  const accountOf = async tenant => {
    const t = (await q('SELECT slug FROM tenants WHERE id=$1', [tenant])).rows[0];
    return t ? infinitePayAccount(t.slug) : null;
  };
  const view = c => c && ({ id: c.id, status: c.status, amount_cents: c.amount_cents, description: c.description, checkout_url: c.checkout_url, sale_id: c.sale_id,
    paid_at: c.paid_at, paid_amount_cents: c.paid_amount_cents, capture_method: c.capture_method, receipt_url: c.receipt_url, created_at: c.created_at,
    customer_name: c.customer_name || c.sale_body?.new_customer?.name || null, created_by_name: c.created_by_name || null });
  const SELECT = `SELECT p.*,c.name customer_name,u.name created_by_name FROM pix_charges p
    LEFT JOIN customers c ON c.id=(p.sale_body->>'customer_id')::uuid AND c.tenant_id=p.tenant_id LEFT JOIN users u ON u.id=p.created_by`;

  // Confere na InfinitePay se a cobrança foi paga (precisa do slug e do NSU que vieram no aviso).
  async function confirm(charge) {
    if (charge.status === 'paid' || !charge.invoice_slug || !charge.transaction_nsu) return charge;
    const account = await accountOf(charge.tenant_id); if (!account) return charge;
    let r;
    try {
      r = await call('/payment_check', account, { ...(account.handle ? { handle: account.handle } : {}), order_nsu: charge.id, transaction_nsu: charge.transaction_nsu, slug: charge.invoice_slug });
    } catch (e) {
      await q('UPDATE pix_charges SET last_error=$2 WHERE id=$1', [charge.id, String(e.detail || e.message).slice(0, 300)]);
      throw e;
    }
    if (!r.success || !r.paid || Number(r.amount) !== charge.amount_cents) return charge;
    // Pago também vale se a cobrança tinha sido cancelada no painel (o cliente pagou mesmo assim): fica para registrar.
    const u = await q(`UPDATE pix_charges SET status='paid',paid_at=coalesce(paid_at,now()),paid_amount_cents=$2,capture_method=$3,last_error=NULL
      WHERE id=$1 AND status<>'paid' RETURNING *`, [charge.id, Number(r.paid_amount) || charge.amount_cents, r.capture_method || null]);
    return u.rows[0] || (await q('SELECT * FROM pix_charges WHERE id=$1', [charge.id])).rows[0];
  }

  // Corpo da venda paga por Pix na InfinitePay: uma forma só (Pix), sem pagamento dividido.
  const chargeSchema = z.object({ sale: saleSchema, amount_cents: z.number().int().min(100).max(100000000) }).strict();

  app.get('/api/store/sales/pix-charges', ...guard, route(async (req, res) => {
    const r = await q(`${SELECT} WHERE p.tenant_id=$1 AND p.sale_id IS NULL AND (p.status='paid' OR (p.status='pending' AND p.created_at>now()-interval '1 day'))
      ORDER BY p.created_at DESC LIMIT 50`, [tid(req)]);
    res.set('Cache-Control', 'no-store');
    res.json({ charges: r.rows.map(view) });
  }));

  app.post('/api/store/sales/pix-charges', ...guard, route(async (req, res) => {
    const v = valid(chargeSchema, req, res); if (!v) return;
    const account = await accountOf(tid(req));
    if (!account) return bad(res, 409, 'A cobrança Pix pela InfinitePay não está ligada nesta loja.');
    if (v.sale.payments) return bad(res, 400, 'Pagamento dividido não usa a cobrança da InfinitePay. Lance o Pix separado.');
    if (v.sale.payment_method && v.sale.payment_method !== 'pix') return bad(res, 400, 'A cobrança da InfinitePay é só para Pix.');
    if (!(await q("SELECT 1 FROM cash_sessions WHERE tenant_id=$1 AND status='open'", [tid(req)])).rowCount) return bad(res, 409, 'Abra o caixa antes de cobrar.');
    const sale = { ...v.sale, payment_method: 'pix' };
    const store = (await q('SELECT name FROM tenants WHERE id=$1', [tid(req)])).rows[0]?.name || 'Loja';
    const description = (sale.description || 'Compra em ' + store).replace(/\s+/g, ' ').slice(0, 100);
    const charge = (await q('INSERT INTO pix_charges(tenant_id,created_by,amount_cents,description,sale_body) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [tid(req), req.user.id, v.amount_cents, description, JSON.stringify(sale)])).rows[0];
    let link;
    try {
      link = await call('/links', account, {
        ...(account.handle ? { handle: account.handle } : {}),
        order_nsu: charge.id,
        items: [{ quantity: 1, price: v.amount_cents, description }],
        webhook_url: `${BASE()}/api/infinitepay/webhook/${charge.id}?t=${webhookToken(charge.id)}`
      });
    } catch (e) {
      await q("UPDATE pix_charges SET status='canceled',canceled_at=now(),last_error=$2 WHERE id=$1", [charge.id, String(e.detail || e.message).slice(0, 300)]);
      console.error('InfinitePay: link não criado', e.status || '', e.detail || e.message);
      return bad(res, 502, 'A InfinitePay não respondeu agora. Tente de novo ou registre o Pix pelo QR do balcão.');
    }
    const url = link.url || link.link || link.checkout_url;
    if (!url || !/^https:\/\//.test(url)) {
      await q("UPDATE pix_charges SET status='canceled',canceled_at=now(),last_error='resposta sem url' WHERE id=$1", [charge.id]);
      return bad(res, 502, 'A InfinitePay não devolveu o link de pagamento. Tente de novo.');
    }
    await q('UPDATE pix_charges SET checkout_url=$2 WHERE id=$1', [charge.id, url]);
    await audit(req, 'create', 'pix_charge', charge.id);
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
    res.status(201).json({ ...view({ ...charge, checkout_url: url }), qr });
  }));

  // O painel pergunta a cada poucos segundos. Se o aviso já chegou mas a conferência falhou, tenta de novo.
  app.get('/api/store/sales/pix-charges/:id', ...guard, route(async (req, res) => {
    let c = (await q(`${SELECT} WHERE p.id=$1 AND p.tenant_id=$2`, [req.params.id, tid(req)])).rows[0];
    if (!c) return bad(res, 404, 'Cobrança não encontrada');
    if (c.status !== 'paid' && c.transaction_nsu) { try { c = { ...c, ...(await confirm(c)) }; } catch { /* tenta na próxima */ } }
    res.set('Cache-Control', 'no-store');
    res.json(view(c));
  }));

  app.post('/api/store/sales/pix-charges/:id/cancel', ...guard, route(async (req, res) => {
    const r = await q(`UPDATE pix_charges SET status='canceled',canceled_at=now(),canceled_by=$3 WHERE id=$1 AND tenant_id=$2 AND status='pending' RETURNING *`, [req.params.id, tid(req), req.user.id]);
    if (!r.rowCount) return bad(res, 409, 'Esta cobrança já foi paga ou cancelada. Atualize.');
    await audit(req, 'cancel', 'pix_charge', req.params.id);
    res.json(view(r.rows[0]));
  }));

  // Registra a venda de uma cobrança paga (uma vez só; o vínculo é gravado na mesma transação da venda).
  app.post('/api/store/sales/pix-charges/:id/finish', ...guard, route(async (req, res) => {
    let c = (await q('SELECT * FROM pix_charges WHERE id=$1 AND tenant_id=$2', [req.params.id, tid(req)])).rows[0];
    if (!c) return bad(res, 404, 'Cobrança não encontrada');
    if (c.sale_id) return bad(res, 409, 'A venda desta cobrança já foi registrada.');
    if (c.status !== 'paid') { try { c = await confirm(c); } catch { /* segue como não pago */ } }
    if (c.status !== 'paid') return bad(res, 409, 'O Pix ainda não foi confirmado pela InfinitePay.');
    const parsed = saleSchema.safeParse(c.sale_body);
    if (!parsed.success) return bad(res, 400, 'Os dados guardados desta venda não valem mais. Registre a venda à mão com a forma Pix.');
    return createSale(req, res, { ...parsed.data, payment_method: 'pix', payments: undefined }, null, { pixCharge: c });
  }));

  // Aviso da InfinitePay (sem login). Só vale com o token da cobrança; o pagamento é conferido no /payment_check.
  const hook = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
  app.post('/api/infinitepay/webhook/:id', hook, route(async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id) || !sameToken(req.query.t, webhookToken(id))) return res.status(404).json({ error: 'not found' });
    const d = req.body && typeof req.body === 'object' ? (req.body.data && typeof req.body.data === 'object' ? req.body.data : req.body) : {};
    if (d.order_nsu && String(d.order_nsu) !== id) return res.status(400).json({ error: 'order_nsu' });
    const slug = String(d.invoice_slug || d.slug || '').slice(0, 120), nsu = String(d.transaction_nsu || '').slice(0, 120);
    const c0 = (await q('SELECT * FROM pix_charges WHERE id=$1', [id])).rows[0];
    if (!c0) return res.status(404).json({ error: 'not found' });
    if (!slug || !nsu) return res.json({ ok: true, ignored: true }); // eventos sem pagamento (ex.: created)
    const c = (await q(`UPDATE pix_charges SET invoice_slug=coalesce(invoice_slug,$2),transaction_nsu=coalesce(transaction_nsu,$3),
      receipt_url=coalesce($4,receipt_url) WHERE id=$1 RETURNING *`, [id, slug, nsu, typeof d.receipt_url === 'string' && /^https:\/\//.test(d.receipt_url) ? d.receipt_url.slice(0, 500) : null])).rows[0];
    try { await confirm(c); } catch (e) { console.error('InfinitePay: conferência falhou', e.status || '', e.detail || e.message); return res.status(400).json({ error: 'retry' }); }
    res.json({ ok: true });
  }));

  return { infinitePayOn: async tenant => !!(await accountOf(tenant)), brl };
}
