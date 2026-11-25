// Estoque da rede: consulta entre unidades, contagem, transferências bipadas (envio e recebimento com PIN)
// e depósito central (unidade marcada como depósito). As peças casam entre unidades pelo código da loja.
import { codeEq } from './code-match.js';
import { z } from 'zod';
import { pinOk } from './kiosk.js';

export function registerNetworkStock(app, { q, db, auth, roles, route, bad, valid, audit, uuid, bcrypt }) {
  const staff = [auth, roles('owner', 'operator')];
  const network = [auth, roles('network')];
  const PIN = z.string().regex(/^\d{4}$/);
  const tz = 'America/Fortaleza';
  const me = async req => (await q('SELECT id, network_id, coalesce(unit_label, name) label, depot FROM tenants WHERE id = $1', [req.user.tenant_id])).rows[0];
  // PIN de quem faz (quiosque); fora do quiosque, o próprio usuário.
  async function who(req, v) {
    if (!req.user.kiosk) return { id: req.user.id, name: null };
    const u = v.seller_id ? (await q('SELECT id, name FROM users WHERE id = $1 AND tenant_id = $2 AND active', [v.seller_id, req.user.tenant_id])).rows[0] : null;
    if (!u || !(await pinOk({ query: q }, bcrypt, u.id, v.seller_pin))) return null;
    return u;
  }
  const move = (c, tenant, productId, kind, qty, userId, note) => c.query(`INSERT INTO stock_movements(tenant_id, product_id, kind, quantity, created_by, stock_after, stock_before, note)
    SELECT $1, $2, $3, $4, $5, p.stock_qty, p.stock_qty - $4, $6 FROM products p WHERE p.id = $2`, [tenant, productId, kind, qty, userId, note]);

  // Unidades da rede (para escolher o destino da transferência).
  app.get('/api/store/network-units', ...staff, route(async (req, res) => {
    const m = await me(req); if (!m?.network_id) return res.json({ units: [], me: null });
    const r = await q("SELECT id, coalesce(unit_label, name) label, depot FROM tenants WHERE network_id = $1 AND status IN ('trial','active') ORDER BY depot DESC, 2", [m.network_id]);
    res.json({ me: { id: m.id, label: m.label, depot: m.depot }, units: r.rows });
  }));

  // Consulta do estoque da peça em todas as unidades da rede (pelo código ou nome).
  app.get('/api/store/stock/network', ...staff, route(async (req, res) => {
    const term = String(req.query.q || '').trim().slice(0, 80); if (term.length < 2) return res.json([]);
    const m = await me(req); if (!m?.network_id) return res.json([]);
    const codes = (await q(`SELECT DISTINCT p.code FROM products p WHERE p.tenant_id = $1 AND p.active AND p.code IS NOT NULL AND (${codeEq('p.code','$2')} OR ${codeEq('p.barcode','$2')} OR fp_fold(p.name) LIKE '%'||fp_fold($2)||'%') LIMIT 15`, [m.id, term])).rows.map(r => r.code);
    if (!codes.length) return res.json([]);
    const r = await q(`SELECT p.code, max(p.name) FILTER (WHERE p.tenant_id = $3) name, max(p.price_cents) FILTER (WHERE p.tenant_id = $3) price_cents,
        json_agg(json_build_object('unit', coalesce(t.unit_label, t.name), 'depot', t.depot, 'stock', coalesce(p.stock_qty, 0), 'mine', t.id = $3) ORDER BY t.depot DESC, coalesce(t.unit_label, t.name)) units
      FROM products p JOIN tenants t ON t.id = p.tenant_id WHERE t.network_id = $1 AND p.code = ANY($2) AND p.active GROUP BY p.code ORDER BY 2`, [m.network_id, codes, m.id]);
    res.set('Cache-Control', 'no-store').json(r.rows);
  }));

  // Contagem: define o estoque das peças contadas; com zero_others, as não contadas ficam com 0.
  app.post('/api/store/stock/count', ...staff, route(async (req, res) => {
    const v = valid(z.object({ items: z.array(z.object({ product_id: uuid, quantity: z.number().int().min(0).max(99999) }).strict()).min(1).max(20000), zero_others: z.boolean().default(false), seller_id: uuid.optional(), seller_pin: PIN.optional() }).strict(), req, res); if (!v) return;
    const u = await who(req, v); if (!u) return bad(res, 401, 'PIN incorreto');
    const tid = req.user.tenant_id, c = await db.connect();
    try {
      await c.query('BEGIN');
      const ids = v.items.map(i => i.product_id), qty = v.items.map(i => i.quantity);
      const ok = (await c.query('SELECT count(*)::int n FROM products WHERE tenant_id = $1 AND id = ANY($2)', [tid, ids])).rows[0].n;
      if (ok !== new Set(ids).size) { await c.query('ROLLBACK'); return bad(res, 400, 'Peça de outra unidade na contagem'); }
      await c.query(`INSERT INTO stock_movements(tenant_id, product_id, kind, quantity, created_by, stock_before, stock_after, note)
        SELECT $1, p.id, 'count', x.q - coalesce(p.stock_qty, 0), $4, p.stock_qty, x.q, 'Contagem' FROM products p JOIN unnest($2::uuid[], $3::int[]) x(id, q) ON x.id = p.id
        WHERE p.tenant_id = $1 AND coalesce(p.stock_qty, 0) <> x.q`, [tid, ids, qty, u.id]);
      const set = await c.query('UPDATE products p SET stock_qty = x.q, updated_at = now() FROM unnest($2::uuid[], $3::int[]) x(id, q) WHERE p.id = x.id AND p.tenant_id = $1', [tid, ids, qty]);
      let zeroed = 0;
      if (v.zero_others) {
        await c.query(`INSERT INTO stock_movements(tenant_id, product_id, kind, quantity, created_by, stock_before, stock_after, note)
          SELECT $1, id, 'count', -stock_qty, $3, stock_qty, 0, 'Contagem: não encontrada' FROM products WHERE tenant_id = $1 AND active AND kind = 'product' AND id <> ALL($2) AND coalesce(stock_qty, 0) <> 0`, [tid, ids, u.id]);
        zeroed = (await c.query("UPDATE products SET stock_qty = 0, updated_at = now() WHERE tenant_id = $1 AND active AND kind = 'product' AND id <> ALL($2) AND coalesce(stock_qty, 0) <> 0", [tid, ids])).rowCount;
      }
      await c.query('COMMIT');
      await audit(req, 'stock_count', 'tenant', tid);
      res.json({ counted: set.rowCount, units: qty.reduce((a, b) => a + b, 0), zeroed });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // Envio: bipa as peças, escolhe o destino e confirma com o PIN. Sai do estoque desta unidade na hora.
  app.post('/api/store/transfers', ...staff, route(async (req, res) => {
    const v = valid(z.object({ to_tenant_id: uuid, items: z.array(z.object({ product_id: uuid, quantity: z.number().int().min(1).max(9999) }).strict()).min(1).max(500), note: z.string().trim().max(300).default(''), seller_id: uuid.optional(), seller_pin: PIN.optional() }).strict(), req, res); if (!v) return;
    const m = await me(req); if (!m?.network_id) return bad(res, 400, 'Transferência só entre unidades de uma rede');
    const to = (await q('SELECT id FROM tenants WHERE id = $1 AND network_id = $2', [v.to_tenant_id, m.network_id])).rows[0];
    if (!to || to.id === m.id) return bad(res, 400, 'Escolha outra unidade da rede');
    const u = await who(req, v); if (!u) return bad(res, 401, 'PIN incorreto');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const merged = new Map(); for (const i of v.items) merged.set(i.product_id, (merged.get(i.product_id) || 0) + i.quantity);
      const prods = (await c.query("SELECT id, code, barcode, name FROM products WHERE tenant_id = $1 AND id = ANY($2) AND active FOR UPDATE", [m.id, [...merged.keys()]])).rows;
      if (prods.length !== merged.size) { await c.query('ROLLBACK'); return bad(res, 400, 'Peça não encontrada nesta unidade'); }
      if (prods.some(p => !(p.code || p.barcode))) { await c.query('ROLLBACK'); return bad(res, 400, 'Peça sem código não pode ser transferida'); }
      const t = (await c.query('INSERT INTO stock_transfers(network_id, from_tenant, to_tenant, note, sent_by) VALUES($1, $2, $3, $4, $5) RETURNING id, number', [m.network_id, m.id, to.id, v.note || null, u.id])).rows[0];
      for (const p of prods) {
        const qty = merged.get(p.id);
        await c.query('INSERT INTO stock_transfer_items(transfer_id, code, name, from_product, qty_sent) VALUES($1, $2, $3, $4, $5)', [t.id, p.code || p.barcode, p.name, p.id, qty]);
        await c.query('UPDATE products SET stock_qty = coalesce(stock_qty, 0) - $2, updated_at = now() WHERE id = $1', [p.id, qty]);
        await move(c, m.id, p.id, 'transfer_out', -qty, u.id, 'Transferência nº ' + t.number);
      }
      await c.query('COMMIT');
      await audit(req, 'transfer_send', 'stock_transfer', t.id);
      res.status(201).json({ id: t.id, number: t.number, items: prods.length, units: [...merged.values()].reduce((a, b) => a + b, 0) });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // Transferências desta unidade: a receber e as últimas enviadas.
  app.get('/api/store/transfers', ...staff, route(async (req, res) => {
    const tid = req.user.tenant_id;
    const r = await q(`SELECT s.id, s.number, s.status, s.note, to_char(s.sent_at AT TIME ZONE $2, 'DD/MM HH24:MI') sent_at, s.from_tenant = $1 outgoing,
        coalesce(f.unit_label, f.name) from_unit, coalesce(t.unit_label, t.name) to_unit, us.name sent_by,
        (SELECT json_agg(json_build_object('code', i.code, 'name', i.name, 'qty_sent', i.qty_sent, 'qty_received', i.qty_received) ORDER BY i.name) FROM stock_transfer_items i WHERE i.transfer_id = s.id) items
      FROM stock_transfers s JOIN tenants f ON f.id = s.from_tenant JOIN tenants t ON t.id = s.to_tenant LEFT JOIN users us ON us.id = s.sent_by
      WHERE (s.to_tenant = $1 AND s.status = 'sent') OR ((s.from_tenant = $1 OR s.to_tenant = $1) AND s.sent_at > now() - interval '15 days')
      ORDER BY (s.to_tenant = $1 AND s.status = 'sent') DESC, s.sent_at DESC LIMIT 60`, [tid, tz]);
    res.set('Cache-Control', 'no-store').json(r.rows);
  }));

  // Recebimento: bipa o que chegou e confirma com o PIN. Diferença fica marcada para o supervisor.
  app.post('/api/store/transfers/:id/receive', ...staff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Transferência inválida');
    const v = valid(z.object({ items: z.array(z.object({ code: z.string().trim().min(1).max(64), quantity: z.number().int().min(0).max(9999) }).strict()).max(500), seller_id: uuid.optional(), seller_pin: PIN.optional() }).strict(), req, res); if (!v) return;
    const u = await who(req, v); if (!u) return bad(res, 401, 'PIN incorreto');
    const tid = req.user.tenant_id, c = await db.connect();
    try {
      await c.query('BEGIN');
      const t = (await c.query("SELECT id, number FROM stock_transfers WHERE id = $1 AND to_tenant = $2 AND status = 'sent' FOR UPDATE", [req.params.id, tid])).rows[0];
      if (!t) { await c.query('ROLLBACK'); return bad(res, 404, 'Transferência não encontrada ou já recebida'); }
      const items = (await c.query('SELECT i.*, p.price_cents, p.family, p.ncm FROM stock_transfer_items i JOIN products p ON p.id = i.from_product WHERE i.transfer_id = $1', [t.id])).rows;
      const got = new Map(); for (const i of v.items) got.set(i.code, (got.get(i.code) || 0) + i.quantity);
      if ([...got.keys()].some(code => !items.some(i => i.code === code))) { await c.query('ROLLBACK'); return bad(res, 400, 'Peça bipada que não está nesta transferência'); }
      let divergent = false;
      for (const i of items) {
        const qty = got.get(i.code) || 0; if (qty !== i.qty_sent) divergent = true;
        let dest = (await c.query("SELECT id FROM products WHERE tenant_id = $1 AND (code = $2 OR barcode = $2) AND active AND kind = 'product' ORDER BY (code = $2) DESC LIMIT 1", [tid, i.code])).rows[0];
        if (!dest) dest = (await c.query("INSERT INTO products(tenant_id, name, barcode, code, price_cents, family, ncm, fiscal_origin, stock_qty, kind) VALUES($1, $2, $3, $3, $4, $5, $6, 0, 0, 'product') RETURNING id", [tid, i.name, i.code, i.price_cents, i.family, i.ncm])).rows[0];
        if (qty) {
          await c.query('UPDATE products SET stock_qty = coalesce(stock_qty, 0) + $2, updated_at = now() WHERE id = $1', [dest.id, qty]);
          await move(c, tid, dest.id, 'transfer_in', qty, u.id, 'Transferência nº ' + t.number);
        }
        await c.query('UPDATE stock_transfer_items SET to_product = $3, qty_received = $4 WHERE transfer_id = $1 AND code = $2', [t.id, i.code, dest.id, qty]);
      }
      await c.query('UPDATE stock_transfers SET status = $2, received_by = $3, received_at = now() WHERE id = $1', [t.id, divergent ? 'divergent' : 'received', u.id]);
      await c.query('COMMIT');
      await audit(req, 'transfer_receive', 'stock_transfer', t.id);
      res.json({ status: divergent ? 'divergent' : 'received' });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // Central: marca a unidade como depósito central.
  app.patch('/api/master/tenants/:id/depot', auth, roles('master'), route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Loja inválida');
    const v = valid(z.object({ depot: z.boolean() }).strict(), req, res); if (!v) return;
    const r = await q('UPDATE tenants SET depot = $2 WHERE id = $1 AND network_id IS NOT NULL RETURNING id, depot', [req.params.id, v.depot]);
    if (!r.rowCount) return bad(res, 404, 'Loja não encontrada numa rede');
    await audit(req, 'update', 'tenant_depot', req.params.id); res.json(r.rows[0]);
  }));

  // Painel da rede: transferências com diferença ou paradas há mais de 2 dias.
  app.get('/api/network/transfers', ...network, route(async (req, res) => {
    const scope = req.user.network_access === 'supervisor' ? (req.user.network_unit_ids || []) : null;
    const r = await q(`SELECT s.id, s.number, s.status, to_char(s.sent_at AT TIME ZONE $3, 'DD/MM HH24:MI') sent_at, coalesce(f.unit_label, f.name) from_unit, coalesce(t.unit_label, t.name) to_unit,
        s.status = 'sent' AND s.sent_at < now() - interval '2 days' late,
        (SELECT json_agg(json_build_object('code', i.code, 'name', i.name, 'qty_sent', i.qty_sent, 'qty_received', i.qty_received)) FROM stock_transfer_items i WHERE i.transfer_id = s.id AND (s.status = 'sent' OR i.qty_received IS DISTINCT FROM i.qty_sent)) items
      FROM stock_transfers s JOIN tenants f ON f.id = s.from_tenant JOIN tenants t ON t.id = s.to_tenant
      WHERE s.network_id = $1 AND ($2::uuid[] IS NULL OR s.from_tenant = ANY($2) OR s.to_tenant = ANY($2))
        AND (s.status = 'divergent' OR (s.status = 'sent' AND s.sent_at < now() - interval '2 days')) AND s.sent_at > now() - interval '60 days'
      ORDER BY s.sent_at DESC LIMIT 50`, [req.user.network_id, scope, tz]);
    res.set('Cache-Control', 'no-store').json(r.rows);
  }));
}
