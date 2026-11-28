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
    assert.equal(maracanau.cash_open, true); assert.equal(solares.cash_open, false);
    assert.equal(maracanau.month_goal_cents, null); assert.equal(maracanau.cashback_used_cents, 0);
    assert.equal(ov.alerts.canceled.length, 1); assert.equal(ov.alerts.canceled[0].unit, 'Maracanaú');
    assert.equal(ov.alerts.canceled[0].reason, 'Lançada em dobro'); assert.equal(ov.alerts.canceled[0].canceled_by, 'Owner');
    assert.deepEqual(ov.alerts.duplicates, []); assert.deepEqual(ov.alerts.low_stock, []);
    // Cancelamentos por consultora: cupom fiscal cancelado conta à parte (cupom de teste não conta).
    assert.deepEqual(ov.alerts.canceled_sellers, [{ unit: 'Maracanaú', seller: 'Owner', count: 1, total_cents: 5000, with_nfce: 0 }]);
    await db.query("INSERT INTO fiscal_documents(tenant_id,sale_id,env,series,number,status,payload,is_test) VALUES($1,$2,'producao',10,1,'canceled','{}',false),($1,$2,'homologacao',10,2,'canceled','{}',true)", [tenant, dup.sale.id]);
    assert.equal((await api('/network/overview', { token: netToken })).alerts.canceled_sellers[0].with_nfce, 1);
    await db.query('DELETE FROM fiscal_documents WHERE sale_id=$1', [dup.sale.id]);

    // Meta do mês da loja, cobrança repetida e estoque baixo.
    await db.query("INSERT INTO store_goals(tenant_id, month, target_cents) VALUES($1, date_trunc('month', now() AT TIME ZONE 'America/Fortaleza')::date, 50000)", [tenant]);
    const again = await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 10000, payment_method: 'credit' } }, 201);
    const prod = (await db.query("INSERT INTO products(tenant_id, name, price_cents, stock_qty) VALUES($1, 'Brinco argola prata', 10000, 1) RETURNING id", [tenant])).rows[0].id;
    await db.query("INSERT INTO sale_items(tenant_id, sale_id, product_id, name, quantity, unit_price_cents, total_cents) VALUES($1, $2, $3, 'Brinco argola prata', 1, 10000, 10000)", [tenant, again.sale.id, prod]);
    const ov2 = await api('/network/overview', { token: netToken });
    assert.equal(ov2.units[0].month_goal_cents, 50000); assert.equal(ov2.units[0].month_total_cents, 25000); assert.equal(ov2.units[0].month_goal_percent, 50);
    assert.equal(ov2.alerts.duplicates.length, 1);
    assert.equal(ov2.alerts.duplicates[0].unit, 'Maracanaú'); assert.equal(ov2.alerts.duplicates[0].total_cents, 10000); assert.equal(ov2.alerts.duplicates[0].payment_method, 'credit');
    assert.deepEqual(ov2.alerts.low_stock, [{ unit: 'Maracanaú', products: [{ name: 'Brinco argola prata', stock_qty: 1, sold_30d: 1 }] }]);
    assert.equal((await api('/network/me', { token: netToken })).user.name, 'Gabriel Mota');
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
    assert.equal(root.status, 302); assert.equal(root.location, '/acesso');
    assert.equal((await getWithHost(base, '/entrar', 'audace.ficoupronto.com')).location, '/acesso');
    assert.equal((await getWithHost(base, '/entrar', 'app.ficoupronto.com')).status, 200);
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

