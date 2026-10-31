import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';
import { reportData, reportHtml } from '../src/reports.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('serviços no caixa, peças no estoque, fornecedores e modelos sugeridos', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });

    // Peça no estoque: tela do Galaxy A12, do fornecedor João Peças, custo 80, 3 unidades.
    const tela = await api('/store/products', { method: 'POST', body: { kind: 'part', name: 'Tela', device_model: 'Galaxy A12', supplier: 'João Peças', cost_cents: 8000, stock_qty: 3 } }, 201);
    assert.equal(tela.kind, 'part'); assert.equal(tela.supplier_name, 'João Peças'); assert.equal(tela.device_model, 'Galaxy A12'); assert.equal(tela.price_cents, 0);
    assert.equal((await request('/store/products', { method: 'POST', body: { name: 'Sem preço', cost_cents: 100 } })).status, 400, 'produto (não peça) exige preço');
    // Peça não aparece na busca de produtos do caixa; aparece na de peças (pelo nome ou pelo modelo).
    assert.equal((await api('/store/products?q=tela')).length, 0);
    assert.equal((await api('/store/products?kind=part&q=a12'))[0].id, tela.id);
    assert.equal((await api('/store/products?kind=part&q=tela galaxy'))[0].id, tela.id);
    // Fornecedor e modelo já ficam nas sugestões (sem diferenciar maiúsculas).
    assert.deepEqual((await api('/store/suppliers?q=joao')).map(x => x.name), ['João Peças']);
    assert.deepEqual((await api('/store/device-models?q=gal')).map(x => x.name), ['Galaxy A12']);
    await api('/store/suppliers', { method: 'POST', body: { name: 'joão peças', phone: '85 9999-0000' } }, 201);
    assert.equal((await api('/store/suppliers')).length, 1, 'mesmo nome não duplica');

    // Entrada de estoque da peça com custo: vai para compras.
    await api(`/store/products/${tela.id}/stock`, { method: 'POST', body: { add: 2, unit_cost_cents: 7500 } });

    // Serviços pré-cadastrados: lista inicial uma vez; excluído não volta; mesmo nome atualiza o preço.
    let cat = await api('/store/sales/service-items');
    assert.equal(cat[0].name, 'Troca de tela'); assert.ok(cat.some(i => i.name === 'Troca de bateria')); assert.ok(cat.some(i => i.name === 'Reparo comum'));
    assert.ok(cat.every(i => i.price_cents == null), 'lista inicial sem preço');
    await api('/store/sales/service-items/' + cat.find(i => i.name === 'Diagnóstico').id, { method: 'DELETE' });
    await api('/store/sales/service-items', { method: 'POST', body: { name: 'troca de tela', price_cents: 25000, cost_cents: 9000 } }, 201);
    const bat = cat.find(i => i.name === 'Troca de bateria');
    await api('/store/sales/service-items/' + bat.id, { method: 'PATCH', body: { price_cents: 12000 } });
    await api('/store/sales/service-items', { method: 'POST', body: { name: 'Troca de alto-falante', price_cents: 8000 } }, 201);
    cat = await api('/store/sales/service-items');
    assert.equal(cat.length, 9, '9 iniciais − 1 excluído + 1 novo');
    assert.ok(!cat.some(i => i.name === 'Diagnóstico'), 'excluído não volta');
    assert.equal(cat.find(i => i.name === 'Troca de tela').price_cents, 25000);
    assert.equal(cat.find(i => i.name === 'Troca de tela').cost_cents, 9000);
    assert.equal(cat.find(i => i.name === 'Troca de bateria').price_cents, 12000);
    assert.equal(cat.at(-1).name, 'Troca de alto-falante');
    assert.equal((await request('/store/sales/service-items/' + bat.id, { method: 'PATCH', body: { name: 'Troca de Tela' } })).status, 409);

    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    // Serviço com peça do estoque: custo, fornecedor e modelo vêm da peça; estoque baixa 1.
    const s1 = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Ana', phone: '85 98888-0001' }, payment_method: 'pix', description: 'buscar amanhã',
      items: [{ service: 'Troca de tela', unit_price_cents: 25000, part_id: tela.id, warranty_days: 90 }] } }, 201);
    assert.equal(s1.sale.total_cents, 25000);
    assert.equal(s1.sale.description, 'Troca de tela · Galaxy A12 · buscar amanhã');
    assert.deepEqual(s1.sale.items.map(i => [i.name, i.service, i.supplier_name, i.device_model, i.unit_cost_cents, i.warranty_days]), [['Troca de tela', true, 'João Peças', 'Galaxy A12', 8000, 90]]);
    let part = (await api('/store/products?kind=part'))[0];
    assert.equal(part.stock_qty, 4); assert.equal(part.restock_pending, 1);
    assert.equal((await api('/store/stock/restock')).find(r => r.product_id === tela.id).supplier_name, 'João Peças');

    // Serviço sem peça: fornecedor e modelo digitados entram nas sugestões e sobem com o uso.
    const s2 = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'cash',
      items: [{ service: 'Troca de bateria', unit_price_cents: 12000, cost_cents: 5000, supplier: 'Cell Distribuidora', device_model: 'iPhone 11' }] } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'cash',
      items: [{ service: 'troca de bateria', unit_price_cents: 13000, cost_cents: 5000, supplier: 'cell distribuidora', device_model: 'iphone 11' }] } }, 201);
    assert.equal(s2.sale.description, 'Troca de bateria · iPhone 11');
    assert.equal((await api('/store/suppliers'))[0].name, 'Cell Distribuidora', 'mais usado primeiro, com o nome como foi salvo');
    assert.equal((await api('/store/device-models'))[0].name, 'iPhone 11');
    const services = await api('/store/sales/services');
    assert.equal(services[0].uses, 2); assert.equal(services[0].last_price_cents, 13000);

    // Caixa e comprovante: o comprovante não mostra custo nem fornecedor.
    const cash = await api('/store/cash');
    const row = cash.sales.find(x => x.id === s1.sale.id);
    assert.equal(row.items[0].service, true); assert.equal(row.items[0].supplier_name, 'João Peças');
    const receipt = await api(`/store/sales/${s1.sale.id}/receipt`);
    assert.equal(receipt.items[0].name, 'Troca de tela · Galaxy A12'); assert.equal(receipt.items[0].warranty_days, 90);
    assert.ok(!JSON.stringify(receipt).includes('João'), 'comprovante sem fornecedor');
    assert.ok(!('unit_cost_cents' in receipt.items[0]), 'comprovante sem custo');

    // Cancelar o serviço devolve a peça ao estoque.
    await api(`/store/sales/${s1.sale.id}/cancel`, { method: 'POST', body: { reason: 'cliente desistiu' } });
    part = (await api('/store/products?kind=part'))[0];
    assert.equal(part.stock_qty, 5); assert.equal(part.restock_pending, 0);

    // Peça inválida (produto comum no lugar da peça) é recusada.
    const comum = await api('/store/products', { method: 'POST', body: { name: 'Cabo', price_cents: 2000 } }, 201);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ service: 'Troca', unit_price_cents: 100, part_id: comum.id }] } })).status, 400);

    // Editar a peça: troca fornecedor e modelo.
    const ed = await api('/store/products/' + tela.id, { method: 'PATCH', body: { supplier: 'Nova Peças', device_model: 'Galaxy A13' } });
    assert.equal(ed.supplier_name, 'Nova Peças'); assert.equal(ed.device_model, 'Galaxy A13');

    // Relatório por e-mail: serviços com fornecedor e lucro; compras de peça com fornecedor.
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Fortaleza' });
    const data = await reportData((sql, params) => f.db.query(sql, params), tenant, 'daily', day);
    const rep = { data, html: reportHtml(data) };
    assert.equal(rep.data.services.length, 1, 'só o serviço não cancelado (bateria, agrupado)');
    assert.deepEqual([rep.data.services[0].name, rep.data.services[0].qty, rep.data.services[0].total, rep.data.services[0].cost], ['Troca de bateria', 2, 25000, 10000]);
    assert.ok(rep.data.purchases.some(b => b.supplier === 'Nova Peças' || b.supplier === 'João Peças'));
    assert.ok(rep.html.includes('Serviços realizados'));
  } finally { await f.cleanup(); }
});
