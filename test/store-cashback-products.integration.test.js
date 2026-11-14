import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('cashback por produto, reposição por produto e exclusão de saldo com senha do admin', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api('/store/sales/cashback', { method: 'PATCH', body: { cashback_enabled: true, cashback_percent: 3 } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);

    // Cadastro: padrão gera cashback e entra na reposição; troca de espécie desmarca as duas.
    const capa = await api('/store/products', { method: 'POST', body: { name: 'Capa iPhone', price_cents: 5000 } }, 201);
    assert.equal(capa.cashback, true); assert.equal(capa.restock, true);
    const troca = await api('/store/products', { method: 'POST', body: { name: 'Troca de espécie por pix', price_cents: 42000, cost_cents: 40000, cashback: false, restock: false } }, 201);
    assert.equal(troca.cashback, false); assert.equal(troca.restock, false);

    // Só a troca: não gera cashback e avisa o motivo.
    const s1 = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Lucas da Silva', phone: '85 98888-0001' }, payment_method: 'cash', items: [{ product_id: troca.id, quantity: 1 }] } }, 201);
    const lucas = s1.customer.id;
    assert.equal(s1.sale.cashback_earned_cents, 0); assert.equal(s1.sale.cashback_no_products, true); assert.equal(s1.cashback.balance_cents, 0);

    // Troca + capa: cashback só sobre a capa (3% de 50,00 = 1,50).
    const s2 = await api('/store/sales', { method: 'POST', body: { customer_id: lucas, payment_method: 'pix', items: [{ product_id: troca.id, quantity: 1 }, { product_id: capa.id, quantity: 1 }] } }, 201);
    assert.equal(s2.sale.cashback_earned_cents, 150); assert.equal(s2.cashback.balance_cents, 150);

    // Reposição: a capa aparece, a troca não.
    const restock = await api('/store/stock/restock');
    const names = (Array.isArray(restock) ? restock : restock.rows || restock.items || []).map(r => r.name);
    assert.ok(names.includes('Capa iPhone'), JSON.stringify(restock)); assert.ok(!names.includes('Troca de espécie por pix'));

    // Mudar a opção num produto já cadastrado pede a senha do admin; desmarcar a reposição zera o "repor".
    assert.equal((await request('/store/products/' + capa.id, { method: 'PATCH', body: { restock: false } })).status, 401);
    const capa2 = await api('/store/products/' + capa.id, { method: 'PATCH', body: { restock: false, cashback: false }, admin: true });
    assert.equal(capa2.restock, false); assert.equal(capa2.cashback, false); assert.equal(capa2.restock_pending, 0);

    // Excluir o saldo: sem senha do admin é recusado; com senha precisa de motivo; zera e registra.
    assert.equal((await request(`/store/sales/customers/${lucas}/cashback/clear`, { method: 'POST', body: { reason: 'troca de espécie' } })).status, 401);
    assert.equal((await request(`/store/sales/customers/${lucas}/cashback/clear`, { method: 'POST', body: { reason: '' }, admin: true })).status, 400);
    const cl = await api(`/store/sales/customers/${lucas}/cashback/clear`, { method: 'POST', body: { reason: 'Troca de espécie por Pix' }, admin: true });
    assert.equal(cl.cleared_cents, 150); assert.equal(cl.cashback.balance_cents, 0);
    assert.equal((await request(`/store/sales/customers/${lucas}/cashback/clear`, { method: 'POST', body: { reason: 'de novo' }, admin: true })).status, 409);
    const det = await api(`/store/sales/customers/${lucas}`);
    assert.equal(det.cashback.balance_cents, 0); assert.equal(det.cashback_clears[0].amount_cents, 150); assert.equal(det.cashback_clears[0].reason, 'Troca de espécie por Pix');
    const hist = await api(`/store/customers/${lucas}/history`);
    assert.equal(hist.cashback_clears.length, 1);
    // Não aparece mais nos avisos de cashback.
    const all = await api('/store/messages/cashback?all=1');
    assert.ok(!JSON.stringify(all).includes(lucas));

    // Saldo excluído não volta: ganha de novo numa venda nova, usa parte, e o cancelamento devolve só o que foi usado.
    await api('/store/products/' + capa.id, { method: 'PATCH', body: { cashback: true }, admin: true });
    const s3 = await api('/store/sales', { method: 'POST', body: { customer_id: lucas, payment_method: 'pix', items: [{ product_id: capa.id, quantity: 2 }] } }, 201);
    assert.equal(s3.cashback.balance_cents, 300);
    await api(`/store/sales/customers/${lucas}/cashback/clear`, { method: 'POST', body: { reason: 'teste' }, admin: true });
    // Cancelar a venda que gerou o saldo excluído não deixa saldo negativo nem faz o saldo voltar.
    await api(`/store/sales/${s3.sale.id}/cancel`, { method: 'POST', body: { reason: 'teste de cancelamento' } });
    assert.equal((await api(`/store/sales/customers/${lucas}`)).cashback.balance_cents, 0);
  } finally { await f.cleanup(); }
});
