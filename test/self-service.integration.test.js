import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('autoatendimento: trocar senha, senha do quiosque, PIN e pessoas pelo painel do dono', { skip }, async () => {
  const sent = [];
  const mail = http.createServer(async (req, res) => { let b = ''; for await (const c of req) b += c; sent.push(JSON.parse(b)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  mail.listen(0, '127.0.0.1'); await once(mail, 'listening');
  const f = await createStoreFixture({ env: { RESEND_API_KEY: 'test', EMAIL_FROM: 'FicouPronto <x@test>', RESEND_API_URL: 'http://127.0.0.1:' + mail.address().port + '/emails' } });
  try {
    const { api, request, tenant, foreignTenant, masterToken, db } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'aud-ss', hostname: 'aud-ss.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Grand Shopping' } });
    await api(`/master/tenants/${foreignTenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Benfica' } });
    const people = `/master/networks/${net.id}/people`;
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'g@aud-ss.test', function: 'dono', password: 'senha-do-gabriel-123' } }, 201);
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Dani', email: 'd@aud-ss.test', function: 'supervisor', unit_ids: [tenant], password: 'senha-da-dani-1234' } }, 201);
    const ana = await api(people, { method: 'POST', token: masterToken, body: { name: 'Ana', function: 'vendedora', unit_id: tenant, pin: '1357' } }, 201);
    const outra = await api(people, { method: 'POST', token: masterToken, body: { name: 'Outra', function: 'vendedora', unit_id: foreignTenant, pin: '2468' } }, 201);
    const login = async (email, password) => (await request('/auth/login', { method: 'POST', token: null, body: { email, password } }));
    const dono = (await login('g@aud-ss.test', 'senha-do-gabriel-123')).data.token, sup = (await login('d@aud-ss.test', 'senha-da-dani-1234')).data.token;

    // 1. Trocar a própria senha: precisa da atual; a sessão antiga deixa de valer; a nova entra.
    assert.equal((await request('/auth/change-password', { method: 'POST', token: sup, body: { current_password: 'errada', new_password: 'nova-senha-da-dani' } })).status, 400);
    assert.equal((await request('/auth/change-password', { method: 'POST', token: sup, body: { current_password: 'senha-da-dani-1234', new_password: 'curta' } })).status, 400);
    const ch = await api('/auth/change-password', { method: 'POST', token: sup, body: { current_password: 'senha-da-dani-1234', new_password: 'nova-senha-da-dani' } });
    assert.equal(ch.email, 'd@aud-ss.test');
    await new Promise(r => setTimeout(r, 1100));
    assert.equal((await request('/network/me', { token: sup })).status, 401);
    assert.equal((await login('d@aud-ss.test', 'senha-da-dani-1234')).status, 401);
    const sup2 = (await login('d@aud-ss.test', 'nova-senha-da-dani')).data.token; assert.ok(sup2);

    // 2. Senha do quiosque: supervisor só nas unidades dele.
    assert.equal((await request(`/network/units/${foreignTenant}/kiosk-password`, { method: 'PUT', token: sup2, body: {} })).status, 404);
    const kp = await api(`/network/units/${tenant}/kiosk-password`, { method: 'PUT', token: sup2, body: {} });
    assert.match(kp.password, /^Un-/);
    assert.equal((await request('/auth/unit', { method: 'POST', token: null, body: { unit_id: tenant, password: kp.password } })).status, 200);
    assert.equal((await api(`/network/units/${foreignTenant}/kiosk-password`, { method: 'PUT', token: dono, body: { password: 'benfica-2026' } })).password, null);

    // 3. PIN: vendedora troca o próprio; supervisor gera novo só para vendedoras das unidades dele.
    assert.equal((await request('/store/kiosk/change-pin', { method: 'POST', body: { seller_id: ana.id, current_pin: '0000', new_pin: '8642' } })).status, 401);
    assert.equal((await request('/store/kiosk/change-pin', { method: 'POST', body: { seller_id: ana.id, current_pin: '1357', new_pin: '1111' } })).status, 400);
    await api('/store/kiosk/change-pin', { method: 'POST', body: { seller_id: ana.id, current_pin: '1357', new_pin: '8642' } });
    assert.equal((await request('/store/kiosk/check-pin', { method: 'POST', body: { seller_id: ana.id, pin: '8642' } })).status, 200);
    assert.equal((await request(`/network/people/${outra.id}/new-pin`, { method: 'POST', token: sup2, body: {} })).status, 403);
    const np = await api(`/network/people/${ana.id}/new-pin`, { method: 'POST', token: sup2, body: {} });
    assert.match(np.pin, /^\d{4}$/);
    assert.equal((await request('/store/kiosk/check-pin', { method: 'POST', body: { seller_id: ana.id, pin: np.pin } })).status, 200);

    // 4. Pessoas pelo painel: supervisor vê só vendedoras dele e não cadastra; dono cadastra e desativa.
    const supList = await api('/network/people', { token: sup2 });
    assert.deepEqual(supList.map(p => p.name), ['Ana']);
    assert.equal((await request('/network/people', { method: 'POST', token: sup2, body: { name: 'X', function: 'vendedora', unit_id: tenant } })).status, 403);
    assert.equal((await request('/network/people', { method: 'POST', token: dono, body: { name: 'X', function: 'dono', email: 'x@x.test' } })).status, 400);
    const bia = await api('/network/people', { method: 'POST', token: dono, body: { name: 'Bia', function: 'vendedora', unit_id: foreignTenant } }, 201);
    assert.match(bia.temporary_pin, /^\d{4}$/);
    const vol = await api('/network/people', { method: 'POST', token: dono, body: { name: 'Volney', function: 'supervisor', email: 'vol@aud-ss.test', unit_ids: [tenant, foreignTenant] } }, 201);
    assert.equal(vol.password_link_sent, true); assert.equal(vol.temporary_password, undefined);
    assert.equal(sent.length, 1); assert.equal(sent[0].to[0], 'vol@aud-ss.test'); assert.match(sent[0].html, /aud-ss\.example\.test\/nova-senha#t=/);
    await api(`/network/people/${bia.id}`, { method: 'PATCH', token: dono, body: { active: false } });
    assert.equal((await db.query('SELECT active FROM users WHERE id=$1', [bia.id])).rows[0].active, false);
    const gab = (await api('/network/people', { token: dono })).find(p => p.name === 'Gabriel');
    assert.equal((await request(`/network/people/${gab.id}`, { method: 'PATCH', token: dono, body: { active: false } })).status, 403);
  } finally { await f.cleanup(); mail.close(); }
});
