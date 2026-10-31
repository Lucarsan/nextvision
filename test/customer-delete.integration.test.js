import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('lojista exclui cliente sem quebrar o histórico', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, foreignToken } = f;
    const ana = await api('/customers', { method: 'POST', body: { name: 'Ana Lima', phone: '85 98888-0001' } }, 201);
    const bia = await api('/customers', { method: 'POST', body: { name: 'Bia Rocha', phone: '85 98888-0002' } }, 201);
    const proc = await api('/processes', { method: 'POST', body: { name: 'Reparo', steps: ['Recepção', 'Finalização'] } }, 201);
    const order = await api('/orders', { method: 'POST', body: { customer_id: ana.id, process_id: proc.id, reference: 'A1' } }, 201);

    // Pedido na fila bloqueia a exclusão.
    const blocked = await request('/customers/' + ana.id, { method: 'DELETE' });
    assert.equal(blocked.status, 409); assert.match(blocked.data.error, /pedido/);

    // Outra loja não exclui.
    assert.equal((await request('/customers/' + bia.id, { method: 'DELETE', token: foreignToken })).status, 404);

    // Excluído o pedido, o cliente pode sair.
    assert.equal((await request('/orders/' + order.id, { method: 'DELETE' })).status < 300, true);
    assert.deepEqual(await api('/customers/' + ana.id, { method: 'DELETE' }), { deleted: true });
    const list = await api('/customers');
    assert.ok(!list.some(c => c.id === ana.id), 'some da lista'); assert.ok(list.some(c => c.id === bia.id));
    assert.equal((await request('/customers/' + ana.id, { method: 'DELETE' })).status, 404, 'excluir de novo');
    assert.equal((await request('/customers/' + ana.id, { method: 'PATCH', body: { name: 'Ana', email: '', phone: '', address: '' } })).status, 404, 'não edita excluído');
    assert.equal((await request('/orders', { method: 'POST', body: { customer_id: ana.id, process_id: proc.id, reference: 'A2' } })).status, 400, 'não cria pedido para excluído');

    // O registro continua no banco (FK de pedidos, vendas e fidelidade).
    const row = (await f.db.query('SELECT deleted_at FROM customers WHERE id=$1', [ana.id])).rows[0];
    assert.ok(row.deleted_at);

    // Mesmo telefone pode ser cadastrado de novo.
    await api('/customers', { method: 'POST', body: { name: 'Ana Lima', phone: '85 98888-0001' } }, 201);
  } finally { await f.cleanup(); }
});
