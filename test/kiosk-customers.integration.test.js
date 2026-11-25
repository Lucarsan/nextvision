import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';
const unitLogin = (base, body) => new Promise((resolve, reject) => {
  const u = new URL(base + '/api/auth/unit');
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: 'audace-cc.example.test', 'Content-Type': 'application/json' } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(JSON.parse(b || '{}')));
  });
  r.on('error', reject); r.write(JSON.stringify(body)); r.end();
});

test('quiosque: cadastro completo da cliente, aba Clientes da rede e fechamento com PIN de quem fecha', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, base } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace-cc', hostname: 'audace-cc.example.test' } }, 201);
    const cascavel = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Cascavel', slug: 'audace-cascavel-cc' } }, 201);
    for (const [id, label] of [[tenant, 'Maracanaú'], [cascavel.id, 'Cascavel']]) {
      await api(`/master/tenants/${id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: label } });
      await api('/master/tenants/' + id, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    }
    await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-maracanau' } });
    await api(`/master/tenants/${cascavel.id}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-cascavel' } });
    const people = `/master/networks/${net.id}/people`;
    const ana = await api(people, { method: 'POST', token: masterToken, body: { name: 'Ana Paula', function: 'vendedora', unit_id: tenant, pin: '1234' } }, 201);
    const bia = await api(people, { method: 'POST', token: masterToken, body: { name: 'Bia Souza', function: 'vendedora', unit_id: cascavel.id, pin: '4321' } }, 201);
    const kt = (await unitLogin(base, { unit_id: tenant, password: 'senha-maracanau' })).token;
    const kc = (await unitLogin(base, { unit_id: cascavel.id, password: 'senha-cascavel' })).token;
    assert.ok(kt && kc);
    await api('/store/cash/open', { method: 'POST', token: kt, body: { opening_cents: 0, seller_id: ana.id, seller_pin: '1234' } }, 201);
    await api('/store/cash/open', { method: 'POST', token: kc, body: { opening_cents: 0, seller_id: bia.id, seller_pin: '4321' } }, 201);
    const prod = (await f.db.query("INSERT INTO products(tenant_id,name,barcode,price_cents,stock_qty) VALUES($1,'Brinco Gota','003622',5000,5) RETURNING id", [tenant])).rows[0].id;
    const sale = extra => ({ items: [{ product_id: prod, quantity: 1 }], payment_method: 'pix', seller_id: ana.id, seller_pin: '1234', ...extra });

    // CPF inválido não grava a venda.
    assert.equal((await request('/store/sales', { method: 'POST', token: kt, body: sale({ new_customer: { name: 'Maria', phone: '85988881234', cpf: '11111111111' } }) })).status, 400);
    assert.equal((await request('/store/sales', { method: 'POST', token: kt, body: sale({ new_customer: { name: 'Maria', birth_date: '2999-01-01' } }) })).status, 400);

    // Venda com o cadastro completo.
    const s1 = await api('/store/sales', { method: 'POST', token: kt, body: sale({ new_customer: { name: 'Maria Souza', phone: '(85) 98888-1234', cpf: '090.961.743-05',
      birth_date: '1990-05-12', email: ' Maria@Email.com ', postal_code: '61900-000', address: 'Rua A, 10, Centro, Maracanaú', offers_opt_out: true } }) }, 201);
    const maria = s1.customer.id;
    const row = (await f.db.query("SELECT name,phone,cpf,to_char(birth_date,'YYYY-MM-DD') b,email,postal_code,address,offers_opt_out,source FROM customers WHERE id=$1", [maria])).rows[0];
    assert.deepEqual(row, { name: 'Maria Souza', phone: '85988881234', cpf: '09096174305', b: '1990-05-12', email: 'maria@email.com', postal_code: '61900000', address: 'Rua A, 10, Centro, Maracanaú', offers_opt_out: true, source: 'caixa' });

    // Mesmo WhatsApp de novo: reaproveita a ficha e só completa o que estava vazio.
    await f.db.query('UPDATE customers SET email=NULL WHERE id=$1', [maria]);
    const s2 = await api('/store/sales', { method: 'POST', token: kt, body: sale({ new_customer: { name: 'Outro Nome', phone: '85 98888-1234', email: 'novo@email.com', address: 'Outro endereço' } }) }, 201);
    assert.equal(s2.customer.id, maria);
    const again = (await f.db.query('SELECT name,email,address FROM customers WHERE id=$1', [maria])).rows[0];
    assert.deepEqual(again, { name: 'Maria Souza', email: 'novo@email.com', address: 'Rua A, 10, Centro, Maracanaú' });

    // Cadastro pela tela antiga (só nome e telefone) continua funcionando.
    await api('/store/sales', { method: 'POST', token: kt, body: sale({ new_customer: { name: 'João Lima', phone: '85977770000' } }) }, 201);

    // Aba Clientes em Cascavel: vê as clientes da rede, com as compras feitas em Maracanaú.
    const list = await api('/store/kiosk/customers', { token: kc });
    assert.equal(list.total, 2);
    const m = list.customers.find(c => c.name === 'Maria Souza');
    assert.equal(m.sales, 2); assert.equal(m.spent_cents, 10000); assert.equal(m.unit, 'Maracanaú'); assert.equal(m.local, false);
    assert.equal((await api('/store/kiosk/customers?q=090.961.743-05', { token: kc })).customers.length, 1);
    assert.equal((await api('/store/kiosk/customers?q=jo%C3%A3o', { token: kc })).customers[0].name, 'João Lima');
    // Loja fora da rede não vê.
    assert.equal((await api('/store/kiosk/customers', { token: f.foreignToken })).total, 0);
    assert.equal((await request('/store/kiosk/customers/' + maria, { token: f.foreignToken })).status, 404);

    const h = await api('/store/kiosk/customers/' + maria, { token: kc });
    assert.equal(h.customer.cpf, '09096174305'); assert.equal(h.customer.birth_date, '1990-05-12');
    assert.equal(h.totals.sales, 2); assert.equal(h.sales[0].unit, 'Maracanaú'); assert.equal(h.sales[0].items[0].name, 'Brinco Gota'); assert.equal(h.sales[0].seller_name, 'Ana Paula');

    // Cascavel adota a cliente e edita: o cadastro muda nas duas fichas (cadastro único).
    const local = await api('/store/sales/customers/adopt', { method: 'POST', token: kc, body: { id: maria } });
    assert.equal((await request('/store/kiosk/customers/' + local.id, { method: 'PATCH', token: kc, body: { name: 'Maria', cpf: '123' } })).status, 400);
    await api('/store/kiosk/customers/' + local.id, { method: 'PATCH', token: kc, body: { name: 'Maria Souza Lima', phone: '85988881234', cpf: '09096174305', birth_date: '1990-05-13', email: 'maria@novo.com', postal_code: '', address: 'Rua B, 20', offers_opt_out: false } });
    const both = (await f.db.query("SELECT name,to_char(birth_date,'YYYY-MM-DD') b,email,postal_code,offers_opt_out FROM customers WHERE id=ANY($1::uuid[]) ORDER BY id", [[maria, local.id]])).rows;
    assert.equal(both.length, 2);
    for (const x of both) assert.deepEqual(x, { name: 'Maria Souza Lima', b: '1990-05-13', email: 'maria@novo.com', postal_code: null, offers_opt_out: false });
    // A lista mostra a pessoa uma vez só, agora pela ficha de Cascavel.
    const l2 = await api('/store/kiosk/customers?q=Maria', { token: kc });
    assert.equal(l2.customers.length, 1); assert.equal(l2.customers[0].id, local.id); assert.equal(l2.customers[0].local, true);

    // Cadastro avulso pela aba Clientes; repetido devolve a mesma ficha.
    const n1 = await api('/store/kiosk/customers', { method: 'POST', token: kc, body: { name: 'Carla Dias', phone: '88999990000', birth_date: '1985-12-01' } }, 201);
    const n2 = await api('/store/kiosk/customers', { method: 'POST', token: kc, body: { name: 'Carla D.', phone: '(88) 99999-0000', email: 'carla@x.com' } }, 200);
    assert.equal(n1.created, true); assert.equal(n2.created, false); assert.equal(n1.id, n2.id);

    // Fechar o caixa: exige o PIN e grava quem fechou (a vendedora, não o login do quiosque).
    assert.equal((await request('/store/cash/close', { method: 'POST', token: kc, body: { counted_cash_cents: 0, seller_id: bia.id, seller_pin: '0000' } })).status, 401);
    assert.equal((await request('/store/cash/close', { method: 'POST', token: kc, body: { counted_cash_cents: 0, seller_id: ana.id, seller_pin: '1234' } })).status, 401);
    const cl = await api('/store/cash/close', { method: 'POST', token: kc, body: { counted_cash_cents: 0, seller_id: bia.id, seller_pin: '4321' } });
    assert.equal(cl.session.closed_by, bia.id); assert.match(cl.session.close_note, /fechado por Bia Souza/);
  } finally { await f.cleanup(); }
});
