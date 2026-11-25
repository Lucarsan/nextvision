// NFC-e (modelo 65): monta o cupom a partir da venda, independente do emissor (Focus, NFE.io…).
// Nada é transmitido aqui: buildNfce devolve o documento neutro e a lista do que impede a emissão;
// toFocus converte para o JSON da Focus NFe (campos de pagamento conferidos na documentação dela).
// Regras da Audace (contador, 24/11/2026): CFOP 5102, CSOSN 102, CEST 28.058.00, origem 0,
// PIS/COFINS CST 08, série 10 a partir do nº 1 por CNPJ. Pagamentos pela IN 87/2025 (SEFAZ-CE).
import { z } from 'zod';

const TZ = 'America/Fortaleza';
const DEFAULTS = { cfop: '5102', csosn: '102', cest: '2805800', pis_cofins_cst: '08', origin: 0 };
// Meio de pagamento (tPag) por forma do caixa. Pix pelo pinpad/Stone é dinâmico (17); Pix sem TEF é estático (20).
const TPAG = { cash: '01', credit: '03', debit: '04', pix: '17', other: '99' };
const ELECTRONIC = new Set(['credit', 'debit', 'pix']);
const digits = v => String(v || '').replace(/\D/g, '');
const money = c => Number((c / 100).toFixed(2));

// Reparte as formas de pagamento da venda (uma só ou dividida) e junta os dados do TEF de cada uma.
function paymentsOf(sale) {
  const list = sale.payment_method === 'mixed' && Array.isArray(sale.payments) ? sale.payments.map(p => ({ method: p.method, amount_cents: p.amount_cents })) : [{ method: sale.payment_method, amount_cents: sale.total_cents }];
  const tef = Array.isArray(sale.tef) ? sale.tef.slice() : [];
  return list.map(p => {
    const i = tef.findIndex(t => t.method === p.method && (!t.amount_cents || t.amount_cents === p.amount_cents));
    return { ...p, tef: i >= 0 ? tef.splice(i, 1)[0] : null };
  });
}

