// Rede (Audace), itens do Anexo II:
// - Correção de venda (vendedora, cliente, forma de pagamento) só por supervisor ou dono, com motivo e histórico.
// - Crédito de troca/devolução: vira saldo no cashback da cliente (vale em qualquer unidade), com PIN do supervisor/dono.
// - Estoque mínimo da rede para o alerta de reposição.
// - Exportação dos dados da rede em planilha (CSV), também com a conta bloqueada.
import { z } from 'zod';
import { pinOk, authorizerByPin } from './kiosk.js';
import { linkLocal } from './network-customers.js';

const TZ = 'America/Fortaleza';
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const csv = rows => '﻿' + rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(';')).join('\r\n');
const money = c => (Number(c || 0) / 100).toFixed(2).replace('.', ',');

export function registerNetworkExtras(app, { q, db, auth, roles, route, bad, valid, audit, uuid, bcrypt }) {
  const network = [auth, roles('network')];
  const kioskStaff = [auth, roles('owner', 'operator')];
  const inScope = (req, tenantId) => req.user.network_access !== 'supervisor' || (req.user.network_unit_ids || []).includes(tenantId);

  // ---- Correção de venda ----
  app.post('/api/network/sales/:id/correct', ...network, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ seller_id: uuid.optional(), customer_id: uuid.optional(), payment_method: z.enum(['cash', 'pix', 'debit', 'credit', 'other']).optional(), reason: z.string().trim().min(3).max(300) }).strict()
      .refine(x => x.seller_id || x.customer_id || x.payment_method, 'Nada para corrigir'), req, res); if (!v) return;
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const s = (await c.query(`SELECT s.*, t.network_id, t.cashback_enabled, t.cashback_percent, t.cashback_min_sale_cents, t.cashback_valid_days, t.cashback_off_weekdays
        FROM sales s JOIN tenants t ON t.id=s.tenant_id WHERE s.id=$1 FOR UPDATE OF s`, [req.params.id])).rows[0];
      if (!s || s.network_id !== req.user.network_id || !inScope(req, s.tenant_id)) { await c.query('ROLLBACK'); return bad(res, 404, 'Venda não encontrada'); }
      if (s.canceled_at) { await c.query('ROLLBACK'); return bad(res, 409, 'Venda cancelada não pode ser corrigida'); }
      const log = (field, oldV, newV) => c.query('INSERT INTO sale_corrections(sale_id,tenant_id,field,old_value,new_value,reason,corrected_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [s.id, s.tenant_id, field, oldV, newV, v.reason, req.user.id]);
      const out = {};
      if (v.seller_id && v.seller_id !== s.seller_id) {
        const who = (await c.query("SELECT id,name FROM users WHERE id=$1 AND tenant_id=$2 AND active AND login_kind='pin'", [v.seller_id, s.tenant_id])).rows[0];
        if (!who) { await c.query('ROLLBACK'); return bad(res, 400, 'Vendedora não é desta unidade'); }
        await c.query('UPDATE sales SET seller_id=$2 WHERE id=$1', [s.id, who.id]); await log('seller', s.seller_id, who.id); out.seller = who.name;
      }
      if (v.payment_method && v.payment_method !== s.payment_method) {
        if (s.payment_method === 'mixed') { await c.query('ROLLBACK'); return bad(res, 409, 'Venda com pagamento dividido: cancele e refaça'); }
        if ((await c.query("SELECT 1 FROM fiscal_documents WHERE sale_id=$1 AND status IN ('authorized','processing','contingency')", [s.id])).rowCount) { await c.query('ROLLBACK'); return bad(res, 409, 'O cupom fiscal já saiu com a forma de pagamento: cancele e refaça a venda'); }
        await c.query('UPDATE sales SET payment_method=$2 WHERE id=$1', [s.id, v.payment_method]); await log('payment_method', s.payment_method, v.payment_method); out.payment_method = v.payment_method;
      }
      if (v.customer_id && v.customer_id !== s.customer_id) {
        let cust = (await c.query('SELECT id,name,tenant_id FROM customers WHERE id=$1 AND deleted_at IS NULL', [v.customer_id])).rows[0];
        const custNet = cust ? (await c.query('SELECT network_id FROM tenants WHERE id=$1', [cust.tenant_id])).rows[0]?.network_id : null;
        if (!cust || custNet !== req.user.network_id) { await c.query('ROLLBACK'); return bad(res, 404, 'Cliente não encontrada na rede'); }
        if (s.cashback_used_cents > 0) { await c.query('ROLLBACK'); return bad(res, 409, 'A venda usou o cashback de outra cliente: cancele e refaça'); }
        // Ficha da cliente nesta unidade (cria ligada à da outra unidade, como no caixa).
        if (cust.tenant_id !== s.tenant_id) {
          const local = (await c.query('SELECT l.id FROM customers l JOIN customers o ON o.id=$2 WHERE l.tenant_id=$1 AND l.deleted_at IS NULL AND o.link_id IS NOT NULL AND l.link_id=o.link_id LIMIT 1', [s.tenant_id, cust.id])).rows[0];
          if (local) cust = { ...cust, id: local.id };
          else {
            const n = (await c.query(`INSERT INTO customers(tenant_id,name,phone,cpf,birth_date,offers_opt_out) SELECT $1,name,phone,cpf,birth_date,offers_opt_out FROM customers WHERE id=$2 RETURNING id`, [s.tenant_id, cust.id])).rows[0];
            await linkLocal(c, s.tenant_id, n.id); cust = { ...cust, id: n.id };
          }
        }
        const lot = (await c.query('SELECT id,amount_cents,remaining_cents FROM cashback_lots WHERE sale_id=$1 AND reversed_at IS NULL', [s.id])).rows[0];
        if (lot) {
          if (lot.remaining_cents !== lot.amount_cents) { await c.query('ROLLBACK'); return bad(res, 409, 'O cashback desta venda já foi usado: não dá para trocar a cliente'); }
          await c.query('UPDATE cashback_lots SET customer_id=$2 WHERE id=$1', [lot.id, cust.id]);
        } else if (s.cashback_enabled && s.total_cents >= s.cashback_min_sale_cents) {
          // Venda sem cliente: gera o cashback que ela teria ganhado no dia da compra (sem as peças marcadas "sem cashback").
          const dow = WEEKDAY[new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date(s.created_at))];
          if (!(s.cashback_off_weekdays || []).includes(dow)) {
            const base = (await c.query(`SELECT coalesce(sum(CASE WHEN p.cashback IS FALSE THEN 0 ELSE i.total_cents END),0)::int b, count(i.*)::int n FROM sale_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.sale_id=$1`, [s.id])).rows[0];
            const paid = base.n ? base.b : s.total_cents, earned = Math.floor(paid * Math.round(Number(s.cashback_percent) * 100) / 10000);
            if (earned >= 1) {
              await c.query(`INSERT INTO cashback_lots(tenant_id,customer_id,sale_id,amount_cents,remaining_cents,percent_snapshot,expires_on)
                VALUES($1,$2,$3,$4,$4,$5,(($6::timestamptz AT TIME ZONE '${TZ}')::date + $7::int))`, [s.tenant_id, cust.id, s.id, earned, s.cashback_percent, s.created_at, s.cashback_valid_days]);
              await c.query('UPDATE sales SET cashback_earned_cents=$2 WHERE id=$1', [s.id, earned]); out.cashback_earned_cents = earned;
            }
          }
        }
        await c.query('UPDATE sales SET customer_id=$2 WHERE id=$1', [s.id, cust.id]); await log('customer', s.customer_id, cust.id); out.customer = cust.name;
      }
      await c.query('COMMIT');
      await audit(req, 'correct', 'sale', s.id, s.tenant_id);
      res.json({ ok: true, ...out });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));
  app.get('/api/network/units/:id/sellers', ...network, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success || !inScope(req, req.params.id)) return bad(res, 404, 'Unidade não encontrada');
    const r = await q("SELECT u.id,u.name FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.tenant_id=$1 AND t.network_id=$2 AND u.active AND u.login_kind='pin' ORDER BY u.name", [req.params.id, req.user.network_id]);
    res.json(r.rows);
  }));
  app.get('/api/network/customers/search', ...network, route(async (req, res) => {
    const term = String(req.query.q || '').trim().slice(0, 80), digits = term.replace(/\D/g, '');
    if (term.length < 2) return res.json([]);
    const r = await q(`SELECT DISTINCT ON (coalesce(c.link_id,c.id)) c.id, c.name, c.phone, coalesce(t.unit_label,t.name) unit FROM customers c JOIN tenants t ON t.id=c.tenant_id
      WHERE t.network_id=$1 AND c.deleted_at IS NULL AND (fp_fold(c.name) LIKE '%'||fp_fold($2)||'%' OR (length($3)=11 AND c.cpf=$3) OR (length($3)>=8 AND regexp_replace(coalesce(c.phone,''),'\\D','','g') LIKE '%'||$3||'%'))
      ORDER BY coalesce(c.link_id,c.id), c.created_at LIMIT 10`, [req.user.network_id, term, digits]);
    res.json(r.rows);
  }));

  // ---- Crédito de troca/devolução (quiosque) ----
  // Decisão da Audace (27/11): a vendedora gera com o PIN dela (sem o PIN da supervisora); a supervisão acompanha no painel.
  // As peças que voltaram entram no estoque da unidade onde a troca é feita (casadas pelo código da peça).
  app.post('/api/store/warranty/claims/:id/credit', ...kioskStaff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({
      amount_cents: z.number().int().min(1).max(100000000),
      items: z.array(z.object({ sale_item_id: uuid, quantity: z.number().int().min(1).max(9999) }).strict()).max(200).default([]),
      seller_id: uuid.optional(), seller_pin: z.string().regex(/^\d{4}$/).optional(), supervisor_pin: z.string().regex(/^\d{4}$/).optional()
    }).strict(), req, res); if (!v) return;
    const w = (await q(`SELECT w.*, s.customer_id, s.total_cents, s.credit_used_cents, s.sale_number, s.tenant_id sale_tenant, t.network_id, n.credit_valid_days FROM warranty_claims w JOIN sales s ON s.id=w.sale_id
      JOIN tenants t ON t.id=w.tenant_id LEFT JOIN store_networks n ON n.id=t.network_id WHERE w.id=$1`, [req.params.id])).rows[0];
    if (!w || w.tenant_id !== req.user.tenant_id) return bad(res, 404, 'Atendimento não encontrado nesta unidade');
    if (!['troca', 'devolucao'].includes(w.kind)) return bad(res, 409, 'Crédito só para troca ou devolução');
    if (w.credit_cents) return bad(res, 409, 'Este atendimento já gerou crédito');
    if (!w.customer_id) return bad(res, 409, 'A venda não tem cliente: peça ao supervisor para incluir a cliente na venda (painel da rede) e tente de novo');
    if (v.amount_cents > w.total_cents + (w.credit_used_cents || 0)) return bad(res, 400, 'O crédito não pode passar do valor da venda');
    // Quem gera: a vendedora (PIN dela) ou, se mandarem, supervisor/gerente/dono (PIN dele). Fora do quiosque, o próprio usuário.
    let who = null;
    if (!req.user.kiosk) who = { id: req.user.id, name: null };
    else if (v.seller_id && v.seller_pin) {
      const u = (await q("SELECT id,name FROM users WHERE id=$1 AND tenant_id=$2 AND active", [v.seller_id, req.user.tenant_id])).rows[0];
      if (u && await pinOk({ query: q }, bcrypt, u.id, v.seller_pin)) who = u;
    } else if (v.supervisor_pin) who = await authorizerByPin({ query: q }, bcrypt, req.user.tenant_id, v.supervisor_pin);
    if (!who) return bad(res, 401, 'PIN incorreto');
    const c = await db.connect(); let returned = 0;
    try {
      await c.query('BEGIN');
      const upd = await c.query('UPDATE warranty_claims SET credit_cents=$2, credit_authorized_by=$3, credited_at=now() WHERE id=$1 AND credit_cents IS NULL', [w.id, v.amount_cents, who.id]);
      if (!upd.rowCount) { await c.query('ROLLBACK'); return bad(res, 409, 'Este atendimento já gerou crédito'); }
      for (const it of v.items) {
        const si = (await c.query(`SELECT i.id, i.name, i.quantity, i.product_id, p.code, p.barcode,
            (SELECT coalesce(sum(r.quantity),0) FROM warranty_returns r WHERE r.sale_item_id=i.id)::int back
          FROM sale_items i LEFT JOIN products p ON p.id=i.product_id WHERE i.id=$1 AND i.sale_id=$2 FOR UPDATE OF i`, [it.sale_item_id, w.sale_id])).rows[0];
        if (!si || !si.product_id) { await c.query('ROLLBACK'); return bad(res, 400, 'Peça não encontrada nesta venda'); }
        if (it.quantity > si.quantity - si.back) { await c.query('ROLLBACK'); return bad(res, 400, `${si.name}: só ${si.quantity - si.back} peça(s) podem voltar desta venda`); }
        // Mesma unidade: a própria peça. Outra unidade da rede: a peça com o mesmo código aqui.
        const pid = w.sale_tenant === req.user.tenant_id ? si.product_id
          : (await c.query("SELECT id FROM products WHERE tenant_id=$1 AND active AND kind='product' AND (($2::text IS NOT NULL AND code=$2) OR ($3::text IS NOT NULL AND barcode=$3)) ORDER BY (code=$2) DESC NULLS LAST LIMIT 1", [req.user.tenant_id, si.code || null, si.barcode || null])).rows[0]?.id;
        if (!pid) { await c.query('ROLLBACK'); return bad(res, 400, `${si.name}: a peça não está cadastrada nesta unidade (código ${si.code || si.barcode || '—'}). Peça ao supervisor para cadastrar e tente de novo.`); }
        const st = (await c.query('UPDATE products SET stock_qty=CASE WHEN stock_qty IS NULL THEN NULL ELSE LEAST(999999,stock_qty+$2) END, updated_at=now() WHERE id=$1 RETURNING stock_qty', [pid, it.quantity])).rows[0];
        await c.query(`INSERT INTO stock_movements(tenant_id,product_id,kind,quantity,created_by,stock_before,stock_after,note) VALUES($1,$2,'return',$3,$4,$5,$6,$7)`,
          [req.user.tenant_id, pid, it.quantity, who.id, st.stock_qty == null ? null : st.stock_qty - it.quantity, st.stock_qty, (w.kind === 'troca' ? 'Troca' : 'Devolução') + ' · venda nº ' + w.sale_number]);
        await c.query('INSERT INTO warranty_returns(claim_id,sale_item_id,tenant_id,product_id,quantity,created_by) VALUES($1,$2,$3,$4,$5,$6)', [w.id, si.id, req.user.tenant_id, pid, it.quantity, who.id]);
        returned += it.quantity;
      }
      await c.query(`INSERT INTO cashback_lots(tenant_id,customer_id,sale_id,amount_cents,remaining_cents,percent_snapshot,expires_on,kind,warranty_claim_id)
        VALUES($1,$2,NULL,$3,$3,0,(now() AT TIME ZONE '${TZ}')::date + $4::int,'credit',$5)`, [w.sale_tenant, w.customer_id, v.amount_cents, w.credit_valid_days || 180, w.id]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    await audit(req, 'credit', 'warranty_claim', w.id, req.user.tenant_id);
    res.status(201).json({ ok: true, credit_cents: v.amount_cents, authorized_by: who.name, returned_pieces: returned, valid_days: w.credit_valid_days || 180 });
  }));

  // ---- Estoque mínimo e validade do crédito (dono e supervisor) ----
  app.put('/api/network/settings/stock', ...network, route(async (req, res) => {
    const v = valid(z.object({ low_stock_min: z.number().int().min(0).max(1000), credit_valid_days: z.number().int().min(7).max(730) }).strict(), req, res); if (!v) return;
    await q('UPDATE store_networks SET low_stock_min=$2, credit_valid_days=$3 WHERE id=$1', [req.user.network_id, v.low_stock_min, v.credit_valid_days]);
    await audit(req, 'update', 'network_stock_settings', req.user.network_id);
    res.json({ ok: true });
  }));

  // ---- Exportação (dono da rede), em planilha CSV ----
  const EXPORTS = {
    vendas: { name: 'vendas', sql: `SELECT coalesce(t.unit_label,t.name) unidade, t.cnpj, s.sale_number numero, to_char(s.created_at AT TIME ZONE '${TZ}','DD/MM/YYYY HH24:MI') data,
        u.name vendedora, c.name cliente, c.cpf, s.total_cents, s.discount_cents, s.cashback_used_cents, s.cashback_earned_cents, s.payment_method forma, s.payments, s.receipt_code comprovante,
        CASE WHEN s.canceled_at IS NULL THEN '' ELSE 'cancelada' END situacao, s.cancel_reason
      FROM sales s JOIN tenants t ON t.id=s.tenant_id LEFT JOIN users u ON u.id=s.seller_id LEFT JOIN customers c ON c.id=s.customer_id
      WHERE t.network_id=$1 AND s.created_at >= ($2::date::timestamp AT TIME ZONE '${TZ}') AND s.created_at < ($3::date::timestamp AT TIME ZONE '${TZ}') + interval '1 day' ORDER BY s.created_at`,
      head: ['Unidade', 'CNPJ', 'Nº', 'Data', 'Vendedora', 'Cliente', 'CPF', 'Total (R$)', 'Desconto (R$)', 'Cashback usado (R$)', 'Cashback ganho (R$)', 'Forma', 'Formas (dividido)', 'Comprovante', 'Situação', 'Motivo do cancelamento'],
      row: r => [r.unidade, r.cnpj, r.numero, r.data, r.vendedora, r.cliente, r.cpf, money(r.total_cents), money(r.discount_cents), money(r.cashback_used_cents), money(r.cashback_earned_cents), r.forma,
        Array.isArray(r.payments) ? r.payments.map(p => p.method + ' ' + money(p.amount_cents)).join(' + ') : '', r.comprovante, r.situacao, r.cancel_reason] },
    itens: { name: 'itens-vendidos', sql: `SELECT coalesce(t.unit_label,t.name) unidade, s.sale_number numero, to_char(s.created_at AT TIME ZONE '${TZ}','DD/MM/YYYY') data, p.code, i.name, i.quantity, i.unit_price_cents, i.total_cents,
        CASE WHEN s.canceled_at IS NULL THEN '' ELSE 'cancelada' END situacao
      FROM sale_items i JOIN sales s ON s.id=i.sale_id JOIN tenants t ON t.id=s.tenant_id LEFT JOIN products p ON p.id=i.product_id
      WHERE t.network_id=$1 AND s.created_at >= ($2::date::timestamp AT TIME ZONE '${TZ}') AND s.created_at < ($3::date::timestamp AT TIME ZONE '${TZ}') + interval '1 day' ORDER BY s.created_at, i.position`,
      head: ['Unidade', 'Venda nº', 'Data', 'Código', 'Peça', 'Qtd', 'Preço (R$)', 'Total (R$)', 'Situação'],
      row: r => [r.unidade, r.numero, r.data, r.code, r.name, r.quantity, money(r.unit_price_cents), money(r.total_cents), r.situacao] },
    clientes: { name: 'clientes', sql: `SELECT DISTINCT ON (coalesce(c.link_id,c.id)) c.name, c.cpf, c.phone, c.email, to_char(c.birth_date,'DD/MM/YYYY') nascimento, c.offers_opt_out, coalesce(t.unit_label,t.name) unidade,
        (SELECT coalesce(sum(l.remaining_cents),0) FROM cashback_lots l JOIN customers g ON g.id=l.customer_id WHERE coalesce(g.link_id,g.id)=coalesce(c.link_id,c.id) AND l.kind='cashback' AND l.reversed_at IS NULL AND l.cleared_at IS NULL AND l.expires_on >= (now() AT TIME ZONE '${TZ}')::date) saldo,
        (SELECT coalesce(sum(l.remaining_cents),0) FROM cashback_lots l JOIN customers g ON g.id=l.customer_id WHERE coalesce(g.link_id,g.id)=coalesce(c.link_id,c.id) AND l.kind='credit' AND l.reversed_at IS NULL AND l.cleared_at IS NULL AND l.expires_on >= (now() AT TIME ZONE '${TZ}')::date) credito_troca
      FROM customers c JOIN tenants t ON t.id=c.tenant_id WHERE t.network_id=$1 AND c.deleted_at IS NULL ORDER BY coalesce(c.link_id,c.id), c.created_at`,
      head: ['Nome', 'CPF', 'Telefone', 'E-mail', 'Nascimento', 'Não quer ofertas', 'Unidade do cadastro', 'Saldo de cashback (R$)', 'Crédito de troca (R$)'],
      row: r => [r.name, r.cpf, r.phone, r.email, r.nascimento, r.offers_opt_out ? 'sim' : '', r.unidade, money(r.saldo), money(r.credito_troca)] },
    estoque: { name: 'estoque', sql: `SELECT coalesce(t.unit_label,t.name) unidade, p.code, p.barcode, p.name, p.ncm, p.price_cents, p.stock_qty
      FROM products p JOIN tenants t ON t.id=p.tenant_id WHERE t.network_id=$1 AND p.active ORDER BY 1, p.name`,
      head: ['Unidade', 'Código', 'Código de barras', 'Peça', 'NCM', 'Preço (R$)', 'Estoque'],
      row: r => [r.unidade, r.code, r.barcode, r.name, r.ncm, money(r.price_cents), r.stock_qty] },
  };
  // Dono da rede no painel; a central exporta por ele quando a rede está bloqueada (Anexo II e cl. 9.7).
  const sendExport = async (req, res, networkId) => {
    const x = EXPORTS[req.params.kind]; if (!x) return bad(res, 404, 'Exportação não encontrada');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '2000-01-01', to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const r = await q(x.sql, x.sql.includes('$2') ? [networkId, from, to] : [networkId]);
    await audit(req, 'export', 'network_' + x.name, networkId);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${x.name}-${today}.csv"`, 'Cache-Control': 'no-store' }).send(csv([x.head, ...r.rows.map(x.row)]));
  };
  app.get('/api/network/export/:kind', ...network, route(async (req, res) => {
    if (req.user.network_access === 'supervisor') return bad(res, 403, 'Só o dono da rede exporta os dados');
    await sendExport(req, res, req.user.network_id);
  }));
  app.get('/api/master/networks/:id/export/:kind', auth, roles('master'), route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    await sendExport(req, res, req.params.id);
  }));
}
