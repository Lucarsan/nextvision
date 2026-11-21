import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStoreFixture } from './helpers/store-fixture.js';
import { validCnpj } from '../src/store-networks.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

const getWithHost = (base, path, host) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Host: host } }, res => {
    let body = ''; res.on('data', c => { body += c; }); res.on('end', () => { let data = body; try { data = JSON.parse(body); } catch { } resolve({ status: res.statusCode, data, location: res.headers.location }); });
  }).on('error', reject);
});

test('CNPJ: dígitos verificadores', () => {
  assert.equal(validCnpj('11222333000181'), true);
  assert.equal(validCnpj('11222333000182'), false);
  assert.equal(validCnpj('11111111111111'), false);
});

test('rede de lojas: central monta a rede, dono da rede vê o faturamento por unidade', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignTenant, masterToken, ownerToken, base, db } = f;

    // Central cria a rede com endereço próprio.
    assert.equal((await request('/master/networks', { method: 'POST', token: ownerToken, body: { name: 'Audace Joias', slug: 'audace' } })).status, 403);
    assert.equal((await request('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace', brand_color: 'roxo' } })).status, 400);
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace', hostname: 'Audace.FicouPronto.com', brand_color: '#7a5c2e' } }, 201);
    assert.equal(net.hostname, 'audace.ficoupronto.com');
    assert.equal((await request('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Outra', slug: 'outra', hostname: 'audace.ficoupronto.com' } })).status, 409);

    // Duas unidades na rede (a loja de teste e uma nova); a "Outra loja" fica fora.
    const unit2 = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Solares', slug: 'audace-solares' } }, 201);
    assert.equal((await request(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, cnpj: '11.222.333/0001-82' } })).status, 400);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, cnpj: '11.222.333/0001-81', unit_label: 'Maracanaú' } });
    await api(`/master/tenants/${unit2.id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Solares' } });
    assert.equal((await request(`/master/tenants/${unit2.id}/network`, { method: 'PATCH', token: masterToken, body: { cnpj: '11222333000181' } })).status, 409);
    assert.deepEqual((await api(`/master/networks/${net.id}/units`, { token: masterToken })).map(u => u.unit_label), ['Maracanaú', 'Solares']);
    assert.equal((await api('/master/networks', { token: masterToken }))[0].units_count, 2);

    // Login do dono da rede.
    const password = 'senha-forte-da-rede-123';
    const gabriel = await api(`/master/networks/${net.id}/users`, { method: 'POST', token: masterToken, body: { name: 'Gabriel Mota', email: 'Gabriel@Audace.test', password } }, 201);
    assert.equal(gabriel.email, 'gabriel@audace.test');
    const login = await api('/auth/login', { method: 'POST', token: null, body: { email: 'gabriel@audace.test', password } });
    assert.equal(login.user.role, 'network'); assert.equal(login.user.network_id, net.id);
    const netToken = login.token;
    const me = await api('/me', { token: netToken }); assert.equal(me.network_id, net.id); assert.equal(me.tenant_id, null);

    // Vendas: 2 na unidade 1 (uma dividida), 1 cancelada; nada da "Outra loja" entra.
    for (const id of [tenant, foreignTenant]) await api('/master/tenants/' + id, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 10000, payment_method: 'credit' } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 5000, payments: [{ method: 'cash', amount_cents: 2000 }, { method: 'pix', amount_cents: 3000 }] } }, 201);
    const dup = await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 5000, payment_method: 'pix' } }, 201);
    await api(`/store/sales/${dup.sale.id}/cancel`, { method: 'POST', body: { reason: 'Lançada em dobro' } });
    await api('/store/cash/open', { method: 'POST', token: f.foreignToken, body: { opening_cents: 0 } }, 201);
    await api('/store/sales', { method: 'POST', token: f.foreignToken, body: { anonymous: true, total_cents: 99900, payment_method: 'pix' } }, 201);

    const info = await api('/network/me', { token: netToken });
    assert.equal(info.network.name, 'Audace Joias'); assert.deepEqual(info.units.map(u => u.unit_label), ['Maracanaú', 'Solares']);

    const ov = await api('/network/overview', { token: netToken });
    assert.equal(ov.units.length, 2);
    const [maracanau, solares] = ov.units;
    assert.equal(maracanau.name, 'Maracanaú'); assert.equal(maracanau.sales_count, 2); assert.equal(maracanau.total_cents, 15000);
    assert.equal(maracanau.canceled_count, 1); assert.equal(maracanau.average_ticket_cents, 7500);
    assert.deepEqual(maracanau.by_method, { cash: 2000, pix: 3000, debit: 0, credit: 10000, other: 0 });
    assert.equal(solares.sales_count, 0); assert.equal(solares.total_cents, 0);
    assert.equal(ov.totals.total_cents, 15000); assert.equal(ov.totals.sales_count, 2);
    assert.equal((await request('/network/overview?from=2026-01-01&to=2026-12-31', { token: netToken })).status, 400);
    assert.equal((await request('/network/overview?from=2026-02-01&to=2026-01-01', { token: netToken })).status, 400);
    const past = await api('/network/overview?from=2020-01-01&to=2020-01-31', { token: netToken });
    assert.equal(past.totals.sales_count, 0);

    // Isolamento: o dono da rede não opera o caixa; loja não vê o painel da rede.
    assert.equal((await request('/store/sales/config', { token: netToken })).status, 403);
    assert.equal((await request('/network/overview', { token: ownerToken })).status, 403);
    assert.equal((await request('/master/networks', { token: netToken })).status, 403);

    // Tirar a unidade da rede tira o faturamento dela do painel.
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: null } });
    assert.deepEqual((await api('/network/overview', { token: netToken })).units.map(u => u.name), ['Solares']);

    // Marca pelo endereço (tela de login).
    assert.deepEqual((await getWithHost(base, '/api/public/brand', 'audace.ficoupronto.com')).data, { network: true, name: 'Audace Joias', logo_url: null, brand_color: '#7a5c2e' });
    assert.deepEqual((await getWithHost(base, '/api/public/brand', 'app.ficoupronto.com')).data, { network: false });
    assert.deepEqual((await getWithHost(base, '/api/public/brand', 'outra.ficoupronto.com')).data, { network: false });
    const root = await getWithHost(base, '/', 'audace.ficoupronto.com');
    assert.equal(root.status, 302); assert.equal(root.location, '/entrar');
    assert.equal((await getWithHost(base, '/', 'app.ficoupronto.com')).status, 200);
    assert.equal((await getWithHost(base, '/rede.html', 'audace.ficoupronto.com')).status, 200);

    // Rede suspensa ou login desativado: acesso cortado na hora.
    await api(`/master/networks/${net.id}`, { method: 'PATCH', token: masterToken, body: { status: 'suspended' } });
    assert.equal((await request('/network/me', { token: netToken })).status, 403);
    assert.equal((await request('/auth/login', { method: 'POST', token: null, body: { email: 'gabriel@audace.test', password } })).status, 403);
    await api(`/master/networks/${net.id}`, { method: 'PATCH', token: masterToken, body: { status: 'active' } });
    assert.equal((await request('/network/me', { token: netToken })).status, 200);
    await api(`/master/network-users/${gabriel.id}`, { method: 'PATCH', token: masterToken, body: { active: false } });
    assert.equal((await request('/network/me', { token: netToken })).status, 403);

    // Restrição no banco: usuário de rede sem rede é recusado.
    await assert.rejects(db.query("INSERT INTO users(name,email,password_hash,role) VALUES('X','x@x.test','x','network')"));
  } finally { await f.cleanup(); }
});
