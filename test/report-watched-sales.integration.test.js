import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL';

// Relatório mensal: vendas lançadas para um cliente vigiado (o dono que pega itens do estoque para permuta)
// saem numa seção à parte, com vendedor, itens, preço normal, cobrado e custo.
test('relatório mensal: seção à parte com as vendas para o telefone vigiado', { skip }, async () => {
  const { reportData, reportHtml } = await import('../src/reports.js');
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, db } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const tela = await api('/store/products', { method: 'POST', body: { name: 'Tela A12', barcode: 'TA12', price_cents: 15000, cost_cents: 6000 } }, 201);
    const cabo = await api('/store/products', { method: 'POST', body: { name: 'Cabo USB', barcode: 'CB1', price_cents: 2500, cost_cents: 800 } }, 201);
    const pai = await api('/customers', { method: 'POST', body: { name: 'Elias', phone: '(85) 98765-9139' } }, 201);
    const outro = await api('/customers', { method: 'POST', body: { name: 'Outro', phone: '85911112222' } }, 201);
    // Vendedor lança 2 telas no preço de custo e um cabo abaixo do custo para o pai; uma venda normal para outro cliente.
    await api('/store/sales', { method: 'POST', body: { customer_id: pai.id, payment_method: 'cash', items: [{ product_id: tela.id, quantity: 2, unit_price_cents: 6000 }] } }, 201);
    await api('/store/sales', { method: 'POST', body: { customer_id: pai.id, payment_method: 'pix', items: [{ product_id: cabo.id, quantity: 1, unit_price_cents: 500 }] } }, 201);
    await api('/store/sales', { method: 'POST', body: { customer_id: outro.id, payment_method: 'pix', items: [{ product_id: cabo.id, quantity: 1 }] } }, 201);
    await api('/store/sales/pending', { method: 'POST', body: { customer_id: pai.id, items: [{ product_id: cabo.id, quantity: 1, unit_price_cents: 800 }], description: 'leva depois' } }, 201);

    // Configuração: só o número de 8 dígitos já basta (compara os últimos 8 dígitos).
    assert.equal((await request('/store/reports/settings', { method: 'PATCH', body: { report_email: '', report_daily: true, report_weekly: true, report_monthly: true, report_watch_phones: ['87659139'] } })).status, 401, 'pede a senha do admin');
    const saved = await api('/store/reports/settings', { method: 'PATCH', admin: true, body: { report_email: '', report_daily: true, report_weekly: true, report_monthly: true, report_watch_phones: ['8765-9139', '8765-9139'] } });
    assert.deepEqual(saved.report_watch_phones, ['87659139']);
    assert.deepEqual((await api('/store/reports/settings', { admin: true })).report_watch_phones, ['87659139']);
    // Salvar sem o campo (tela antiga) não apaga o que estava.
    await api('/store/reports/settings', { method: 'PATCH', admin: true, body: { report_email: '', report_daily: true, report_weekly: true, report_monthly: true } });
    assert.equal((await request('/store/reports/settings', { method: 'PATCH', admin: true, body: { report_email: '', report_daily: true, report_weekly: true, report_monthly: true, report_watch_phones: ['abc'] } })).status, 400);

    const day = (await db.query("SELECT to_char(now() AT TIME ZONE 'America/Fortaleza','YYYY-MM-DD') d")).rows[0].d;
    const q = db.query.bind(db);
    const m = await reportData(q, tenant, 'monthly', day);
    assert.equal(m.watched.length, 1);
    const w = m.watched[0];
    assert.equal(w.name, 'Elias'); assert.equal(w.sales.length, 2);
    assert.equal(w.total, 12500); assert.equal(w.list_total, 32500); assert.equal(w.cost_total, 12800); assert.equal(w.qty, 3);
    assert.equal(w.pending.length, 1); assert.equal(w.pending_total, 800);
    assert.equal(m.sales_total, 15000, 'as vendas para ele continuam nos totais da loja');
    const html = reportHtml(m);
    for (const t of ['À parte: vendas lançadas para Elias · ', '2× Tela A12', '1× Cabo USB', '(no custo)', '(abaixo do custo)', 'A receber no nome dele', 'leva depois', 'desconto dado']) assert.ok(html.includes(t), t);
    assert.ok(!html.includes('1× Cabo USB</td><td style="text-align:right;border-bottom:1px solid #f0f1f3;padding:6px 4px;vertical-align:top">R$ 25'), 'venda de outro cliente fora da seção');

    // Diário e semanal não têm a seção; mensal sem telefone configurado também não.
    assert.deepEqual((await reportData(q, tenant, 'daily', day)).watched, []);
    assert.ok(!reportHtml(await reportData(q, tenant, 'weekly', day)).includes('À parte'));
    await db.query("UPDATE tenants SET report_watch_phones='{}' WHERE id=$1", [tenant]);
    assert.ok(!reportHtml(await reportData(q, tenant, 'monthly', day)).includes('À parte'));
  } finally { await f.cleanup(); }
});
