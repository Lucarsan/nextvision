import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';
import { ONBOARDING_ITEMS } from '../src/unit-onboarding.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('implantação: checklist por unidade, aguardando a rede, pronta para cobrar e aceite', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, db, tenant, foreignTenant, masterToken } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'aud-onb', hostname: 'aud-onb.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Grand Shopping' } });
    await api(`/master/tenants/${foreignTenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Sobral' } });
    const people = `/master/networks/${net.id}/people`;
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'g@aud-onb.test', function: 'dono', password: 'senha-do-gabriel-123' } }, 201);
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Dani', email: 'd@aud-onb.test', function: 'supervisor', unit_ids: [tenant], password: 'senha-da-dani-1234' } }, 201);
    const login = async (email, password) => (await request('/auth/login', { method: 'POST', token: null, body: { email, password } })).data.token;
    const dono = await login('g@aud-onb.test', 'senha-do-gabriel-123'), sup = await login('d@aud-onb.test', 'senha-da-dani-1234');

    // Começo: nada pronto; supervisor só vê a unidade dela.
    let d = await api('/network/onboarding', { token: dono });
    assert.equal(d.units.length, 2);
    let gs = d.units.find(u => u.id === tenant);
    assert.equal(gs.items.length, ONBOARDING_ITEMS.length);
    assert.equal(gs.ready_to_bill, false); assert.equal(gs.complete, false);
    assert.equal(gs.items.find(i => i.key === 'people').state, 'pending');
    assert.deepEqual((await api('/network/onboarding', { token: sup })).units.map(u => u.id), [tenant]);

    // Itens automáticos saem dos dados reais.
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Ana', function: 'vendedora', unit_id: tenant, pin: '1111' } }, 201);
    await db.query("INSERT INTO products(tenant_id,name,barcode,price_cents,ncm,stock_qty) VALUES($1,'Brinco ponto de luz','003622',8990,'71171900',3)", [tenant]);
    await db.query("INSERT INTO customers(tenant_id,name,phone) VALUES($1,'Maria Souza','85988887777')", [tenant]);
    gs = (await api('/network/onboarding', { token: dono })).units.find(u => u.id === tenant);
    const st = k => gs.items.find(i => i.key === k);
    assert.equal(st('people').state, 'done'); assert.equal(st('people').source, 'auto');
    assert.equal(st('products').state, 'done'); assert.equal(st('customers').state, 'done');

    // A rede só marca itens dela; item nosso é recusado. Supervisor fora da unidade não marca.
    assert.equal((await request(`/network/onboarding/${tenant}/items/reader`, { method: 'PUT', token: dono, body: { state: 'done' } })).status, 403);
    assert.equal((await request(`/network/onboarding/${foreignTenant}/items/printer`, { method: 'PUT', token: sup, body: { state: 'done' } })).status, 404);
    await api(`/network/onboarding/${tenant}/items/printer`, { method: 'PUT', token: sup, body: { state: 'done', note: 'TM-T20 ok' } });
    gs = (await api('/network/onboarding', { token: dono })).units.find(u => u.id === tenant);
    assert.equal(st('printer').state, 'done'); assert.equal(st('printer').marked_by, 'Dani'); assert.equal(st('printer').note, 'TM-T20 ok');
    // Item da rede não entra na "nossa parte".
    assert.equal(gs.ours_total, ONBOARDING_ITEMS.filter(i => i.who !== 'rede').length);

    // Central: o que falta de nós fica "aguardando a rede" -> pronta para cobrar, mas não completa.
    for (const it of ONBOARDING_ITEMS.filter(i => i.who !== 'rede')) {
      const cur = gs.items.find(i => i.key === it.key);
      if (cur.state !== 'done') await api(`/master/onboarding/${tenant}/items/${it.key}`, { method: 'PUT', token: masterToken, body: { state: 'waiting', note: 'pinpad da Stone' } });
    }
    assert.equal((await request(`/master/onboarding/${tenant}/items/printer`, { method: 'PUT', token: masterToken, body: { state: 'waiting', note: 'x' } })).status, 403);
    let m = await api(`/master/networks/${net.id}/onboarding`, { token: masterToken });
    gs = m.units.find(u => u.id === tenant);
    assert.equal(gs.ours_percent, 100); assert.equal(gs.ready_to_bill, true); assert.equal(gs.complete, false);
    assert.ok(gs.missing_network.length > 0); assert.equal(gs.missing_ours.length, 0);
    assert.equal((await request(`/network/onboarding/${tenant}/accept`, { method: 'POST', token: dono, body: { confirm: true } })).status, 409);

    // Tudo feito -> aceite do dono, registrado com nome; não repete; central desfaz.
    for (const it of ONBOARDING_ITEMS) {
      const cur = gs.items.find(i => i.key === it.key);
      if (cur.state !== 'done') await api(`/master/onboarding/${tenant}/items/${it.key}`, { method: 'PUT', token: masterToken, body: { state: 'done' } });
    }
    await api(`/network/onboarding/${tenant}/accept`, { method: 'POST', token: dono, body: { confirm: true } });
    gs = (await api('/network/onboarding', { token: dono })).units.find(u => u.id === tenant);
    assert.equal(gs.complete, true); assert.ok(gs.accepted_at); assert.equal(gs.accepted_by, 'Gabriel');
    assert.equal((await request(`/network/onboarding/${tenant}/accept`, { method: 'POST', token: dono, body: { confirm: true } })).status, 409);
    await api(`/master/onboarding/${tenant}/accept`, { method: 'DELETE', token: masterToken });
    assert.equal((await api('/network/onboarding', { token: dono })).units.find(u => u.id === tenant).accepted_at, null);

    // Desfazer uma marcação volta para "falta".
    await api(`/master/onboarding/${tenant}/items/reader`, { method: 'PUT', token: masterToken, body: { state: null } });
    gs = (await api('/network/onboarding', { token: dono })).units.find(u => u.id === tenant);
    assert.equal(gs.items.find(i => i.key === 'reader').state, 'pending'); assert.equal(gs.ready_to_bill, false);
    // Lojista comum não acessa.
    assert.equal((await request('/network/onboarding', { token: f.ownerToken })).status, 403);
  } finally { await f.cleanup(); }
});