test('pessoas da rede: funções, supervisor por unidade e nova senha por e-mail', { skip }, async () => {
  // Servidor de e-mail falso no lugar do Resend: guarda o que seria enviado.
  const mails = [];
  const mail = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { mails.push(JSON.parse(b)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"x"}'); }); });
  await new Promise(r => mail.listen(0, '127.0.0.1', r));
  const f = await createStoreFixture({ env: { RESEND_API_KEY: 'test-key', EMAIL_FROM: 'Ficou Pronto <nao-responda@example.test>', RESEND_API_URL: `http://127.0.0.1:${mail.address().port}/emails`, PUBLIC_BASE_URL: 'https://app.example.test' } });
  try {
    const { api, request, tenant, masterToken, ownerToken, db } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace', hostname: 'audace.example.test' } }, 201);
    const unit2 = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Solares', slug: 'audace-solares' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Maracanaú' } });
    await api(`/master/tenants/${unit2.id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Solares' } });
    const people = `/master/networks/${net.id}/people`;

    // Criar: dono (senha temporária devolvida uma vez), supervisor de Solares, consultora de Maracanaú.
    const dono = await api(people, { method: 'POST', token: masterToken, body: { name: 'Gabriel Mota', email: 'Gabriel@Audace.test', function: 'dono' } }, 201);
    assert.equal(dono.function, 'dono'); assert.equal(dono.email, 'gabriel@audace.test'); assert.ok(dono.temporary_password.length >= 12);
    const sup = await api(people, { method: 'POST', token: masterToken, body: { name: 'Supervisor 1', email: 'sup1@audace.test', function: 'supervisor', unit_ids: [unit2.id], password: 'senha-do-supervisor-1' } }, 201);
    assert.equal(sup.temporary_password, undefined); assert.deepEqual(sup.unit_ids, [unit2.id]);
    const cons = await api(people, { method: 'POST', token: masterToken, body: { name: 'Consultora 1', email: 'c1@audace.test', function: 'consultora', unit_id: tenant, password: 'senha-da-consultora-1' } }, 201);
    assert.equal(cons.unit_id, tenant);
    // Unidade de fora da rede, sem unidade ou e-mail repetido: recusado.
    assert.equal((await request(people, { method: 'POST', token: masterToken, body: { name: 'Xavier', email: 'x@audace.test', function: 'consultora', unit_id: f.foreignTenant } })).status, 400);
    assert.equal((await request(people, { method: 'POST', token: masterToken, body: { name: 'Xavier', email: 'x@audace.test', function: 'consultora' } })).status, 400);
    assert.equal((await request(people, { method: 'POST', token: masterToken, body: { name: 'Xavier', email: 'c1@audace.test', function: 'dono' } })).status, 409);
    assert.equal((await request(people, { token: ownerToken })).status, 403);
    // Lista: donos e supervisores primeiro, depois o pessoal das unidades (inclui o dono da loja de teste).
    const list = await api(people, { token: masterToken });
    assert.deepEqual(list.slice(0, 2).map(p => p.function).sort(), ['dono', 'supervisor']);
    assert.ok(list.some(p => p.email === 'c1@audace.test' && p.function === 'consultora'));
    assert.ok(list.some(p => p.function === 'gerente' && p.unit_id === tenant));

    // Consultora entra no caixa da unidade como operadora novata (não cancela).
    const lc = await api('/auth/login', { method: 'POST', token: null, body: { email: 'c1@audace.test', password: 'senha-da-consultora-1' } });
    assert.equal(lc.user.role, 'operator'); assert.equal(lc.user.tenant_id, tenant);

    // Supervisor só vê Solares.
    const ls = await api('/auth/login', { method: 'POST', token: null, body: { email: 'sup1@audace.test', password: 'senha-do-supervisor-1' } });
    const supInfo = await api('/network/me', { token: ls.token });
    assert.equal(supInfo.user.access, 'supervisor'); assert.deepEqual(supInfo.units.map(u => u.unit_label), ['Solares']);
    assert.deepEqual((await api('/network/overview', { token: ls.token })).units.map(u => u.name), ['Solares']);

    // Editar: a consultora vira supervisora de Maracanaú; a sessão antiga de consultora cai.
    const moved = await api(`/master/network-people/${cons.id}`, { method: 'PATCH', token: masterToken, body: { function: 'supervisor', unit_ids: [tenant], name: 'Consultora Promovida' } });
    assert.equal(moved.function, 'supervisor'); assert.equal(moved.unit_id, null); assert.equal(moved.name, 'Consultora Promovida');
    assert.equal((await request('/store/sales/config', { token: lc.token })).status, 403);
    // Volta a consultora em Solares, troca e-mail e desativa.
    const back = await api(`/master/network-people/${cons.id}`, { method: 'PATCH', token: masterToken, body: { function: 'consultora', unit_id: unit2.id, email: 'consultora@audace.test', active: false } });
    assert.equal(back.unit_id, unit2.id); assert.equal(back.email, 'consultora@audace.test'); assert.equal(back.active, false);
    assert.equal((await request(`/master/network-people/${cons.id}`, { method: 'PATCH', token: masterToken, body: { unit_id: f.foreignTenant } })).status, 400);

    // Esqueci a senha: resposta igual para e-mail com e sem conta; só quem tem conta recebe.
    const unknown = await api('/auth/forgot', { method: 'POST', token: null, body: { email: 'ninguem@audace.test' } });
    const known = await api('/auth/forgot', { method: 'POST', token: null, body: { email: 'SUP1@audace.test' } });
    assert.deepEqual(unknown, known); assert.equal(mails.length, 1);
    assert.deepEqual(mails[0].to, ['sup1@audace.test']); assert.match(mails[0].subject, /Audace Joias/);
    const link = /href="([^"]+)"/.exec(mails[0].html)[1];
    assert.match(link, /^https:\/\/audace\.example\.test\/nova-senha#t=/);
    const token = link.split('#t=')[1];
    // Pedido repetido em menos de 1 minuto não manda outro e-mail.
    await api('/auth/forgot', { method: 'POST', token: null, body: { email: 'sup1@audace.test' } }); assert.equal(mails.length, 1);
    // Desativado não recebe.
    await api('/auth/forgot', { method: 'POST', token: null, body: { email: 'consultora@audace.test' } }); assert.equal(mails.length, 1);

    // O login vale por segundos inteiros: espera virar o segundo para a troca de senha valer depois dele.
    await new Promise(r => setTimeout(r, 1100));
    assert.equal((await request('/auth/reset', { method: 'POST', token: null, body: { token, password: 'curta' } })).status, 400);
    const reset = await api('/auth/reset', { method: 'POST', token: null, body: { token, password: 'nova-senha-do-supervisor' } });
    assert.equal(reset.email, 'sup1@audace.test');
    assert.equal((await request('/auth/reset', { method: 'POST', token: null, body: { token, password: 'outra-senha-qualquer-1' } })).status, 400, 'link vale uma vez');
    assert.equal((await request('/network/me', { token: ls.token })).status, 401, 'sessão antiga cai');
    assert.equal((await request('/auth/login', { method: 'POST', token: null, body: { email: 'sup1@audace.test', password: 'senha-do-supervisor-1' } })).status, 401);
    const relog = await api('/auth/login', { method: 'POST', token: null, body: { email: 'sup1@audace.test', password: 'nova-senha-do-supervisor' } });
    assert.equal((await request('/network/me', { token: relog.token })).status, 200);

    // Central manda o link para uma loja sem rede: endereço padrão do Ficou Pronto.
    const out = await api(`/master/users/${dono.id}/password-link`, { method: 'POST', token: masterToken });
    assert.equal(out.email, 'gabriel@audace.test'); assert.equal(mails.length, 2);
    const ownerId = list.find(p => p.function === 'gerente').id;
    await db.query('UPDATE tenants SET network_id = NULL WHERE id = $1', [tenant]);
    await api(`/master/users/${ownerId}/password-link`, { method: 'POST', token: masterToken });
    assert.match(mails[2].html, /https:\/\/app\.example\.test\/nova-senha#t=/);
    assert.equal((await request(`/master/users/${ownerId}/password-link`, { method: 'POST', token: ownerToken })).status, 403);
  } finally { await f.cleanup(); mail.close(); }
});
