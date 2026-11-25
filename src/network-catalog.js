// Estoque da rede (Audace), parte de gestão no painel da rede: cadastro de peças, entrada rápida, etiquetas,
// códigos gerados, reposição, histórico, preços e valor do estoque.
//
// Regras combinadas com o Lucas (25/11/2026):
// - Só dono e supervisor mexem nisso (painel da rede). O quiosque continua com consultar, receber, enviar e contagem.
// - Preço igual na rede: cada unidade guarda a própria linha em `products`, e as linhas da mesma peça casam pelo
//   código (code; sem code, o código de barras). Cadastrar cria a peça em todas as unidades ativas (e no depósito);
//   mudar nome, família ou preço muda em todas.
// - Supervisor só dá entrada, imprime etiqueta, vê reposição e histórico das unidades dele.
// - Valor do estoque: só o dono. Custo aparece só para o dono (o supervisor pode informar o custo na entrada).
import { z } from 'zod';
import { newPrice } from './store-admin.js';

const TZ = 'America/Fortaleza';
// Peça sem código nem código de barras (cadastro antigo): chave "id:<uuid>", para poder gerar o código dela.
const KEY = "coalesce(p.code, p.barcode, 'id:' || p.id)";
const ean13 = body12 => { let s = 0; for (let i = 0; i < 12; i++) s += Number(body12[i]) * (i % 2 ? 3 : 1); return body12 + ((10 - (s % 10)) % 10); };
const cents = z.number().int().min(0).max(100000000);
const code = z.string().trim().regex(/^[!-~]{1,64}$/, 'Código inválido (sem espaços nem acentos)');

