import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('estoque centralizado: lista aberta peça × unidade para loja, supervisor e dono', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignTenant, masterToken, db } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'aud-mx', hostname: 'aud-mx.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Grand Shopping' } });
    await api(`/master/tenants/${foreignTenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Benfica' } });
    const add = (t, code, name, stock, family) => db.query("INSERT INTO products(tenant_id,name,barcode,code,price_cents,stock_qty,family) VALUES($1,$2,$3,$3,4900,$4,$5)", [t, name, code, stock, family || null]);
    await add(tenant, 'BR01', 'Brinco Gota', 0, 'Brincos'); await add(foreignTenant, 'BR01', 'Brinco Gota', 3, 'Brincos');
    await add(tenant, 'AN01', 'Anel Solitário', 2, 'Anéis'); await add(foreignTenant, 'AN01', 'Anel Solitário', 0, 'Anéis');
    await add(foreignTenant, 'CO01', 'Colar Elos', 5, 'Colares');
    await add(tenant, 'PU01', 'Pulseira Fina', 0);

    // Loja (quiosque): lista completa sem digitar nada.
    let d = await api('/store/stock/matrix');
    assert.deepEqual(d.units.map(u => u.label).sort(), ['Benfica', 'Grand Shopping']);
    assert.equal(d.total, 4);
    const col = d.units.findIndex(u => u.label === 'Benfica'), me = d.units.findIndex(u => u.mine);
    const br = d.items.find(i => i.code === 'BR01');
    assert.equal(br.stock[col], 3); assert.equal(br.stock[me], 0); assert.equal(br.total, 3);
    const co = d.items.find(i => i.code === 'CO01');
    assert.equal(co.has[me], false, 'não cadastrada aqui');
    assert.deepEqual(d.families, ['Anéis', 'Brincos', 'Colares']);
    // Filtros.
    assert.deepEqual((await api('/store/stock/matrix?only=mine_zero')).items.map(i => i.code).sort(), ['BR01', 'CO01']);
    assert.deepEqual((await api('/store/stock/matrix?only=zero')).items.map(i => i.code), ['PU01']);
    assert.deepEqual((await api('/store/stock/matrix?family=Anéis')).items.map(i => i.code), ['AN01']);
    assert.deepEqual((await api('/store/stock/matrix?q=gota')).items.map(i => i.code), ['BR01']);
    d = await api('/store/stock/matrix?limit=2'); assert.equal(d.items.length, 2); assert.equal(d.total, 4);

    // Supervisor e dono pelo painel da rede.
    const people = `/master/networks/${net.id}/people`;
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'g@aud-mx.test', function: 'dono', password: 'senha-do-gabriel-123' } }, 201);
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Dani', email: 'd@aud-mx.test', function: 'supervisor', unit_ids: [tenant], password: 'senha-da-dani-1234' } }, 201);
    const login = async (email, password) => (await request('/auth/login', { method: 'POST', token: null, body: { email, password } })).data.token;
    for (const tok of [await login('g@aud-mx.test', 'senha-do-gabriel-123'), await login('d@aud-mx.test', 'senha-da-dani-1234')]) {
      d = await api('/network/stock/matrix?unit=' + tenant, { token: tok });
      assert.equal(d.total, 4); assert.equal(d.units.length, 2, 'vê todas as unidades');
      assert.equal(d.units.find(u => u.mine).label, 'Grand Shopping');
    }
  } finally { await f.cleanup(); }
});
