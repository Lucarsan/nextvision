import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';
import { buildNfce, toFocus } from '../src/nfce.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('NFC-e: regras do contador, desconto rateado e pagamentos da IN 87', () => {
  const tenant = { cnpj: '46383376000123', state_registration: '069999999', legal_name: 'GRK JOIAS E ACESSORIOS LTDA', unit_label: 'Grand Shopping', nfce_series: 10, fiscal_env: 'homologacao', payment_terminal_id: 'PPC930-01' };
  const products = new Map([['p1', { id: 'p1', code: '0277', ncm: '71171900' }], ['p2', { id: 'p2', code: '62', ncm: '71131100', cest: '2805800' }]]);
  const items = [
    { product_id: 'p1', name: 'Colar', quantity: 2, unit_price_cents: 5000, total_cents: 9000 },
    { product_id: 'p2', name: 'Anel prata', quantity: 1, unit_price_cents: 10000, total_cents: 9000 },
    { product_id: 'p1', name: 'Brinde', quantity: 1, unit_price_cents: 0, total_cents: 0, gift: true },
  ];
  const sale = { id: 's1', sale_number: 7, total_cents: 18000, payment_method: 'mixed', payments: [{ method: 'cash', amount_cents: 3000 }, { method: 'credit', amount_cents: 15000 }],
    tef: [{ method: 'credit', amount_cents: 15000, acquirer_cnpj: '16.501.555/0001-57', brand: '02', auth: '123456' }] };
  const { doc, problems, ready } = buildNfce({ tenant, sale, items, products, number: 1 });
  assert.deepEqual(problems, []); assert.equal(ready, true);
  assert.equal(doc.series, 10); assert.equal(doc.number, 1); assert.equal(doc.items.length, 2, 'brinde fora');
  assert.deepEqual(doc.items.map(d => [d.cfop, d.csosn, d.cest, d.origin, d.pis_cofins_cst]), [['5102', '102', '2805800', 0, '08'], ['5102', '102', '2805800', 0, '08']]);
  assert.deepEqual(doc.items.map(d => d.discount_cents), [1000, 1000]);
  assert.deepEqual(doc.totals, { gross_cents: 20000, discount_cents: 2000, total_cents: 18000 });
  assert.deepEqual(doc.payments[0], { tpag: '01', amount_cents: 3000, method: 'cash' });
  assert.deepEqual(doc.payments[1], { tpag: '03', amount_cents: 15000, method: 'credit', cnpj_receb: '46383376000123', integration: 1, acquirer_cnpj: '16501555000157', brand: '02', auth: '123456', terminal_id: 'PPC930-01' });
  const f = toFocus(doc);
  assert.deepEqual(f.formas_pagamento[1], { forma_pagamento: '03', valor_pagamento: 150, tipo_integracao: 1, cnpj_credenciadora: '16501555000157', bandeira_operadora: '02', numero_autorizacao: '123456', cnpj_beneficiario: '46383376000123', id_terminal_pagamento: 'PPC930-01' });
  assert.equal(f.items[0].valor_bruto, 100); assert.equal(f.items[0].valor_desconto, 10); assert.equal(f.serie, 10);

  // Pix sem pinpad: vira estático e aparece como impedimento; pinpad fora do ar: não integrado + ECONF.
  const pix = buildNfce({ tenant, sale: { ...sale, payment_method: 'pix', payments: null, tef: null }, items, products });
  assert.equal(pix.doc.payments[0].tpag, '20'); assert.match(pix.problems.join(), /Pix dinâmico/);
  const off = buildNfce({ tenant, sale: { ...sale, payment_method: 'debit', payments: null, tef: null, offline_payment: true, offline_auth: '998877' }, items, products });
  assert.deepEqual(off.problems, []); assert.equal(off.doc.payments[0].integration, 2); assert.equal(off.doc.econf_pending, true);
  // Sem NCM / sem IE.
  const bad = buildNfce({ tenant: { ...tenant, state_registration: null }, sale, items: [{ name: 'Avulso', quantity: 1, unit_price_cents: 18000, total_cents: 18000 }], products });
  assert.match(bad.problems.join(' | '), /inscrição estadual/); assert.match(bad.problems.join(' | '), /falta NCM/);
});

test('NFC-e: prévia de uma venda real e dados fiscais da unidade', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, db } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await db.query("UPDATE tenants SET cnpj='46383376000123' WHERE id=$1", [tenant]);
    const fiscal = await api(`/master/tenants/${tenant}/fiscal`, { method: 'PATCH', token: masterToken, body: { legal_name: 'GRK JOIAS E ACESSORIOS LTDA', state_registration: '06.999.999-9', payment_terminal_id: 'T1' } });
    assert.equal(fiscal.state_registration, '069999999'); assert.equal(fiscal.nfce_series, 10); assert.equal(fiscal.nfce_next_number, 1); assert.equal(fiscal.fiscal_env, 'homologacao');
    const p = (await db.query("INSERT INTO products(tenant_id,name,price_cents,ncm,code) VALUES($1,'Colar',5000,'71171900','0277') RETURNING id", [tenant])).rows[0];
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const sale = await api('/store/sales', { method: 'POST', body: { anonymous: true, items: [{ product_id: p.id, quantity: 2 }], discount_cents: 500, payment_method: 'cash' } }, 201);
    const id = sale.id || sale.sale?.id;
    const pv = await api(`/master/sales/${id}/nfce-preview`, { token: masterToken });
    assert.deepEqual(pv.problems, []); assert.equal(pv.doc.number, 1);
    assert.equal(pv.doc.items[0].discount_cents, 500); assert.equal(pv.focus.formas_pagamento[0].forma_pagamento, '01');
    assert.equal((await request(`/master/sales/${id}/nfce-preview`, { token: f.ownerToken })).status, 403);
  } finally { await f.cleanup(); }
});
