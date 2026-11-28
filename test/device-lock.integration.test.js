import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('acesso só no PC da unidade: trava por unidade e da gestão; senha + prova do agente; sessão cai ao ligar ou revogar', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, foreignToken } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace', hostname: 'audace.example.test' } }, 201);
    const solares = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Solares', slug: 'audace-solares-lock' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Benfica' } });
    await api(`/master/tenants/${solares.id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Solares' } });
    await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-benfica' } });
    await api(`/master/tenants/${solares.id}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-solares' } });
    // Sem PC ativado: nem a unidade nem a gestão deixam ligar a trava.
    assert.equal((await request(`/master/tenants/${tenant}/device-lock`, { method: 'PATCH', token: masterToken, body: { enabled: true } })).status, 409);
    assert.equal((await request(`/master/networks/${net.id}/device-lock`, { method: 'PATCH', token: masterToken, body: { enabled: true } })).status, 409);
    await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'gabriel@audace.test', function: 'dono', password: 'senha-do-gabriel-1', pin: '9999' } }, 201);

    // Um PC ativado em cada unidade (agente Ficou Pronto).
    const activate = async (unit, name) => {
      const code = await api(`/master/tenants/${unit}/activation-codes`, { method: 'POST', token: masterToken }, 201);
      return api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: name } }, 201);
    };
    const pcBenfica = await activate(tenant, 'PC Benfica'), pcSolares = await activate(solares.id, 'PC Solares');
    const proofOf = async pc => (await api('/connect/login-proof', { method: 'POST', token: pc.device_token })).proof;
    const unitLogin = body => request('/auth/unit', { method: 'POST', token: null, body: { unit_id: tenant, password: 'senha-benfica', ...body } });

    // Trava desligada: tudo como antes.
    const before = await unitLogin({});
    assert.equal(before.status, 200);
    const oldSession = before.data.token;
    assert.equal((await request('/store/kiosk/sellers', { token: oldSession })).status, 200);

    // Liga a trava só em Benfica: a sessão aberta sem PC cai na hora; Solares não muda.
    assert.equal((await request(`/master/tenants/${f.foreignTenant}/device-lock`, { method: 'PATCH', token: masterToken, body: { enabled: true } })).status, 409);
    assert.deepEqual(await api(`/master/tenants/${tenant}/device-lock`, { method: 'PATCH', token: masterToken, body: { enabled: true } }), { enabled: true });
    assert.equal((await request('/auth/unit', { method: 'POST', token: null, body: { unit_id: solares.id, password: 'senha-solares' } })).status, 200);
    const dropped = await request('/store/kiosk/sellers', { token: oldSession });
    assert.equal(dropped.status, 401); assert.equal(dropped.data.code, 'device_required');

    // Sem prova, com prova de outra unidade ou com prova inventada: recusado.
    const none = await unitLogin({});
    assert.equal(none.status, 403); assert.equal(none.data.code, 'device_required');
    assert.equal((await unitLogin({ device_proof: await proofOf(pcSolares) })).status, 403);
    assert.equal((await unitLogin({ device_proof: 'nvlp_' + '0'.repeat(64) })).status, 403);

    // Prova do PC da própria unidade: abre o caixa; a prova não serve duas vezes.
    const proof = await proofOf(pcBenfica);
    const ok = await unitLogin({ device_proof: proof });
    assert.equal(ok.status, 200, ok.data.error); assert.equal(ok.data.panel, '/caixa');
    const kioskSession = ok.data.token;
    assert.equal(JSON.parse(Buffer.from(kioskSession.split('.')[1], 'base64url')).dev, pcBenfica.id);
    assert.equal((await request('/store/kiosk/sellers', { token: kioskSession })).status, 200);
    assert.equal((await unitLogin({ device_proof: proof })).status, 403);

    // Dono: sem a trava da gestão entra de qualquer lugar; com ela, só num PC de unidade da rede (qualquer unidade).
    const email = body => request('/auth/login', { method: 'POST', token: null, body: { email: 'gabriel@audace.test', password: 'senha-do-gabriel-1', ...body } });
    const free = await email({});
    assert.equal(free.status, 200, free.data.error);
    await api(`/master/networks/${net.id}/device-lock`, { method: 'PATCH', token: masterToken, body: { enabled: true } });
    assert.equal((await request('/network/me', { token: free.data.token })).data.code, 'device_required');
    const phone = await email({});
    assert.equal(phone.status, 403); assert.equal(phone.data.code, 'device_required');
    const owner = await email({ device_proof: await proofOf(pcSolares) });
    assert.equal(owner.status, 200, owner.data.error);
    assert.equal((await request('/network/me', { token: owner.data.token })).status, 200);
    // Dono pela tela da unidade (senha dele no quiosque) também precisa do PC daquela unidade.
    const ownerAtUnit = await unitLogin({ password: 'senha-do-gabriel-1', device_proof: await proofOf(pcBenfica) });
    assert.equal(ownerAtUnit.status, 200, ownerAtUnit.data.error); assert.equal(ownerAtUnit.data.panel, '/rede.html');

    // Ponte local: aceita o endereço próprio da rede.
    assert.deepEqual(await api('/connect/login-origins', { token: pcSolares.device_token }), { origins: ['https://audace.example.test'] });

    // Central vê a trava, os PCs e as tentativas recusadas; central e lojas fora da rede não são travadas.
    const panel = await api(`/master/networks/${net.id}/device-lock`, { token: masterToken });
    assert.equal(panel.enabled, true);
    assert.deepEqual(panel.units.map(u => u.locked), [true, false]);
    assert.deepEqual(panel.units.map(u => [u.label, u.devices.map(d => d.name)]), [['Benfica', ['PC Benfica']], ['Solares', ['PC Solares']]]);
    assert.ok(panel.denied.length >= 2);
    assert.equal((await request('/store/settings', { token: foreignToken })).status, 200);

    // Painel da rede: o dono vê as tentativas recusadas e quais unidades estão travadas.
    const seen = await api('/network/access-denied', { token: owner.data.token });
    assert.ok(seen.denied.length >= 2); assert.ok(seen.denied.some(x => x.unit === 'Benfica'));
    assert.deepEqual(seen.units, [{ unit: 'Benfica', locked: true }, { unit: 'Solares', locked: false }]);

    // Suporte da central: abre o caixa travado fora do PC, sem a senha; outro papel não consegue.
    const sup = await api(`/master/tenants/${tenant}/support-session`, { method: 'POST', token: masterToken });
    assert.equal(sup.panel, '/caixa');
    assert.equal((await request('/store/kiosk/sellers', { token: sup.token })).status, 200);
    assert.equal((await request(`/master/tenants/${tenant}/support-session`, { method: 'POST', token: owner.data.token })).status, 403);

    // PC revogado: a sessão aberta nele cai e ele não consegue mais provas.
    await api(`/master/tenants/${tenant}/devices/${pcBenfica.id}/revoke`, { method: 'POST', token: masterToken });
    const revoked = await request('/store/kiosk/sellers', { token: kioskSession });
    assert.equal(revoked.status, 401); assert.equal(revoked.data.code, 'device_required');
    assert.equal((await request('/connect/login-proof', { method: 'POST', token: pcBenfica.device_token })).status, 403);

    // Desliga a trava: volta a entrar pelo link, só com a senha.
    await api(`/master/tenants/${tenant}/device-lock`, { method: 'PATCH', token: masterToken, body: { enabled: false } });
    assert.equal((await unitLogin({})).status, 200);
  } finally { await f.cleanup(); }
});
