import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('vendas a receber: guardar, abrir pedido ao vivo, receber depois uma vez só e cancelar', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, db } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Recebido', 'Banho', 'Pronto'] } }, 201);
    const cli = await api('/customers', { method: 'POST', body: { name: 'Afonso Filho', phone: '85997106788' } }, 201);
    const banho = await api('/store/sales/service-items', { method: 'POST', body: { name: 'Banho de cheiro', price_cents: 4300 } }, 201);
    const taina = await f.addOperator(tenant, 'full', 'Tainá');

    // Guardar sem pagamento, já abrindo o pedido ao vivo do pet.
    const items = [{ service: 'Banho de cheiro', unit_price_cents: 6000, device_model: 'Dom', catalog_id: banho.id }, { service: 'Hidratação', unit_price_cents: 2000, device_model: 'Dom' }];
    const p1 = await api('/store/sales/pending', { method: 'POST', token: taina.token, body: { customer_id: cli.id, items,
      live_order: { process_id: proc.id, details: { item_type: 'pet', pet_name: 'Dom', breed: 'Yorkshire Terrier', size: 'Médio', service: 'Banho de cheiro + Hidratação' } } } }, 201);
    assert.equal(p1.number, 1); assert.equal(p1.total_cents, 8000); assert.equal(p1.customer_name, 'Afonso Filho'); assert.equal(p1.seller_id, taina.id);
    assert.ok(p1.live_order?.order_number); assert.match(p1.live_order.tracking_url, /\/p\//);
    assert.equal(p1.order_id, p1.live_order.id); assert.equal(p1.pet_name, 'Dom'); assert.equal(p1.order_status, 'queued');
    const order = (await db.query('SELECT customer_id,details FROM orders WHERE id=$1', [p1.order_id])).rows[0];
    assert.equal(order.customer_id, cli.id); assert.equal(order.details.pet_name, 'Dom');
    assert.equal((await db.query("SELECT count(*)::int n FROM customer_pets WHERE customer_id=$1 AND name='Dom'", [cli.id])).rows[0].n, 1, 'ficha do pet criada');

    // Cliente novo também pode ficar a receber; sem cliente, não.
    const p2 = await api('/store/sales/pending', { method: 'POST', body: { new_customer: { name: 'Maria Souza', phone: '85 98888-1234' }, total_cents: 3500, description: 'Tosa' } }, 201);
    assert.equal(p2.number, 2); assert.equal(p2.customer_name, 'Maria Souza');
    assert.equal((await request('/store/sales/pending', { method: 'POST', body: { anonymous: true, total_cents: 100 } })).status, 400);
    assert.equal((await request('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, total_cents: 100, payment_method: 'pix' } })).status, 400, 'sem forma de pagamento');
    assert.equal((await request('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, total_cents: 100, order_id: p1.order_id, live_order: { process_id: proc.id } } })).status, 400);

    let list = await api('/store/sales/pending');
    assert.deepEqual(list.map(x => x.number), [1, 2]); assert.ok(list[0].cashback);

    // Receber exige caixa aberto; vira venda normal ligada ao pedido, com o vendedor de quando foi guardada.
    assert.equal((await request(`/store/sales/pending/${p1.id}/pay`, { method: 'POST', body: { payment_method: 'pix' } })).status, 409);
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    assert.equal((await request(`/store/sales/pending/${p1.id}/pay`, { method: 'POST', body: {} })).status, 400, 'precisa da forma');
    const paid = await api(`/store/sales/pending/${p1.id}/pay`, { method: 'POST', body: { payments: [{ method: 'cash', amount_cents: 5000 }, { method: 'pix', amount_cents: 3000 }] } }, 201);
    assert.equal(paid.sale.total_cents, 8000); assert.equal(paid.sale.order_id, p1.order_id); assert.equal(paid.sale.seller_id, taina.id); assert.equal(paid.sale.pending_id, p1.id);
    assert.equal((await db.query('SELECT addon FROM sale_items WHERE sale_id=$1 AND catalog_id=$2', [paid.sale.id, banho.id])).rowCount, 1);
    assert.equal((await request(`/store/sales/pending/${p1.id}/pay`, { method: 'POST', body: { payment_method: 'pix' } })).status, 409, 'não recebe duas vezes');
    list = await api('/store/sales/pending'); assert.deepEqual(list.map(x => x.number), [2]);

    // Cancelar: operador novato não pode; cancelada não recebe.
    const basic = await f.addOperator(tenant, 'basic', 'Novato');
    assert.equal((await request(`/store/sales/pending/${p2.id}/cancel`, { method: 'POST', token: basic.token, body: { reason: 'Desistiu' } })).status, 403);
    await api(`/store/sales/pending/${p2.id}/cancel`, { method: 'POST', body: { reason: 'Desistiu' } });
    assert.equal((await request(`/store/sales/pending/${p2.id}/pay`, { method: 'POST', body: { payment_method: 'pix' } })).status, 409);
    assert.deepEqual(await api('/store/sales/pending'), []);

    // Venda paga na hora também abre o pedido ao vivo.
    const direct = await api('/store/sales', { method: 'POST', body: { customer_id: cli.id, payment_method: 'pix', items: [{ service: 'Banho de cheiro', unit_price_cents: 4300, catalog_id: banho.id }],
      live_order: { process_id: proc.id, details: { item_type: 'pet', pet_name: 'Thor' } } } }, 201);
    assert.ok(direct.live_order?.id); assert.equal(direct.sale.order_id, direct.live_order.id);
    const foreignProc = (await db.query("INSERT INTO processes(tenant_id,name,steps) VALUES($1,'X','[\"a\"]') RETURNING id", [f.foreignTenant])).rows[0].id;
    assert.equal((await request('/store/sales', { method: 'POST', body: { customer_id: cli.id, payment_method: 'pix', total_cents: 100, live_order: { process_id: foreignProc } } })).status, 400);
    assert.equal((await db.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [tenant])).rows[0].n, 2, 'venda recusada não deixa pedido');
  } finally { await f.cleanup(); }
});

test('tirar um item da venda a receber (cliente desistiu da tosa)', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, db } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Recebido', 'Pronto'] } }, 201);
    const cli = await api('/customers', { method: 'POST', body: { name: 'Ana Lima', phone: '85988887777' } }, 201);
    const p = await api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, discount_cents: 500,
      items: [{ service: 'Banho de cheiro', unit_price_cents: 5000, device_model: 'Mel' }, { service: 'Tosa higiênica', unit_price_cents: 3000, device_model: 'Mel' }],
      live_order: { process_id: proc.id, details: { pet_name: 'Mel', service: 'Banho de cheiro + Tosa higiênica' } } } }, 201);
    assert.equal(p.total_cents, 7500);
    const basic = await f.addOperator(tenant, 'basic', 'Novato');
    assert.equal((await request(`/store/sales/pending/${p.id}/remove-item`, { method: 'POST', token: basic.token, body: { index: 1 } })).status, 403);
    assert.equal((await request(`/store/sales/pending/${p.id}/remove-item`, { method: 'POST', body: { index: 5 } })).status, 400);
    const r = await api(`/store/sales/pending/${p.id}/remove-item`, { method: 'POST', body: { index: 1 } });
    assert.equal(r.removed, 'Tosa higiênica'); assert.equal(r.total_cents, 4500);
    assert.deepEqual(r.payload.items.map(i => i.service), ['Banho de cheiro']);
    assert.equal((await db.query('SELECT details FROM orders WHERE id=$1', [p.order_id])).rows[0].details.service, 'Banho de cheiro', 'pedido mostra só o que ficou');
    assert.equal((await request(`/store/sales/pending/${p.id}/remove-item`, { method: 'POST', body: { index: 0 } })).status, 400, 'último item: cancelar a venda');
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const paid = await api(`/store/sales/pending/${p.id}/pay`, { method: 'POST', body: { payment_method: 'pix' } }, 201);
    assert.equal(paid.sale.total_cents, 4500); assert.deepEqual(paid.sale.items.map(i => i.name), ['Banho de cheiro']);
    assert.equal((await request(`/store/sales/pending/${p.id}/remove-item`, { method: 'POST', body: { index: 0 } })).status, 409);
  } finally { await f.cleanup(); }
});