export function buildNfce({ tenant, network = null, sale, items, products = new Map(), customer = null, number = null }) {
  const rules = { ...DEFAULTS, ...(network?.fiscal_defaults || {}) };
  const problems = [];
  if (!/^\d{14}$/.test(tenant.cnpj || '')) problems.push('Unidade sem CNPJ');
  if (!tenant.state_registration) problems.push('Unidade sem inscrição estadual (IE)');
  if (!tenant.legal_name) problems.push('Unidade sem razão social');
  if (sale.canceled_at) problems.push('Venda cancelada');

  const det = [];
  for (const it of items) {
    if (it.gift) continue; // brinde (valor zero) não entra no cupom
    const p = it.product_id ? products.get(it.product_id) : null;
    const n = det.length + 1, gross = it.unit_price_cents * it.quantity;
    const ncm = p?.ncm || null;
    if (!p) problems.push(`Item ${n} (${it.name}) sem produto cadastrado: falta NCM`);
    else if (!ncm) problems.push(`Item ${n} (${it.name}) sem NCM`);
    det.push({
      n, code: p?.code || p?.barcode || it.barcode || String(n), name: [it.name, it.variant_name].filter(Boolean).join(' ').slice(0, 120),
      ncm, cest: p?.cest || rules.cest, cfop: p?.cfop || rules.cfop, csosn: p?.csosn || rules.csosn, origin: rules.origin,
      pis_cofins_cst: rules.pis_cofins_cst, unit: 'UN', quantity: it.quantity, unit_cents: it.unit_price_cents,
      gross_cents: gross, discount_cents: Math.max(0, gross - it.total_cents), total_cents: it.total_cents,
    });
  }
  if (!det.length) problems.push('Venda sem itens de produto');
  const itemsTotal = det.reduce((a, d) => a + d.total_cents, 0);
  if (det.length && itemsTotal !== sale.total_cents) problems.push('Soma dos itens diferente do total da venda');

  const pays = paymentsOf(sale).map(p => {
    const out = { tpag: TPAG[p.method] || '99', amount_cents: p.amount_cents, method: p.method };
    if (!ELECTRONIC.has(p.method)) return out;
    out.cnpj_receb = tenant.cnpj || null;
    if (sale.offline_payment) {
      // Pinpad fora do ar: pago na maquininha avulsa (não integrado); a conciliação vai no ECONF.
      Object.assign(out, { integration: 2, auth: sale.offline_auth || null, econf: true });
      return out;
    }
    if (!p.tef) {
      if (p.method === 'pix') out.tpag = '20';
      problems.push(p.method === 'pix' ? 'Pix sem dados do pinpad: a IN 87 exige Pix dinâmico vinculado' : `Pagamento no ${p.method === 'credit' ? 'crédito' : 'débito'} sem dados do TEF (autorização e bandeira)`);
      out.integration = 2; return out;
    }
    const t = p.tef;
    if (t.simulated) problems.push('Pagamento no pinpad simulado (teste): não pode virar cupom fiscal');
    Object.assign(out, { integration: 1, acquirer_cnpj: digits(t.acquirer_cnpj) || null, brand: t.brand || null, auth: t.auth || null, terminal_id: t.terminal_id || tenant.payment_terminal_id || null });
    if (!out.acquirer_cnpj) problems.push('Pagamento eletrônico sem CNPJ da credenciadora');
    if (!out.auth) problems.push('Pagamento eletrônico sem código de autorização');
    if (p.method !== 'pix' && !out.brand) problems.push('Cartão sem bandeira');
    if (!out.terminal_id) problems.push('Pagamento eletrônico sem identificação do terminal');
    return out;
  });

  const cpf = /^\d{11}$/.test(customer?.cpf || '') ? customer.cpf : null;
  const issued = sale.created_at ? new Date(sale.created_at) : new Date();
  const doc = {
    model: 65, env: tenant.fiscal_env || 'homologacao', series: tenant.nfce_series ?? 10, number,
    issued_at: issued.toISOString(), timezone: TZ, nature: 'Venda de mercadoria', presence: 1,
    issuer: { cnpj: tenant.cnpj || null, ie: tenant.state_registration || null, legal_name: tenant.legal_name || null, trade_name: tenant.unit_label || tenant.name, tax_regime: tenant.tax_regime ?? 1 },
    consumer: cpf ? { cpf, name: customer.name || null } : null,
    items: det,
    totals: { gross_cents: det.reduce((a, d) => a + d.gross_cents, 0), discount_cents: det.reduce((a, d) => a + d.discount_cents, 0), total_cents: sale.total_cents },
    payments: pays, change_cents: 0, sale_ref: { id: sale.id, number: sale.sale_number },
    econf_pending: pays.some(p => p.econf),
  };
  return { doc, problems: [...new Set(problems)], ready: problems.length === 0 };
}

// JSON da Focus NFe (POST /v2/nfce?ref=...). Campos de pagamento conferidos em campos.focusnfe.com.br em 24/11/2026;
// os demais seguem o padrão da API e devem ser confirmados na homologação.
export function toFocus(doc) {
  return {
    natureza_operacao: doc.nature,
    data_emissao: doc.issued_at,
    tipo_documento: 1,
    presenca_comprador: doc.presence,
    consumidor_final: 1,
    modalidade_frete: 9,
    local_destino: 1,
    cnpj_emitente: doc.issuer.cnpj,
    serie: doc.series,
    numero: doc.number,
    ...(doc.consumer ? { cpf_destinatario: doc.consumer.cpf, nome_destinatario: doc.consumer.name || undefined } : {}),
    items: doc.items.map(d => ({
      numero_item: d.n, codigo_produto: d.code, descricao: d.name, codigo_ncm: d.ncm, cest: d.cest, cfop: d.cfop,
      unidade_comercial: d.unit, quantidade_comercial: d.quantity, valor_unitario_comercial: money(d.unit_cents),
      unidade_tributavel: d.unit, quantidade_tributavel: d.quantity, valor_unitario_tributavel: money(d.unit_cents),
      valor_bruto: money(d.gross_cents), ...(d.discount_cents ? { valor_desconto: money(d.discount_cents) } : {}),
      icms_origem: d.origin, icms_situacao_tributaria: d.csosn, pis_situacao_tributaria: d.pis_cofins_cst, cofins_situacao_tributaria: d.pis_cofins_cst,
    })),
    formas_pagamento: doc.payments.map(p => ({
      forma_pagamento: p.tpag, valor_pagamento: money(p.amount_cents),
      ...(p.integration ? { tipo_integracao: p.integration } : {}),
      ...(p.acquirer_cnpj ? { cnpj_credenciadora: p.acquirer_cnpj } : {}),
      ...(p.brand ? { bandeira_operadora: p.brand } : {}),
      ...(p.auth ? { numero_autorizacao: p.auth } : {}),
      ...(p.cnpj_receb ? { cnpj_beneficiario: p.cnpj_receb } : {}),
      ...(p.terminal_id ? { id_terminal_pagamento: p.terminal_id } : {}),
    })),
    ...(doc.change_cents ? { valor_troco: money(doc.change_cents) } : {}),
  };
}

