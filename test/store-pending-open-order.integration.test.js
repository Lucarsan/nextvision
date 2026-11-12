import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('venda a receber sem pedido: "Abrir pedido" cria um pedido por pet e liga o primeiro à venda', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, db } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const proc = await api('/processes', { method: 'POST', body: { name: 'Serviço Completo', steps: ['Espera', 'Banho', 'Pronto'] } }, 201);
    const cli = await api('/customers', { method: 'POST', body: { name: 'Mayara Basilio', phone: '85997100000' } }, 201);
    await db.query("INSERT INTO customer_pets(tenant_id,customer_id,name,breed,size) VALUES($1,$2,'Marvim','Shih tzu','Pequeno')", [tenant, cli.id]);
    const items = [
      { service: 'Banho de cheiro', unit_price_cents: 4300, device_model: 'MARVIM' },
      { service: 'Tosa zero', unit_price_cents: 5700, device_model: 'MARVIM' },
      { service: 'Banho de cheiro', unit_price_cents: 4300, device_model: 'MEG' },
      { service: 'Hidratação', unit_price_cents: 3000, device_model: 'MEG' }];
    const p = await api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, items } }, 201);
    assert.equal(p.order_id, null);

    const r = await api(`/store/sales/pending/${p.id}/open-order`, { method: 'POST', body: { process_id: proc.id } }, 201);
    assert.equal(r.orders.length, 2);
    assert.deepEqual(r.orders.map(o => o.pet_name), ['MARVIM', 'MEG']);
    const rows = (await db.query('SELECT id,status,details FROM orders WHERE id=ANY($1::uuid[]) ORDER BY details->>\'pet_name\'', [r.orders.map(o => o.id)])).rows;
    assert.equal(rows[0].details.service, 'Banho de cheiro + Tosa zero'); assert.equal(rows[0].details.breed, 'Shih tzu');
    assert.equal(rows[1].details.service, 'Banho de cheiro + Hidratação'); assert.ok(rows.every(o => o.status === 'queued'));

    const list = await api('/store/sales/pending');
    assert.equal(list[0].order_id, r.orders[0].id); assert.equal(list[0].order_status, 'queued');
    assert.equal((await request(`/store/sales/pending/${p.id}/open-order`, { method: 'POST', body: { process_id: proc.id } })).status, 409, 'não abre duas vezes');
    assert.ok((await api('/orders')).some(o => o.id === r.orders[1].id), 'pedidos aparecem no painel');

    // Ao receber, a venda fica ligada ao primeiro pedido.
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const paid = await api(`/store/sales/pending/${p.id}/pay`, { method: 'POST', body: { payment_method: 'pix' } }, 201);
    assert.equal(paid.sale.order_id, r.orders[0].id); assert.equal(paid.sale.total_cents, 17300);
    assert.equal((await request(`/store/sales/pending/${p.id}/open-order`, { method: 'POST', body: { process_id: proc.id } })).status, 409, 'já recebida');
  } finally { await f.cleanup(); }
});
