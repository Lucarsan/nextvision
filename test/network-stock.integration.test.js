import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('estoque da rede: contagem, consulta entre unidades e transferência bipada com diferença', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { tenant, masterToken, api, request } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace-est', hostname: 'audace-est.example.test' } }, 201);
    const dep = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Depósito', slug: 'audace-deposito-est' } }, 201);
    const depToken = await f.addOwner(dep.id);
    for (const [id, label] of [[tenant, 'Maracanaú'], [dep.id, 'Depósito']]) {
      await api(`/master/tenants/${id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: label } });
      await api('/master/tenants/' + id, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    }
    await api(`/master/tenants/${dep.id}/depot`, { method: 'PATCH', token: masterToken, body: { depot: true } });
    const add = (t, code, name, stock) => f.db.query("INSERT INTO products(tenant_id,name,barcode,code,price_cents,stock_qty) VALUES($1,$2,$3,$3,4900,$4) RETURNING id", [t, name, code, stock]).then(r => r.rows[0].id);
    const dA = await add(dep.id, '1511', 'ALIANCA ACO', 0), dB = await add(dep.id, '62', 'BRINCO PONTO DE LUZ', 0), dC = await add(dep.id, '777', 'COLAR NOVO', 0);
    const mA = await add(tenant, '1511', 'ALIANCA ACO', 3), mB = await add(tenant, '62', 'BRINCO PONTO DE LUZ', 9);

    // Contagem no depósito: 10 alianças, 5 brincos, 4 colares; sem zerar as não contadas.
    const cnt = await api('/store/stock/count', { method: 'POST', token: depToken, body: { items: [{ product_id: dA, quantity: 10 }, { product_id: dB, quantity: 5 }, { product_id: dC, quantity: 4 }] } });
    assert.equal(cnt.counted, 3); assert.equal(cnt.units, 19);
    assert.equal((await request('/store/stock/count', { method: 'POST', token: depToken, body: { items: [{ product_id: mA, quantity: 1 }] } })).status, 400);
    // Contagem completa em Maracanaú: só a aliança foi achada (2); o brinco zera.
    const cm = await api('/store/stock/count', { method: 'POST', body: { items: [{ product_id: mA, quantity: 2 }], zero_others: true } });
    assert.equal(cm.zeroed, 1);

    // Consulta na rede pelo código: estoque de cada unidade.
    const look = await api('/store/stock/network?q=1511');
    assert.deepEqual(look[0].units.map(u => [u.unit, u.stock]), [['Depósito', 10], ['Maracanaú', 2]]);

    // Envio do depósito para Maracanaú: sai na hora do depósito.
    const units = await api('/store/network-units', { token: depToken });
    assert.equal(units.me.depot, true);
    const tr = await api('/store/transfers', { method: 'POST', token: depToken, body: { to_tenant_id: tenant, items: [{ product_id: dA, quantity: 3 }, { product_id: dC, quantity: 2 }, { product_id: dA, quantity: 1 }], note: 'Reposição' } }, 201);
    assert.equal(tr.units, 6);
    assert.equal((await f.db.query('SELECT stock_qty FROM products WHERE id=$1', [dA])).rows[0].stock_qty, 6);
    // Maracanaú vê a transferência a receber; recebe 4 alianças e só 1 colar (que ela nem tinha cadastrado).
    const inc = (await api('/store/transfers')).find(t => t.id === tr.id);
    assert.equal(inc.outgoing, false); assert.equal(inc.status, 'sent');
    assert.equal((await request(`/store/transfers/${tr.id}/receive`, { method: 'POST', body: { items: [{ code: '999', quantity: 1 }] } })).status, 400);
    const rc = await api(`/store/transfers/${tr.id}/receive`, { method: 'POST', body: { items: [{ code: '1511', quantity: 4 }, { code: '777', quantity: 1 }] } });
    assert.equal(rc.status, 'divergent');
    const st = Object.fromEntries((await f.db.query("SELECT code, stock_qty FROM products WHERE tenant_id=$1 AND active", [tenant])).rows.map(r => [r.code, r.stock_qty]));
    assert.deepEqual(st, { '1511': 6, '62': 0, '777': 1 });
    assert.equal((await request(`/store/transfers/${tr.id}/receive`, { method: 'POST', body: { items: [] } })).status, 404);

    // Painel da rede (dono): a transferência com diferença aparece para conferir.
    const dono = await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'g@audace-est.test', function: 'dono', password: 'senha-do-gabriel-123' } }, 201);
    const login = await request('/auth/login', { method: 'POST', token: null, body: { email: 'g@audace-est.test', password: 'senha-do-gabriel-123' } });
    const list = await api('/network/transfers', { token: login.data.token });
    assert.equal(list.length, 1); assert.equal(list[0].status, 'divergent'); assert.deepEqual(list[0].items.map(i => [i.code, i.qty_sent, i.qty_received]), [['777', 2, 1]]);
    assert.ok(dono.id);
  } finally { await f.cleanup(); }
});
