// Comprovante de venda para imprimir (não fiscal), enquanto a NFC-e não sai no quiosque.
// Mesmos dados do comprovante digital (/g/<código>), com preços por item, desconto, forma, parcelas e QR da garantia.
import QRCode from 'qrcode';

export function registerSalePrint(app, { q, auth, roles, route, bad, uuid }) {
  const staff = [auth, roles('owner', 'operator')];
  const tz = 'America/Fortaleza';
  app.get('/api/store/sales/:id/print', ...staff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Venda inválida');
    const r = await q(`SELECT x.id, x.sale_number, x.total_cents, x.discount_cents, x.cashback_used_cents, x.cashback_earned_cents, x.payment_method, x.payments, x.installments,
        x.receipt_code, x.canceled_at, x.offline_payment, to_char(x.created_at AT TIME ZONE $3, 'DD/MM/YYYY HH24:MI') sold_at, to_char(x.created_at AT TIME ZONE $3, 'YYYY-MM-DD') sold_on,
        coalesce(t.unit_label, t.name) unit, t.name store_name, t.legal_name, t.cnpj, t.fiscal_address, t.whatsapp, n.name network_name, n.warranty_rules,
        c.name customer_name, sl.name seller_name,
        coalesce((SELECT json_agg(json_build_object('name', i.name, 'code', i.barcode, 'quantity', i.quantity, 'unit_price_cents', i.unit_price_cents, 'list_price_cents', i.list_price_cents, 'total_cents', i.total_cents) ORDER BY i.position) FROM sale_items i WHERE i.sale_id = x.id), '[]') items
      FROM sales x JOIN tenants t ON t.id = x.tenant_id LEFT JOIN store_networks n ON n.id = t.network_id
        LEFT JOIN customers c ON c.id = x.customer_id LEFT JOIN users sl ON sl.id = x.seller_id
      WHERE x.id = $1 AND x.tenant_id = $2`, [req.params.id, req.user.tenant_id, tz]);
    const s = r.rows[0]; if (!s) return bad(res, 404, 'Venda não encontrada');
    const base = new Date(s.sold_on + 'T12:00:00Z');
    const warranties = (s.warranty_rules || []).map(w => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + Number(w.days)); return { label: w.label, days: w.days, until: d.toISOString().slice(0, 10) }; });
    const url = s.receipt_code ? `${req.protocol}://${req.get('host')}/g/${s.receipt_code}` : null;
    const qr = url ? await QRCode.toDataURL(url, { margin: 0, width: 220, errorCorrectionLevel: 'M' }) : null;
    const a = s.fiscal_address || {};
    res.set('Cache-Control', 'no-store').json({
      store: s.network_name || s.store_name, unit: s.unit, legal_name: s.legal_name || null, cnpj: s.cnpj || null, whatsapp: s.whatsapp || null,
      address: a.street ? [a.street + (a.number ? ', ' + a.number : ''), a.district, a.city].filter(Boolean).join(' - ') : null,
      sale_number: s.sale_number, sold_at: s.sold_at, canceled: !!s.canceled_at, seller: s.seller_name ? s.seller_name.split(' ')[0] : null, customer: s.customer_name || null,
      items: s.items, subtotal_cents: s.items.reduce((t, i) => t + Number(i.unit_price_cents ?? 0) * Number(i.quantity || 1), 0), discount_cents: Number(s.discount_cents || 0),
      cashback_used_cents: Number(s.cashback_used_cents || 0), cashback_earned_cents: Number(s.cashback_earned_cents || 0), total_cents: s.total_cents,
      payment_method: s.payment_method, payments: s.payments, installments: s.installments || 1, receipt_code: s.receipt_code, url, qr, warranties });
  }));
}
