import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('rede: metas da rede, das unidades e das vendedoras; supervisor limitado', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignTenant, masterToken } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'aud-goal', hostname: 'aud-goal.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Grand Shopping' } });
    await api(`/master/tenants/${foreignTenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Benfica' } });
    const people = `/master/networks/${net.id}/people`;
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'g@aud-goal.test', function: 'dono', password: 'senha-do-gabriel-123' } }, 201);
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Dani', email: 'd@aud-goal.test', function: 'supervisor', unit_ids: [tenant], password: 'senha-da-dani-1234' } }, 201);
    const ana = await api(people, { method: 'POST', token: masterToken, body: { name: 'Ana', function: 'vendedora', unit_id: tenant, pin: '1111' } }, 201);
    const bia = await api(people, { method: 'POST', token: masterToken, body: { name: 'Bia', function: 'vendedora', unit_id: foreignTenant, pin: '2222' } }, 201);
    const login = async (email, password) => (await request('/auth/login', { method: 'POST', token: null, body: { email, password } })).data.token;
    const dono = await login('g@aud-goal.test', 'senha-do-gabriel-123'), sup = await login('d@aud-goal.test', 'senha-da-dani-1234');

    await api('/network/goals', { method: 'PUT', token: dono, body: { month: '2026-11', network_cents: 15000000,
      units: [{ id: tenant, goal_cents: 8000000 }, { id: foreignTenant, goal_cents: 6000000 }], sellers: [{ id: ana.id, goal_cents: 3000000 }] } });
    let g = await api('/network/goals?month=2026-11', { token: dono });
    assert.equal(g.can_edit_network, true);
    assert.equal(g.network.goal_cents, 15000000); assert.equal(g.network.units_goal_sum_cents, 14000000);
    const gs = g.units.find(u => u.id === tenant);
    assert.equal(gs.goal_cents, 8000000); assert.equal(gs.sellers.find(s => s.id === ana.id).goal_cents, 3000000);
    // Sem meta nova, vale a do mês anterior.
    g = await api('/network/goals?month=2026-12', { token: dono });
    assert.equal(g.network.goal_cents, 15000000); assert.equal(g.network.since, '2026-11');
    // Atualiza no mesmo mês sem duplicar.
    await api('/network/goals', { method: 'PUT', token: dono, body: { month: '2026-11', units: [{ id: tenant, goal_cents: 9000000 }] } });
    g = await api('/network/goals?month=2026-11', { token: dono });
    assert.equal(g.units.find(u => u.id === tenant).goal_cents, 9000000);

    // Supervisor: vê e edita só a unidade dela; não mexe na meta da rede.
    g = await api('/network/goals?month=2026-11', { token: sup });
    assert.equal(g.can_edit_network, false); assert.deepEqual(g.units.map(u => u.id), [tenant]);
    assert.equal((await request('/network/goals', { method: 'PUT', token: sup, body: { month: '2026-11', network_cents: 1 } })).status, 403);
    assert.equal((await request('/network/goals', { method: 'PUT', token: sup, body: { month: '2026-11', units: [{ id: foreignTenant, goal_cents: 1 }] } })).status, 403);
    assert.equal((await request('/network/goals', { method: 'PUT', token: sup, body: { month: '2026-11', sellers: [{ id: bia.id, goal_cents: 1 }] } })).status, 403);
    await api('/network/goals', { method: 'PUT', token: sup, body: { month: '2026-11', sellers: [{ id: ana.id, goal_cents: 3500000 }] } });
    assert.equal((await request('/network/goals', { method: 'PUT', token: dono, body: { month: '2026-13' } })).status, 400);
  } finally { await f.cleanup(); }
});
