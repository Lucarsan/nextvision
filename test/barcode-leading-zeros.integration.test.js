import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';
import { sameCode } from '../src/code-match.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('sameCode: zeros à esquerda só em códigos numéricos', () => {
  assert.ok(sameCode('000573', '573'));
  assert.ok(sameCode('573', '0573'));
  assert.ok(!sameCode('573', '5730'));
  assert.ok(!sameCode('A573', '573'));
  assert.ok(!sameCode('000', '0'));
  assert.ok(!sameCode('', '573'));
});

test('etiqueta 000573 acha o produto 573; exato vence; ambíguo pede escolha', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    const davi = await api('/store/products', { method: 'POST', body: { name: 'Pingente Estrela de Davi', barcode: '573', price_cents: 4000 } }, 201);
    assert.equal((await api('/store/products/barcode/000573')).id, davi.id, 'etiqueta com zeros');
    assert.equal((await api('/store/products?q=000573'))[0].id, davi.id, 'busca da lista com zeros');

    const a = await api('/store/products', { method: 'POST', body: { name: 'Brinco ponto de luz', barcode: '0796', price_cents: 1000 } }, 201);
    const b = await api('/store/products', { method: 'POST', body: { name: 'Brinco ponto de luz variados', barcode: '796', price_cents: 1200 } }, 201);
    assert.equal((await api('/store/products/barcode/0796')).id, a.id, 'exato vence');
    assert.equal((await api('/store/products/barcode/796')).id, b.id, 'exato vence');
    const amb = await request('/store/products/barcode/000796');
    assert.equal(amb.status, 409, 'dois candidatos: não escolhe sozinho');
    const list = await api('/store/products?q=000796');
    assert.deepEqual(new Set(list.slice(0, 2).map(x => x.id)), new Set([a.id, b.id]), 'lista mostra os dois');
  } finally { await f.cleanup(); }
});
