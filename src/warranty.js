// Garantia digital das joias (rede): comprovante público da venda (/g/<código>) com os prazos de garantia,
// e registro de atendimentos de garantia no quiosque (troca, conserto, devolução), com prazo de 30 dias para resolver.
import crypto from 'node:crypto';
import { z } from 'zod';
import { pinOk } from './kiosk.js';

const CLAIM_DAYS = 30;
export const newReceiptCode = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);

export function registerWarranty(app, { q, auth, roles, route, bad, valid, audit, uuid, rateLimit, bcrypt }) {
  const kioskStaff = [auth, roles('owner', 'operator')];
  const network = [auth, roles('network')];
  const tz = 'America/Fortaleza';
  const saleView = async code => {
    const r = await q(`SELECT x.id, x.tenant_id, x.receipt_code, x.sale_number, x.total_cents, x.payment_method, x.canceled_at,
        to_char(x.created_at AT TIME ZONE $2, 'YYYY-MM-DD') sold_on, to_char(x.created_at AT TIME ZONE $2, 'DD/MM/YYYY HH24:MI') sold_at,
        coalesce(t.unit_label, t.name) unit, t.name store_name, t.cnpj, t.network_id, n.name network_name, n.warranty_rules, t.google_review_url, c.name customer_name,
        coalesce((SELECT json_agg(json_build_object('name', i.name, 'code', i.barcode, 'quantity', i.quantity, 'total_cents', i.total_cents) ORDER BY i.position) FROM sale_items i WHERE i.sale_id = x.id), '[]') items
      FROM sales x JOIN tenants t ON t.id = x.tenant_id LEFT JOIN store_networks n ON n.id = t.network_id LEFT JOIN customers c ON c.id = x.customer_id
      WHERE x.receipt_code = $1`, [code, tz]);
    const s = r.rows[0]; if (!s) return null;
    const base = new Date(s.sold_on + 'T12:00:00Z');
    s.warranties = (s.warranty_rules || []).map(w => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + Number(w.days)); return { label: w.label, days: w.days, until: d.toISOString().slice(0, 10) }; });
    s.units = s.network_id ? (await q("SELECT coalesce(unit_label, name) name FROM tenants WHERE network_id = $1 AND status IN ('trial','active') ORDER BY 1", [s.network_id])).rows.map(u => u.name) : [];
    return s;
  };

  // Comprovante público: só pelo código (8 caracteres aleatórios), sem dados de contato da cliente.
  app.get('/api/public/receipt/:code', rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }), route(async (req, res) => {
    const code = String(req.params.code || '');
    if (!/^[A-Za-z0-9]{8}$/.test(code)) return bad(res, 404, 'Comprovante não encontrado');
    const s = await saleView(code); if (!s) return bad(res, 404, 'Comprovante não encontrado');
    const first = (s.customer_name || '').split(' ')[0] || null;
    res.set('Cache-Control', 'no-store').json({ code: s.receipt_code, store: s.network_name || s.store_name, unit: s.unit, sale_number: s.sale_number, sold_at: s.sold_at,
      total_cents: s.total_cents, canceled: !!s.canceled_at, customer_first_name: first, items: s.items, warranties: s.warranties, units: s.units, review_url: s.google_review_url || null });
  }));
  app.get('/g/:code', (_req, res) => res.sendFile('garantia.html', { root: 'public' }));

  // Quiosque: consulta a garantia pelo código do comprovante (vale em qualquer unidade da rede).
  app.get('/api/store/warranty/:code', ...kioskStaff, route(async (req, res) => {
    const s = await saleView(String(req.params.code || '').trim());
    const me = (await q('SELECT network_id FROM tenants WHERE id = $1', [req.user.tenant_id])).rows[0];
    if (!s || (s.tenant_id !== req.user.tenant_id && (!me?.network_id || me.network_id !== s.network_id))) return bad(res, 404, 'Comprovante não encontrado nesta rede');
    const claims = (await q(`SELECT w.id, w.kind, w.note, to_char(w.opened_at AT TIME ZONE $2, 'DD/MM/YYYY') opened, w.closed_at IS NOT NULL closed, coalesce(t.unit_label, t.name) unit
      FROM warranty_claims w JOIN tenants t ON t.id = w.tenant_id WHERE w.sale_id = $1 ORDER BY w.opened_at`, [s.id, tz])).rows;
    res.set('Cache-Control', 'no-store').json({ id: s.id, code: s.receipt_code, unit: s.unit, sale_number: s.sale_number, sold_at: s.sold_at, total_cents: s.total_cents, canceled: !!s.canceled_at,
      customer_name: s.customer_name, items: s.items, warranties: s.warranties, claims });
  }));
  app.post('/api/store/warranty/:code/claims', ...kioskStaff, route(async (req, res) => {
    const v = valid(z.object({ kind: z.enum(['troca', 'conserto', 'devolucao', 'outro']), note: z.string().trim().max(300).default(''), seller_id: uuid.optional(), seller_pin: z.string().regex(/^\d{4}$/).optional() }).strict(), req, res); if (!v) return;
    const s = await saleView(String(req.params.code || '').trim());
    const me = (await q('SELECT network_id FROM tenants WHERE id = $1', [req.user.tenant_id])).rows[0];
    if (!s || (s.tenant_id !== req.user.tenant_id && (!me?.network_id || me.network_id !== s.network_id))) return bad(res, 404, 'Comprovante não encontrado nesta rede');
    if (s.canceled_at) return bad(res, 409, 'Esta venda foi cancelada');
    let by = req.user.id;
    if (req.user.kiosk) {
      const who = v.seller_id ? (await q('SELECT id, name FROM users WHERE id = $1 AND tenant_id = $2 AND active', [v.seller_id, req.user.tenant_id])).rows[0] : null;
      if (!who || !(await pinOk({ query: q }, bcrypt, who.id, v.seller_pin))) return bad(res, 401, 'PIN incorreto');
      by = who.id;
    }
    const r = await q(`INSERT INTO warranty_claims(tenant_id, sale_id, kind, note, opened_by, due_on)
      VALUES($1, $2, $3, $4, $5, ((now() AT TIME ZONE $6)::date + $7::int)) RETURNING id, to_char(due_on, 'DD/MM/YYYY') due`, [req.user.tenant_id, s.id, v.kind, v.note || null, by, tz, CLAIM_DAYS]);
    await audit(req, 'create', 'warranty_claim', r.rows[0].id); res.status(201).json(r.rows[0]);
  }));

  // Painel da rede: garantias em aberto (prazo de 30 dias) e encerramento.
  app.post('/api/network/warranty-claims/:id/close', ...network, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Atendimento inválido');
    const v = valid(z.object({ note: z.string().trim().max(300).default('') }).strict(), req, res); if (!v) return;
    const r = await q(`UPDATE warranty_claims w SET closed_at = now(), closed_by = $3, close_note = nullif($4, '') FROM tenants t
      WHERE w.id = $1 AND t.id = w.tenant_id AND t.network_id = $2 AND w.closed_at IS NULL
        AND (NOT $5::boolean OR t.id = ANY($6::uuid[])) RETURNING w.id`,
      [req.params.id, req.user.network_id, req.user.id, v.note, req.user.network_access === 'supervisor', req.user.network_unit_ids || []]);
    if (!r.rowCount) return bad(res, 404, 'Atendimento não encontrado');
    await audit(req, 'close', 'warranty_claim', req.params.id); res.json({ closed: true });
  }));
}

// Atendimentos de garantia em aberto, para o painel da rede.
export async function openClaims(q, networkId, unitIds) {
  return (await q(`SELECT w.id, coalesce(t.unit_label, t.name) unit, w.kind, w.note, x.sale_number, x.receipt_code,
      to_char(w.opened_at AT TIME ZONE 'America/Fortaleza', 'DD/MM') opened, to_char(w.due_on, 'DD/MM') due, w.due_on < (now() AT TIME ZONE 'America/Fortaleza')::date late
    FROM warranty_claims w JOIN tenants t ON t.id = w.tenant_id JOIN sales x ON x.id = w.sale_id
    WHERE t.network_id = $1 AND ($2::uuid[] IS NULL OR t.id = ANY($2)) AND w.closed_at IS NULL ORDER BY w.due_on LIMIT 200`, [networkId, unitIds])).rows;
}
