import { codeEq } from './code-match.js';
// Estoque centralizado: lista completa das peças da rede com a quantidade em cada unidade,
// já aberta (sem precisar digitar). Vendedora (quiosque), supervisor e dono veem a mesma lista.
// As peças casam entre unidades pelo código da loja; sem código, a peça aparece só na unidade dela.
const UNITS = `SELECT id, coalesce(unit_label, name) label, depot FROM tenants WHERE network_id = $1 AND status IN ('trial','active') ORDER BY depot DESC, lower(coalesce(unit_label, name))`;

export async function stockMatrix(q, networkId, mineId, opts = {}) {
  const units = (await q(UNITS, [networkId])).rows;
  const term = String(opts.q || '').trim().slice(0, 80);
  const family = String(opts.family || '').trim().slice(0, 80);
  const only = ['in_stock', 'mine_zero', 'zero'].includes(opts.only) ? opts.only : '';
  const limit = Math.min(Math.max(Number(opts.limit) || 300, 1), 1000), offset = Math.max(Number(opts.offset) || 0, 0);
  const ids = units.map(u => u.id);
  const r = await q(`WITH p AS (
      SELECT coalesce(p.code, p.id::text) k, p.code, p.name, p.price_cents, p.family, p.barcode, p.tenant_id, coalesce(p.stock_qty, 0) qty
        FROM products p WHERE p.tenant_id = ANY($1::uuid[]) AND p.active AND p.kind = 'product'),
    g AS (SELECT k, max(code) code,
        coalesce(max(name) FILTER (WHERE tenant_id = $2), max(name)) name,
        coalesce(max(price_cents) FILTER (WHERE tenant_id = $2), max(price_cents)) price_cents,
        max(family) family, jsonb_object_agg(tenant_id, qty) stock, sum(greatest(qty,0))::int total,
        coalesce(sum(qty) FILTER (WHERE tenant_id = $2), 0)::int mine, bool_or(fp_fold(name) LIKE '%'||fp_fold($3)||'%' OR ${codeEq('code','$3')} OR ${codeEq('barcode','$3')}) hit
      FROM p GROUP BY k)
    SELECT k, code, name, price_cents, family, stock, total, mine, count(*) OVER() n FROM g
     WHERE ($3 = '' OR hit) AND ($4 = '' OR family = $4)
       AND ($5 = '' OR ($5 = 'in_stock' AND total > 0) OR ($5 = 'zero' AND total <= 0) OR ($5 = 'mine_zero' AND mine <= 0 AND total > 0))
     ORDER BY lower(name), k LIMIT $6 OFFSET $7`, [ids, mineId, term, family, only, limit, offset]);
  const families = (await q(`SELECT DISTINCT family FROM products WHERE tenant_id = ANY($1::uuid[]) AND active AND family IS NOT NULL ORDER BY 1 LIMIT 300`, [ids])).rows.map(x => x.family);
  return { units: units.map(u => ({ ...u, mine: u.id === mineId })), families, total: Number(r.rows[0]?.n || 0), offset, limit,
    items: r.rows.map(({ n, k, ...x }) => ({ ...x, key: k, stock: units.map(u => Number(x.stock[u.id] ?? 0)), has: units.map(u => u.id in x.stock) })) };
}

export function registerStockMatrix(app, { q, auth, roles, route }) {
  // Quiosque / loja: a rede da própria unidade.
  app.get('/api/store/stock/matrix', auth, roles('owner', 'operator'), route(async (req, res) => {
    const t = (await q('SELECT id, network_id FROM tenants WHERE id = $1', [req.user.tenant_id])).rows[0];
    if (!t?.network_id) return res.json({ units: [], items: [], families: [], total: 0 });
    res.set('Cache-Control', 'no-store').json(await stockMatrix(q, t.network_id, t.id, req.query));
  }));
  // Painel da rede: dono e supervisor veem todas as unidades (saber onde tem a peça ajuda a vender).
  app.get('/api/network/stock/matrix', auth, roles('network'), route(async (req, res) => {
    const mine = /^[0-9a-f-]{36}$/i.test(req.query.unit || '') ? req.query.unit : null;
    res.set('Cache-Control', 'no-store').json(await stockMatrix(q, req.user.network_id, mine, req.query));
  }));
}