// Reserva o próximo número da série da unidade (dentro da transação de emissão).
export async function reserveNumber(client, tenantId) {
  const r = await client.query('UPDATE tenants SET nfce_next_number = nfce_next_number + 1 WHERE id=$1 RETURNING nfce_series, nfce_next_number - 1 AS number', [tenantId]);
  return r.rows[0];
}

async function loadSale(q, saleId) {
  const sale = (await q('SELECT * FROM sales WHERE id=$1', [saleId])).rows[0]; if (!sale) return null;
  const tenant = (await q('SELECT * FROM tenants WHERE id=$1', [sale.tenant_id])).rows[0];
  const network = tenant.network_id ? (await q('SELECT id,fiscal_defaults FROM store_networks WHERE id=$1', [tenant.network_id])).rows[0] : null;
  const items = (await q('SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY position', [sale.id])).rows;
  const ids = items.map(i => i.product_id).filter(Boolean);
  const products = new Map((ids.length ? (await q('SELECT id,code,barcode,ncm,cest,cfop,csosn FROM products WHERE id=ANY($1::uuid[])', [ids])).rows : []).map(p => [p.id, p]));
  const customer = sale.customer_id ? (await q('SELECT name,cpf FROM customers WHERE id=$1', [sale.customer_id])).rows[0] : null;
  return { sale, tenant, network, items, products, customer };
}

export function registerNfce(app, { q, auth, roles, route, bad, valid, audit, uuid }) {
  const master = [auth, roles('master')];
  // Prévia do cupom de uma venda: documento neutro, JSON da Focus e o que falta para emitir.
  app.get('/api/master/sales/:id/nfce-preview', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const data = await loadSale(q, req.params.id); if (!data) return bad(res, 404, 'Venda não encontrada');
    const number = data.tenant.nfce_next_number;
    const out = buildNfce({ ...data, number });
    res.set('Cache-Control', 'no-store').json({ ...out, focus: toFocus(out.doc) });
  }));
  // Dados fiscais da unidade (emitente).
  app.patch('/api/master/tenants/:id/fiscal', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({
      legal_name: z.string().trim().min(2).max(120).optional(),
      state_registration: z.preprocess(digits, z.string().regex(/^\d{2,14}$/, 'IE inválida')).optional(),
      tax_regime: z.number().int().min(1).max(4).optional(),
      nfce_series: z.number().int().min(0).max(999).optional(),
      nfce_next_number: z.number().int().min(1).max(999999999).optional(),
      fiscal_env: z.enum(['homologacao', 'producao']).optional(),
      payment_terminal_id: z.string().trim().min(1).max(40).nullable().optional(),
    }).strict(), req, res); if (!v) return;
    const keys = Object.keys(v); if (!keys.length) return bad(res, 400, 'Nada para alterar');
    if (v.nfce_series !== undefined || v.nfce_next_number !== undefined) {
      const used = (await q("SELECT 1 FROM fiscal_documents WHERE tenant_id=$1 AND status IN ('authorized','processing','contingency') LIMIT 1", [req.params.id])).rowCount;
      if (used) return bad(res, 409, 'A unidade já emitiu cupom: série e numeração não podem ser trocadas por aqui');
    }
    const r = await q(`UPDATE tenants SET ${keys.map((k, i) => k + '=$' + (i + 2)).join(',')} WHERE id=$1
      RETURNING id,cnpj,legal_name,state_registration,tax_regime,nfce_series,nfce_next_number,fiscal_env,fiscal_enabled,payment_terminal_id`, [req.params.id, ...keys.map(k => v[k])]);
    if (!r.rowCount) return bad(res, 404, 'Loja não encontrada');
    await audit(req, 'update_fiscal', 'tenant', req.params.id, req.params.id);
    res.json(r.rows[0]);
  }));
}