export function registerNetworkCatalog(app, { q, db, auth, roles, route, bad, valid, audit, uuid }) {
  const network = [auth, roles('network')];
  const isOwner = req => req.user.network_access !== 'supervisor';
  const ownerOnly = (req, res, next) => isOwner(req) ? next() : bad(res, 403, 'Só o dono vê esta parte.');
  // Todas as unidades ativas da rede (cadastro e preço valem para todas).
  const allUnits = async (cq, req) => (await cq(`SELECT id, coalesce(unit_label, name) label, depot FROM tenants
    WHERE network_id = $1 AND status IN ('trial','active') ORDER BY depot DESC, lower(coalesce(unit_label, name))`, [req.user.network_id])).rows;
  // Unidades que a pessoa pode operar (supervisor: só as dele).
  const myUnits = async (cq, req) => { const u = await allUnits(cq, req); return isOwner(req) ? u : u.filter(x => (req.user.network_unit_ids || []).includes(x.id)); };
  const unitOk = async (cq, req, id) => uuid.safeParse(id).success && (await myUnits(cq, req)).find(u => u.id === id);
  const move = (cq, tenant, productId, kind, qty, userId, note, cost = null) => cq(`INSERT INTO stock_movements(tenant_id, product_id, kind, quantity, unit_cost_cents, created_by, stock_after, stock_before, note)
    SELECT $1, $2, $3, $4, $7, $5, p.stock_qty, p.stock_qty - $4, $6 FROM products p WHERE p.id = $2`, [tenant, productId, kind, qty, userId, note, cost]);
  // Linha da peça numa unidade; se a unidade ainda não tem, cria copiando o cadastro de outra unidade (estoque 0).
  async function rowIn(c, unitId, key, ids) {
    const r = (await c.query(`SELECT p.* FROM products p WHERE p.tenant_id = $1 AND p.active AND p.kind = 'product' AND ${KEY} = $2 ORDER BY (p.code = $2) DESC LIMIT 1 FOR UPDATE`, [unitId, key])).rows[0];
    if (r) return r;
    const src = (await c.query(`SELECT p.* FROM products p WHERE p.tenant_id = ANY($1::uuid[]) AND p.active AND p.kind = 'product' AND ${KEY} = $2 ORDER BY p.updated_at DESC LIMIT 1`, [ids, key])).rows[0];
    if (!src) return null;
    return (await c.query(`INSERT INTO products(tenant_id, name, barcode, code, price_cents, cost_cents, family, ncm, fiscal_origin, stock_qty, kind)
      VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 'product') RETURNING *`, [unitId, src.name, src.barcode, src.code, src.price_cents, src.cost_cents, src.family, src.ncm, src.fiscal_origin])).rows[0];
  }

  // ---------- Peças da rede (uma linha por código) ----------
  app.get('/api/network/catalog', ...network, route(async (req, res) => {
    const units = await allUnits(q, req), ids = units.map(u => u.id);
    const term = String(req.query.q || '').trim().slice(0, 80), family = String(req.query.family || '').trim().slice(0, 80);
    const noBarcode = req.query.no_barcode === '1';
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000), offset = Math.max(Number(req.query.offset) || 0, 0);
    const r = await q(`WITH p AS (SELECT ${KEY} k, p.* FROM products p WHERE p.tenant_id = ANY($1::uuid[]) AND p.active AND p.kind = 'product')
      SELECT k "key", max(code) code, max(name) name, max(family) family, max(barcode) barcode, max(price_cents) price_cents,
        min(price_cents) <> max(price_cents) prices_differ, max(cost_cents) cost_cents, sum(greatest(coalesce(stock_qty, 0), 0))::int total,
        count(DISTINCT tenant_id)::int units, bool_or(generated_barcode) generated, count(*) OVER() n
        FROM p WHERE ($2 = '' OR fp_fold(name) LIKE '%'||fp_fold($2)||'%' OR code = $2 OR barcode = $2) AND ($3 = '' OR family = $3)
       GROUP BY k HAVING NOT $4 OR bool_and(barcode IS NULL)
       ORDER BY lower(max(name)), k LIMIT $5 OFFSET $6`, [ids, term, family, noBarcode, limit, offset]);
    const families = (await q('SELECT DISTINCT family FROM products WHERE tenant_id = ANY($1::uuid[]) AND active AND family IS NOT NULL ORDER BY 1 LIMIT 300', [ids])).rows.map(x => x.family);
    const owner = isOwner(req);
    const mine = await myUnits(q, req);
    res.set('Cache-Control', 'no-store').json({ owner, units: units.length, my_units: mine, families, total: Number(r.rows[0]?.n || 0), offset, limit,
      items: r.rows.map(({ n, cost_cents, ...x }) => owner ? { ...x, cost_cents } : x) });
  }));

  // Cadastrar peça nova: entra em todas as unidades com o mesmo código e preço. Opcional: quantidade que chegou numa unidade.
  app.post('/api/network/catalog', ...network, route(async (req, res) => {
    const v = valid(z.object({ code: code.optional(), barcode: code.optional(), generate: z.boolean().optional(), name: z.string().trim().min(2).max(120),
      family: z.string().trim().max(80).optional(), price_cents: cents.refine(n => n > 0, 'Informe o preço de venda'), cost_cents: cents.nullable().optional(),
      unit_id: uuid.optional(), quantity: z.number().int().min(0).max(9999).optional(), labels: z.enum(['none', 'one', 'each']).optional() }).strict(), req, res); if (!v) return;
    if (!v.generate && !v.code && !v.barcode) return bad(res, 400, 'Informe o código da peça ou marque "Gerar código".');
    if (v.quantity && !v.unit_id) return bad(res, 400, 'Escolha a unidade que recebeu as peças.');
    if (v.unit_id && !(await unitOk(q, req, v.unit_id))) return bad(res, 403, 'Unidade fora do seu acesso.');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fp-net-catalog:'||$1))", [req.user.network_id]);
      const units = await allUnits(c.query.bind(c), req), ids = units.map(u => u.id);
      let barcode = v.barcode || v.code || null, generated = false;
      if (v.generate && !v.barcode) { barcode = ean13('2' + String((await c.query("SELECT nextval('product_internal_code_seq') n")).rows[0].n).padStart(11, '0')); generated = true; }
      const key = v.code || barcode;
      const dup = (await c.query(`SELECT p.name FROM products p WHERE p.tenant_id = ANY($1::uuid[]) AND p.active AND p.kind = 'product' AND (${KEY} = $2 OR p.barcode = $3 OR p.code = $2) LIMIT 1`, [ids, key, barcode])).rows[0];
      if (dup) { await c.query('ROLLBACK'); return bad(res, 409, `Já existe uma peça com este código: ${dup.name}`); }
      let mine = null, first = null;
      for (const u of units) {
        const qty = u.id === v.unit_id ? v.quantity || 0 : 0;
        const p = (await c.query(`INSERT INTO products(tenant_id, name, barcode, code, price_cents, cost_cents, family, stock_qty, generated_barcode, kind, created_by, labels_pending, labels_queued_at)
          VALUES($1, $2, $3, $4, $5, $6, NULLIF($7, ''), $8, $9, 'product', $10, $11, CASE WHEN $11 > 0 THEN now() END) RETURNING id, name, barcode, code, price_cents, stock_qty`,
          [u.id, v.name, barcode, key, v.price_cents, v.cost_cents ?? null, v.family || '', qty, generated, req.user.id,
            u.id === v.unit_id ? (v.labels === 'one' ? 1 : v.labels === 'each' ? qty : 0) : 0])).rows[0];
        if (qty) await move(c.query.bind(c), u.id, p.id, 'entry', qty, req.user.id, 'Peça cadastrada no painel da rede', v.cost_cents ?? null);
        if (u.id === v.unit_id) mine = p; first ||= p;
      }
      await c.query('COMMIT');
      await audit(req, 'create', 'network_product', first?.id || null, null);
      res.status(201).json({ key, code: key, barcode, name: v.name, price_cents: v.price_cents, units: units.length, unit_product: mine });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); if (e.code === '23505') return bad(res, 409, 'Código de barras já usado em uma unidade.'); throw e; } finally { c.release(); }
  }));

  // Editar a peça: vale em todas as unidades (nome, família, preço; custo só o dono).
  app.post('/api/network/catalog/update', ...network, route(async (req, res) => {
    const v = valid(z.object({ key: code, name: z.string().trim().min(2).max(120).optional(), family: z.string().trim().max(80).optional(),
      price_cents: cents.refine(n => n > 0, 'Preço inválido').optional(), cost_cents: cents.nullable().optional() }).strict(), req, res); if (!v) return;
    if ('cost_cents' in v && !isOwner(req)) return bad(res, 403, 'Só o dono muda o custo.');
    const ids = (await allUnits(q, req)).map(u => u.id);
    const r = await q(`UPDATE products p SET name = coalesce($3, name), family = CASE WHEN $4::text IS NULL THEN family ELSE NULLIF($4, '') END,
        price_cents = coalesce($5, price_cents), cost_cents = CASE WHEN $6 THEN $7::int ELSE cost_cents END, updated_at = now()
      WHERE p.tenant_id = ANY($1::uuid[]) AND p.active AND p.kind = 'product' AND ${KEY} = $2 RETURNING p.id`,
      [ids, v.key, v.name ?? null, v.family ?? null, v.price_cents ?? null, 'cost_cents' in v, v.cost_cents ?? null]);
    if (!r.rowCount) return bad(res, 404, 'Peça não encontrada');
    await audit(req, v.price_cents != null ? 'reprice' : 'update', 'network_product', r.rows[0].id, null);
    res.json({ updated: r.rowCount });
  }));

  // Peça sem código de barras: gera um código interno (EAN-13 começando com 2) para ela em todas as unidades.
  app.post('/api/network/catalog/generate-code', ...network, route(async (req, res) => {
    const v = valid(z.object({ key: code }).strict(), req, res); if (!v) return;
    const ids = (await allUnits(q, req)).map(u => u.id);
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const rows = (await c.query(`SELECT p.id FROM products p WHERE p.tenant_id = ANY($1::uuid[]) AND p.active AND p.kind = 'product' AND p.barcode IS NULL
        AND ${KEY} = $2 FOR UPDATE`, [ids, v.key])).rows;
      if (!rows.length) { await c.query('ROLLBACK'); return bad(res, 404, 'Peça não encontrada ou já tem código de barras'); }
      const bc = ean13('2' + String((await c.query("SELECT nextval('product_internal_code_seq') n")).rows[0].n).padStart(11, '0'));
      await c.query('UPDATE products SET barcode = $2, code = coalesce(code, $2), generated_barcode = true, updated_at = now() WHERE id = ANY($1::uuid[])', [rows.map(r => r.id), bc]);
      await c.query('COMMIT');
      await audit(req, 'generate_code', 'network_product', rows[0].id, null);
      res.json({ barcode: bc, key: v.key.startsWith('id:') ? bc : v.key, updated: rows.length });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // ---------- Entrada rápida numa unidade (bipar ou buscar; várias peças de uma vez) ----------
  app.post('/api/network/stock/entry', ...network, route(async (req, res) => {
    const v = valid(z.object({ unit_id: uuid, items: z.array(z.object({ key: code, quantity: z.number().int().min(1).max(9999), unit_cost_cents: cents.nullable().optional() }).strict()).min(1).max(300),
      labels: z.enum(['none', 'one', 'each']).default('none'), note: z.string().trim().max(120).optional() }).strict(), req, res); if (!v) return;
    if (!(await unitOk(q, req, v.unit_id))) return bad(res, 403, 'Unidade fora do seu acesso.');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const ids = (await allUnits(c.query.bind(c), req)).map(u => u.id), out = [];
      const merged = new Map(); for (const i of v.items) { const m = merged.get(i.key); if (m) m.quantity += i.quantity; else merged.set(i.key, { ...i }); }
      for (const i of merged.values()) {
        const p = await rowIn(c, v.unit_id, i.key, ids);
        if (!p) { await c.query('ROLLBACK'); return bad(res, 404, `Peça ${i.key} não cadastrada na rede. Cadastre em "Produtos".`); }
        const cost = i.unit_cost_cents !== undefined ? i.unit_cost_cents : p.cost_cents;
        const lab = v.labels === 'one' ? 1 : v.labels === 'each' ? i.quantity : 0;
        await c.query(`UPDATE products SET stock_qty = LEAST(999999, coalesce(stock_qty, 0) + $2), restock_pending = GREATEST(0, restock_pending - $2),
            labels_pending = LEAST(500, labels_pending + $3), labels_queued_at = CASE WHEN $3 > 0 AND labels_pending = 0 THEN now() ELSE labels_queued_at END, updated_at = now() WHERE id = $1`, [p.id, i.quantity, lab]);
        await move(c.query.bind(c), v.unit_id, p.id, 'entry', i.quantity, req.user.id, v.note || 'Entrada pelo painel da rede', cost ?? null);
        out.push({ key: i.key, name: p.name, quantity: i.quantity, stock_qty: (p.stock_qty || 0) + i.quantity, labels: lab });
      }
      await c.query('COMMIT');
      await audit(req, 'stock_entry', 'tenant', v.unit_id, v.unit_id);
      res.json({ items: out, units: out.reduce((a, x) => a + x.quantity, 0) });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // ---------- Etiquetas: fila por unidade (cada loja imprime as dela) ----------
  const labelRows = async unitId => (await q(`SELECT ${KEY} "key", p.name, p.barcode, p.code, p.price_cents, p.stock_qty, p.labels_pending, p.labels_queued_at
    FROM products p WHERE p.tenant_id = $1 AND p.active AND p.labels_pending > 0 AND p.barcode IS NOT NULL ORDER BY p.labels_queued_at, p.name`, [unitId])).rows;
  app.get('/api/network/labels', ...network, route(async (req, res) => {
    if (!(await unitOk(q, req, req.query.unit_id))) return bad(res, 400, 'Escolha a unidade');
    res.set('Cache-Control', 'no-store').json(await labelRows(req.query.unit_id));
  }));
  app.post('/api/network/labels', ...network, route(async (req, res) => {
    const v = valid(z.object({ unit_id: uuid, key: code, add: z.number().int().min(1).max(500).optional(), qty: z.number().int().min(0).max(500).optional() }).strict()
      .refine(x => (x.add == null) !== (x.qty == null), 'Informe add ou qty'), req, res); if (!v) return;
    if (!(await unitOk(q, req, v.unit_id))) return bad(res, 403, 'Unidade fora do seu acesso.');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const p = await rowIn(c, v.unit_id, v.key, (await allUnits(c.query.bind(c), req)).map(u => u.id));
      if (!p || !p.barcode) { await c.query('ROLLBACK'); return bad(res, 404, 'Peça não encontrada ou sem código de barras'); }
      await c.query(`UPDATE products SET labels_pending = LEAST(500, CASE WHEN $2::int IS NULL THEN labels_pending + $3 ELSE $2 END),
          labels_queued_at = CASE WHEN labels_pending = 0 THEN now() ELSE labels_queued_at END WHERE id = $1`, [p.id, v.qty ?? null, v.add ?? 0]);
      await c.query('COMMIT');
      res.json(await labelRows(v.unit_id));
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));
  app.post('/api/network/labels/printed', ...network, route(async (req, res) => {
    const v = valid(z.object({ unit_id: uuid, keys: z.array(code).min(1).max(500) }).strict(), req, res); if (!v) return;
    if (!(await unitOk(q, req, v.unit_id))) return bad(res, 403, 'Unidade fora do seu acesso.');
    const r = await q(`UPDATE products p SET labels_pending = 0, labels_queued_at = NULL WHERE p.tenant_id = $1 AND p.labels_pending > 0 AND ${KEY} = ANY($2::text[])`, [v.unit_id, v.keys]);
    res.json({ cleared: r.rowCount });
  }));

  // ---------- Reposição: vendidas e ainda não repostas, ou no estoque mínimo da rede ----------
  app.get('/api/network/stock/restock', ...network, route(async (req, res) => {
    const units = await myUnits(q, req), only = req.query.unit_id ? units.filter(u => u.id === req.query.unit_id) : units.filter(u => !u.depot);
    if (!only.length) return res.json({ min: 0, rows: [] });
    const min = (await q('SELECT low_stock_min FROM store_networks WHERE id = $1', [req.user.network_id])).rows[0]?.low_stock_min ?? 1;
    const r = await q(`SELECT p.tenant_id unit_id, coalesce(t.unit_label, t.name) unit, ${KEY} "key", p.name, p.family, coalesce(p.stock_qty, 0) stock_qty, p.restock_pending sold,
        (SELECT coalesce(sum(greatest(coalesce(d.stock_qty, 0), 0)), 0)::int FROM products d JOIN tenants dt ON dt.id = d.tenant_id
          WHERE dt.network_id = $3 AND dt.depot AND d.active AND coalesce(d.code, d.barcode) = ${KEY}) depot_qty
      FROM products p JOIN tenants t ON t.id = p.tenant_id
      WHERE p.tenant_id = ANY($1::uuid[]) AND p.active AND p.kind = 'product' AND p.restock AND (p.restock_pending > 0
        OR (p.stock_qty IS NOT NULL AND p.stock_qty <= $2 AND EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.product_id = p.id AND s.canceled_at IS NULL AND s.created_at > now() - interval '60 days')))
      ORDER BY lower(coalesce(t.unit_label, t.name)), lower(p.name) LIMIT 2000`, [only.map(u => u.id), min, req.user.network_id]);
    res.set('Cache-Control', 'no-store').json({ min, rows: r.rows });
  }));
  app.post('/api/network/stock/restocked', ...network, route(async (req, res) => {
    const v = valid(z.object({ unit_id: uuid, key: code }).strict(), req, res); if (!v) return;
    if (!(await unitOk(q, req, v.unit_id))) return bad(res, 403, 'Unidade fora do seu acesso.');
    const r = await q(`UPDATE products p SET restock_pending = 0 WHERE p.tenant_id = $1 AND p.active AND ${KEY} = $2`, [v.unit_id, v.key]);
    res.json({ cleared: r.rowCount });
  }));

  // ---------- Histórico: toda mudança de estoque das unidades da pessoa ----------
  const LOG_KINDS = ['entry', 'sale', 'cancel', 'adjust', 'edit', 'restore', 'delete', 'transfer_out', 'transfer_in', 'count'];
  app.get('/api/network/stock/log', ...network, route(async (req, res) => {
    const units = await myUnits(q, req), uid = String(req.query.unit_id || ''), kind = String(req.query.kind || ''), term = String(req.query.q || '').trim().slice(0, 80);
    if (uid && !units.some(u => u.id === uid)) return bad(res, 403, 'Unidade fora do seu acesso.');
    if (kind && !LOG_KINDS.includes(kind)) return bad(res, 400, 'Tipo inválido');
    const dayOf = x => /^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : '';
    const before = req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before).toISOString() : '';
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 100));
    const r = await q(`SELECT m.id, m.created_at, m.kind, m.quantity, m.stock_before, m.stock_after, m.note, coalesce(t.unit_label, t.name) unit,
        p.name, ${KEY} "key", x.sale_number, u.name who
      FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN tenants t ON t.id = m.tenant_id
      LEFT JOIN sales x ON x.id = m.sale_id LEFT JOIN users u ON u.id = m.created_by
      WHERE m.tenant_id = ANY($1::uuid[]) AND ($2 = '' OR m.kind = $2)
        AND ($3 = '' OR fp_fold(p.name) LIKE '%'||fp_fold($3)||'%' OR p.code = $3 OR p.barcode = $3)
        AND ($4 = '' OR m.created_at >= ($4::date)::timestamp AT TIME ZONE $7) AND ($5 = '' OR m.created_at < ($5::date + 1)::timestamp AT TIME ZONE $7)
        AND ($6 = '' OR m.created_at < $6::timestamptz)
      ORDER BY m.created_at DESC, m.id DESC LIMIT $8`, [uid ? [uid] : units.map(u => u.id), kind, term, dayOf(req.query.from), dayOf(req.query.to), before, TZ, limit]);
    res.set('Cache-Control', 'no-store').json({ rows: r.rows, more: r.rowCount === limit });
  }));

  // ---------- Preços: reajuste em lote (toda a rede ou uma família), com prévia ----------
  app.post('/api/network/prices/reprice', ...network, route(async (req, res) => {
    const v = valid(z.object({ percent: z.number().min(-90).max(500).refine(n => n !== 0, 'Informe o percentual'), rounding: z.enum(['none', '0.10', '0.50', '1.00']).default('none'),
      family: z.string().trim().max(80).optional(), preview: z.boolean().default(false) }).strict(), req, res); if (!v) return;
    const ids = (await allUnits(q, req)).map(u => u.id);
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const rows = (await c.query(`SELECT ${KEY} "key", max(p.name) name, max(p.price_cents) price_cents FROM products p
        WHERE p.tenant_id = ANY($1::uuid[]) AND p.active AND p.kind = 'product' AND p.price_cents > 0 AND ($2 = '' OR p.family = $2) AND ${KEY} IS NOT NULL
        GROUP BY 1 ORDER BY lower(max(p.name))`, [ids, v.family || ''])).rows;
      if (!rows.length) { await c.query('ROLLBACK'); return bad(res, 400, 'Nenhuma peça com preço para reajustar'); }
      const items = rows.map(r => ({ key: r.key, name: r.name, old_cents: r.price_cents, new_cents: newPrice(r.price_cents, v.percent, v.rounding) }));
      if (v.preview) { await c.query('ROLLBACK'); return res.json({ preview: true, count: items.length, items: items.slice(0, 300) }); }
      for (const it of items) await c.query(`UPDATE products p SET price_cents = $3, updated_at = now() WHERE p.tenant_id = ANY($1::uuid[]) AND p.active AND p.kind = 'product' AND ${KEY} = $2`, [ids, it.key, it.new_cents]);
      await c.query('COMMIT');
      await audit(req, 'reprice', 'network', req.user.network_id, null);
      res.status(201).json({ count: items.length, items: items.slice(0, 300) });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // ---------- Valor do estoque (só o dono): custo e preço de venda do que está em estoque, por unidade ----------
  app.get('/api/network/stock/value', ...network, ownerOnly, route(async (req, res) => {
    const units = await allUnits(q, req);
    const r = await q(`SELECT p.tenant_id, count(*)::int items, sum(p.stock_qty)::int qty, coalesce(sum(p.stock_qty * p.cost_cents) FILTER (WHERE p.cost_cents IS NOT NULL), 0)::bigint cost_cents,
        coalesce(sum(p.stock_qty * p.price_cents), 0)::bigint price_cents,
        coalesce(sum(p.stock_qty * p.price_cents) FILTER (WHERE p.cost_cents IS NOT NULL), 0)::bigint priced_cents, count(*) FILTER (WHERE p.cost_cents IS NULL)::int no_cost
      FROM products p WHERE p.tenant_id = ANY($1::uuid[]) AND p.active AND p.kind = 'product' AND p.stock_qty > 0 GROUP BY 1`, [units.map(u => u.id)]);
    const by = new Map(r.rows.map(x => [x.tenant_id, x]));
    const rows = units.map(u => { const x = by.get(u.id) || {}; return { unit_id: u.id, unit: u.label, depot: u.depot, items: x.items || 0, qty: x.qty || 0, cost_cents: Number(x.cost_cents || 0), price_cents: Number(x.price_cents || 0), no_cost: x.no_cost || 0, profit_cents: Number(x.priced_cents || 0) - Number(x.cost_cents || 0) }; });
    const total = rows.reduce((a, x) => { for (const k of ['items', 'qty', 'cost_cents', 'price_cents', 'no_cost', 'profit_cents']) a[k] += x[k]; return a; }, { items: 0, qty: 0, cost_cents: 0, price_cents: 0, no_cost: 0, profit_cents: 0 });
    res.set('Cache-Control', 'no-store').json({ rows, total });
  }));
}
