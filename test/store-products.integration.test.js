import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('produtos com código de barras e venda pelo leitor', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignToken, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api('/store/loyalty', { method: 'PATCH', body: { loyalty_enabled: true, loyalty_target: 5, loyalty_reward: 'Película grátis' } });
    await api('/store/sales/config', { method: 'PATCH', body: { loyalty_min_sale_cents: 2000 } });

    // Cadastro: código único por loja; outra loja pode usar o mesmo código.
    const pel = await api('/store/products', { method: 'POST', body: { name: 'Película 3D', barcode: '7891234567895', price_cents: 1500 } }, 201);
    const cab = await api('/store/products', { method: 'POST', body: { name: 'Cabo USB-C', barcode: 'CAB-01', price_cents: 2500 } }, 201);
    const semCodigo = await api('/store/products', { method: 'POST', body: { name: 'Capinha avulsa', price_cents: 3000 } }, 201);
    assert.equal(semCodigo.barcode, null);
    assert.equal((await request('/store/products', { method: 'POST', body: { name: 'Outra', barcode: '7891234567895', price_cents: 100 } })).status, 409);
    assert.equal((await request('/store/products', { method: 'POST', body: { name: 'Espaço', barcode: '789 123', price_cents: 100 } })).status, 400);
    await api('/store/products', { method: 'POST', token: foreignToken, body: { name: 'Da outra loja', barcode: '7891234567895', price_cents: 999 } }, 403); // outra loja sem caixa ligado

    // Leitura do código: acha o produto; desconhecido devolve 404; outra loja não vê.
    assert.equal((await api('/store/products/barcode/7891234567895')).id, pel.id);
    assert.equal((await request('/store/products/barcode/0000000000000')).status, 404);
    assert.equal((await request('/store/products/barcode/7891234567895', { token: foreignToken })).status, 403);
    assert.equal((await api('/store/products?q=pelicula'))[0].id, pel.id, 'busca sem acento');
    assert.equal((await api('/store/products?q=CAB-01'))[0].id, cab.id, 'busca pelo código');

    // Venda com itens: total e descrição calculados no servidor; o mesmo produto bipado 2x soma.
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const maria = (await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Maria', phone: '85 98888-1234' }, total_cents: 100, payment_method: 'pix' } }, 201)).customer;
    const sale = await api('/store/sales', { method: 'POST', body: { customer_id: maria.id, payment_method: 'cash', items: [
      { product_id: pel.id, quantity: 1 }, { product_id: cab.id, quantity: 1 }, { product_id: pel.id, quantity: 1 }
    ] } }, 201);
    assert.equal(sale.sale.total_cents, 1500 * 2 + 2500);
    assert.equal(sale.sale.description, '2x Película 3D, Cabo USB-C');
    assert.deepEqual(sale.sale.items.map(i => [i.name, i.quantity, i.total_cents]), [['Película 3D', 2, 3000], ['Cabo USB-C', 1, 2500]]);
    assert.equal(sale.loyalty_counted, true, 'total calculado vale para o mínimo da fidelidade');

    // Itens aparecem no caixa (tela e relatório) com o preço do momento da venda.
    await api('/store/products/' + pel.id, { method: 'PATCH', body: { price_cents: 1800 } });
    const cash = await api('/store/cash');
    const row = cash.sales.find(x => x.id === sale.sale.id);
    assert.deepEqual(row.items.map(i => [i.name, i.quantity, i.unit_price_cents]), [['Película 3D', 2, 1500], ['Cabo USB-C', 1, 2500]]);
    assert.equal(cash.summary.by_method.cash.total_cents, 5500);
    const again = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'debit', items: [{ product_id: pel.id, quantity: 3 }] } }, 201);
    assert.equal(again.sale.total_cents, 5400, 'novo preço vale para vendas novas');

    // Regras: não mistura total digitado com itens; produto excluído não vende; produto de outra loja não entra.
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', total_cents: 100, items: [{ product_id: cab.id, quantity: 1 }] } })).status, 400);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix' } })).status, 400);
    await api('/store/products/' + cab.id, { method: 'DELETE' });
    assert.equal((await request('/store/products/barcode/CAB-01')).status, 404);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ product_id: cab.id, quantity: 1 }] } })).status, 400);
    const reused = await api('/store/products', { method: 'POST', body: { name: 'Cabo novo', barcode: 'CAB-01', price_cents: 2000 } }, 201);
    assert.equal((await api('/store/products/barcode/CAB-01')).id, reused.id, 'código liberado pelo produto excluído');
    assert.equal((await request('/store/products/' + reused.id, { method: 'PATCH', body: { barcode: '7891234567895' } })).status, 409);

    // Comprovante: loja, itens com preço do momento, cliente e cartão fidelidade; outra loja não acessa.
    const rec = await api(`/store/sales/${sale.sale.id}/receipt`);
    assert.equal(rec.sale_number, sale.sale.sale_number); assert.equal(rec.store_name, 'Loja de teste'); assert.equal(rec.customer_name, 'Maria');
    assert.deepEqual(rec.items.map(i => [i.name, i.quantity, i.unit_price_cents, i.total_cents]), [['Película 3D', 2, 1500, 3000], ['Cabo USB-C', 1, 2500, 2500]]);
    assert.equal(rec.loyalty.target, 5);
    assert.equal((await request(`/store/sales/${sale.sale.id}/receipt`, { token: foreignToken })).status, 403);

    // Cancelar a venda mantém os itens no histórico, fora do total.
    await api(`/store/sales/${sale.sale.id}/cancel`, { method: 'POST', body: { reason: 'Teste de cancelamento' } });
    const after = await api('/store/cash');
    assert.equal(after.sales.find(x => x.id === sale.sale.id).items.length, 2);
    assert.equal(after.summary.by_method.cash, undefined);
  } finally { await f.cleanup(); }
});
