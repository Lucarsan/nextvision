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
