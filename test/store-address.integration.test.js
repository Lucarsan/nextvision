import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

test('endereço da loja: salvo no perfil e mostrado no link do cliente', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 60000
}, async () => {
  const f = await createStoreFixture(); const { api, request, base } = f;
  try {
    const r = await api('/store/location', { method: 'PATCH', body: { address: 'Rua Santa Efigênia, 224 - Messejana', city: 'Fortaleza', state: 'CE', whatsapp: '(85) 99123-3550' } });
    assert.equal(r.address, 'Rua Santa Efigênia, 224 - Messejana'); assert.equal(r.whatsapp, '5585991233550');
    assert.equal((await api('/store/settings')).address, 'Rua Santa Efigênia, 224 - Messejana');
    // Sem "address" no corpo, o endereço continua; vazio apaga.
    await api('/store/location', { method: 'PATCH', body: { city: 'Fortaleza', state: 'CE' } });
    assert.equal((await api('/store/settings')).address, 'Rua Santa Efigênia, 224 - Messejana');
    assert.equal((await request('/store/location', { method: 'PATCH', body: { address: 'x'.repeat(161), city: '', state: '' } })).status, 400);
    const op = await f.addOperator(f.tenant);
    assert.equal((await request('/store/location', { method: 'PATCH', token: op.token, body: { address: 'Outro', city: '', state: '' } })).status, 403);
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Banho'] } }, 201);
    const o = await api('/orders/quick', { method: 'POST', body: { reference: 'A1', process_id: proc.id } }, 201);
    const pub = await (await fetch(base + '/api/public/orders/' + o.tracking_url.split('/p/')[1])).json();
    assert.equal(pub.store_address, 'Rua Santa Efigênia, 224 - Messejana'); assert.equal(pub.store_whatsapp, '5585991233550');
    await api('/store/location', { method: 'PATCH', body: { address: '', city: 'Fortaleza', state: 'CE' } });
    assert.equal((await api('/store/settings')).address, null);
  } finally { await f.cleanup(); }
});
