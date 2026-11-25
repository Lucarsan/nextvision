import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('estoque da rede (painel): cadastro e preço na rede toda, entrada, etiquetas, códigos, reposição, histórico e valor só do dono', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { tenant, masterToken, api, request } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'aud-cat', hostname: 'aud-cat.example.test' } }, 201);
    const dep = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Depósito', slug: 'aud-cat-dep' } }, 201);
    const sob = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Sobral', slug: 'aud-cat-sob' } }, 201);
    for (const [id, label] of [[tenant, 'Maracanaú'], [dep.id, 'Depósito'], [sob.id, 'Sobral']]) {
      await api(`/master/tenants/${id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: label } });
      await api('/master/tenants/' + id, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    }
    await api(`/master/tenants/${dep.id}/depot`, { method: 'PATCH', token: masterToken, body: { depot: true } });
    const people = `/master/networks/${net.id}/people`;
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'g@aud-cat.test', function: 'dono', password: 'senha-do-gabriel-123' } }, 201);
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Dani', email: 'd@aud-cat.test', function: 'supervisor', unit_ids: [tenant], password: 'senha-da-dani-1234', pin: '5555' } }, 201);
    const login = async (email, password) => (await request('/auth/login', { method: 'POST', token: null, body: { email, password } })).data.token;
    const dono = await login('g@aud-cat.test', 'senha-do-gabriel-123'), sup = await login('d@aud-cat.test', 'senha-da-dani-1234');
    assert.ok(dono && sup);

    // Peça antiga sem código nenhum (só em Sobral).
    await f.db.query("INSERT INTO products(tenant_id,name,price_cents,stock_qty) VALUES($1,'PULSEIRA SEM CODIGO',5000,2)", [sob.id]);

    // Supervisor cadastra peça nova com 5 chegando em Maracanaú: entra nas 3 unidades, mesmo preço.
    const meta = await api('/network/catalog?limit=1', { token: sup });
    assert.equal(meta.owner, false); assert.deepEqual(meta.my_units.map(u => u.label), ['Maracanaú']);
    assert.equal((await request('/network/catalog', { method: 'POST', token: sup, body: { code: '3622', name: 'ANEL SOLITARIO', price_cents: 8990, unit_id: sob.id, quantity: 2 } })).status, 403, 'supervisor não dá entrada fora das unidades dele');
    const np = await api('/network/catalog', { method: 'POST', token: sup, body: { code: '3622', name: 'ANEL SOLITARIO', family: 'ANEIS', price_cents: 8990, cost_cents: 3000, unit_id: tenant, quantity: 5, labels: 'each' } }, 201);
    assert.equal(np.units, 3);
    const rows = (await f.db.query("SELECT tenant_id, price_cents, stock_qty, barcode, labels_pending FROM products WHERE code='3622'")).rows;
    assert.equal(rows.length, 3); assert.ok(rows.every(r => r.price_cents === 8990 && r.barcode === '3622'));
    assert.deepEqual(rows.find(r => r.tenant_id === tenant), { tenant_id: tenant, price_cents: 8990, stock_qty: 5, barcode: '3622', labels_pending: 5 });
    assert.equal((await request('/network/catalog', { method: 'POST', token: dono, body: { code: '3622', name: 'OUTRO', price_cents: 100 } })).status, 409);
    // Código gerado para peça nova sem código.
    const gen = await api('/network/catalog', { method: 'POST', token: dono, body: { generate: true, name: 'BRINCO NOVO', price_cents: 4500 } }, 201);
    assert.match(gen.code, /^2\d{12}$/);

    // Supervisor não vê custo; dono vê.
    assert.equal((await api('/network/catalog?q=3622', { token: sup })).items[0].cost_cents, undefined);
    assert.equal((await api('/network/catalog?q=3622', { token: dono })).items[0].cost_cents, 3000);
    assert.equal((await request('/network/catalog/update', { method: 'POST', token: sup, body: { key: '3622', cost_cents: 1 } })).status, 403);

    // Preço por peça (supervisor pode) muda nas 3 unidades.
    assert.equal((await api('/network/catalog/update', { method: 'POST', token: sup, body: { key: '3622', price_cents: 9990 } })).updated, 3);
    // Reajuste em lote: prévia não muda nada; aplicar muda todas.
    const pv = await api('/network/prices/reprice', { method: 'POST', token: dono, body: { percent: 10, rounding: '1.00', family: 'ANEIS', preview: true } });
    assert.deepEqual(pv.items.map(i => [i.key, i.old_cents, i.new_cents]), [['3622', 9990, 11000]]);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM products WHERE code='3622' AND price_cents=9990")).rows[0].n, 3);
    await api('/network/prices/reprice', { method: 'POST', token: dono, body: { percent: 10, rounding: '1.00', family: 'ANEIS' } }, 201);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM products WHERE code='3622' AND price_cents=11000")).rows[0].n, 3);

    // Entrada rápida no depósito (dono): bipa o mesmo código duas vezes, soma.
    const en = await api('/network/stock/entry', { method: 'POST', token: dono, body: { unit_id: dep.id, items: [{ key: '3622', quantity: 4 }, { key: '3622', quantity: 6, unit_cost_cents: 2800 }], labels: 'one' } });
    assert.equal(en.units, 10); assert.equal(en.items[0].stock_qty, 10); assert.equal(en.items[0].labels, 1);
    assert.equal((await request('/network/stock/entry', { method: 'POST', token: sup, body: { unit_id: dep.id, items: [{ key: '3622', quantity: 1 }] } })).status, 403);
    assert.equal((await request('/network/stock/entry', { method: 'POST', token: dono, body: { unit_id: dep.id, items: [{ key: 'NAOEXISTE', quantity: 1 }] } })).status, 404);

    // Etiquetas: fila de Maracanaú tem as 5 da entrada; imprimir tira da fila.
    let q = await api('/network/labels?unit_id=' + tenant, { token: sup });
    assert.deepEqual(q.map(r => [r.key, r.labels_pending]), [['3622', 5]]);
    q = await api('/network/labels', { method: 'POST', token: sup, body: { unit_id: tenant, key: gen.key, add: 2 } });
    assert.equal(q.length, 2);
    assert.equal((await api('/network/labels/printed', { method: 'POST', token: sup, body: { unit_id: tenant, keys: ['3622', gen.key] } })).cleared, 2);
    assert.equal((await api('/network/labels?unit_id=' + tenant, { token: sup })).length, 0);

    // Gerar código para a peça antiga sem código.
    const nob = await api('/network/catalog?no_barcode=1', { token: dono });
    assert.deepEqual(nob.items.map(i => i.name), ['PULSEIRA SEM CODIGO']);
    const gc = await api('/network/catalog/generate-code', { method: 'POST', token: dono, body: { key: nob.items[0].key } });
    assert.match(gc.barcode, /^2\d{12}$/); assert.equal(gc.key, gc.barcode);
    assert.equal((await api('/network/catalog?no_barcode=1', { token: dono })).items.length, 0);

    // Reposição: peça vendida e não reposta aparece, com o que tem no depósito.
    await f.db.query("UPDATE products SET restock_pending=2, stock_qty=3 WHERE tenant_id=$1 AND code='3622'", [tenant]);
    const rs = await api('/network/stock/restock', { token: sup });
    assert.deepEqual(rs.rows.map(r => [r.unit, r.key, r.sold, r.depot_qty]), [['Maracanaú', '3622', 2, 10]]);
    await api('/network/stock/restocked', { method: 'POST', token: sup, body: { unit_id: tenant, key: '3622' } });
    assert.equal((await api('/network/stock/restock', { token: sup })).rows.length, 0);

    // Histórico: supervisor só vê Maracanaú; dono vê o depósito também.
    const lgS = await api('/network/stock/log', { token: sup });
    assert.ok(lgS.rows.length >= 1 && lgS.rows.every(r => r.unit === 'Maracanaú'));
    const lgD = await api('/network/stock/log?unit_id=' + dep.id + '&kind=entry', { token: dono });
    assert.deepEqual(lgD.rows.map(r => r.quantity).sort((a, b) => a - b), [10]);
    assert.equal((await request('/network/stock/log?unit_id=' + dep.id, { token: sup })).status, 403);

    // Valor do estoque: só o dono.
    assert.equal((await request('/network/stock/value', { token: sup })).status, 403);
    const val = await api('/network/stock/value', { token: dono });
    const d = val.rows.find(r => r.unit === 'Depósito');
    assert.equal(d.qty, 10); assert.equal(d.cost_cents, 30000); assert.equal(d.price_cents, 110000);
    assert.equal(val.total.qty, 10 + 3 + 2);
    assert.equal(d.profit_cents, 80000);
    assert.equal(val.rows.find(r => r.unit === 'Sobral').profit_cents, 0, 'peça sem custo não entra no lucro');

    // A tabela "Estoque por unidade" continua enxergando a peça em todas as unidades.
    const mx = await api('/network/stock/matrix?q=3622', { token: dono });
    assert.deepEqual(mx.items[0].has, [true, true, true]);
  } finally { await f.cleanup(); }
});