test('incluir itens na venda a receber; recebida não aceita mais (cancela e lança outra)', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, db } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Recebido', 'Pronto'] } }, 201);
    const cli = await api('/customers', { method: 'POST', body: { name: 'Ana Lima', phone: '85988887777' } }, 201);
    const hidra = await api('/store/sales/service-items', { method: 'POST', body: { name: 'Hidratação', price_cents: 1800, addon: true } }, 201);
    const prod = await api('/store/products', { method: 'POST', body: { name: 'Laço', price_cents: 500, stock_qty: 10 } }, 201);
    const p = await api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, discount_cents: 500,
      items: [{ service: 'Banho de cheiro', unit_price_cents: 5000, device_model: 'Mel' }],
      live_order: { process_id: proc.id, details: { pet_name: 'Mel', service: 'Banho de cheiro' } } } }, 201);
    assert.equal(p.total_cents, 4500);

    // Novato pode incluir (não é tirar nem cancelar).
    const basic = await f.addOperator(tenant, 'basic', 'Novato');
    const r = await api(`/store/sales/pending/${p.id}/add-items`, { method: 'POST', token: basic.token, body: { description: 'pediu laço',
      items: [{ service: 'Hidratação', unit_price_cents: 1800, device_model: 'Mel', catalog_id: hidra.id }, { product_id: prod.id, quantity: 2 }] } });
    assert.equal(r.added, 2); assert.equal(r.total_cents, 5000 + 1800 + 1000 - 500, 'desconto da venda continua');
    assert.equal(r.payload.items.length, 3); assert.match(r.description, /pediu laço/);
    assert.equal((await db.query('SELECT details FROM orders WHERE id=$1', [p.order_id])).rows[0].details.service, 'Banho de cheiro + Hidratação', 'pedido ao vivo mostra os serviços novos');
    assert.equal((await request(`/store/sales/pending/${p.id}/add-items`, { method: 'POST', body: { items: [] } })).status, 400);
    assert.equal((await request(`/store/sales/pending/${p.id}/add-items`, { method: 'POST', body: { items: [{ product_id: '00000000-0000-4000-8000-000000000000', quantity: 1 }] } })).status, 400);

    // Venda guardada só com valor: o valor vira item e soma com o novo.
    const v = await api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, total_cents: 3500, description: 'Tosa' } }, 201);
    const v2 = await api(`/store/sales/pending/${v.id}/add-items`, { method: 'POST', body: { items: [{ name: 'Perfume', quantity: 1, unit_price_cents: 700 }] } });
    assert.equal(v2.total_cents, 4200); assert.deepEqual(v2.payload.items.map(i => i.name), ['Tosa', 'Perfume']); assert.equal(v2.payload.total_cents, undefined);

    // Ao receber, cobra tudo; estoque baixa nessa hora.
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const paid = await api(`/store/sales/pending/${p.id}/pay`, { method: 'POST', body: { payment_method: 'pix' } }, 201);
    assert.equal(paid.sale.total_cents, 7300); assert.equal(paid.sale.items.length, 3);
    assert.equal((await db.query('SELECT stock_qty FROM products WHERE id=$1', [prod.id])).rows[0].stock_qty, 8);
    const after = await request(`/store/sales/pending/${p.id}/add-items`, { method: 'POST', body: { items: [{ name: 'X', quantity: 1, unit_price_cents: 100 }] } });
    assert.equal(after.status, 409); assert.match(after.data.error, /cancele a venda/);
  } finally { await f.cleanup(); }
});
