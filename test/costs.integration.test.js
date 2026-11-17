import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';
import { allocate } from '../src/costs.js';

const skip = process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL';

test('custos: rateio do banco pelo tempo acordado, espaço e custos fixos', () => {
  const stores = [{ id: 'a', name: 'Loja A', cameras: 3, billing_group: 'Dono 1' }, { id: 'b', name: 'Loja B', cameras: 1, billing_group: 'dono 1' }, { id: 'c', name: 'Loja C', cameras: 0 }];
  const usage = [{ subject: 'a', slot_share: 6, requests: 100 }, { subject: 'b', slot_share: 2, requests: 50 }, { subject: 'platform', slot_share: 2, requests: 10 }];
  const storage = { bytes: { a: 300, b: 100, c: 0 }, total: 500 };
  const neon = { available: true, compute_usd: 10, storage_usd: 1, total_usd: 11 };
  const items = [{ name: 'chip', amount: 55, currency: 'BRL', rule: 'per_camera' }, { name: 'domínio', amount: 3, currency: 'USD', rule: 'platform' }];
  const r = allocate({ stores, usage, storage, neon, items, usdBrl: 5.5 });
  const a = r.stores.find(s => s.id === 'a'), b = r.stores.find(s => s.id === 'b'), c = r.stores.find(s => s.id === 'c');
  // Computação: A usou 6 de 10 janelas → 60% de US$ 10; espaço: 300 de 500 bytes → 60% de US$ 1.
  assert.equal(a.neon_usd, 6.6);
  // Plataforma (2 janelas = US$ 2 + 20% do espaço = US$ 0,2) dividida pelo uso direto: A 75%, B 25%.
  assert.equal(a.platform_usd, 1.65); assert.equal(b.platform_usd, 0.55);
  // Chip: R$ 55 = US$ 10, por câmera: A 3/4, B 1/4, C nada.
  assert.equal(a.fixed_usd, 7.5); assert.equal(b.fixed_usd, 2.5); assert.equal(c.fixed_usd, 0);
  // Grupo junta A e B (nome sem diferenciar maiúsculas); C fica sozinha.
  const g = r.groups.find(x => x.grouped);
  assert.equal(g.stores.length, 2); assert.equal(g.total_usd, a.total_usd + b.total_usd);
  // Tudo fecha: banco inteiro + fixos rateados + fixo só da plataforma.
  assert.equal(Math.round(r.totals.allocated_usd * 100), Math.round((11 + 10 + 3) * 100));
  assert.equal(r.platform.fixed_usd, 3);
});

test('custos: uso medido por loja e página da central', { skip, timeout: 60000 }, async () => {
  const f = await createStoreFixture({ env: { USAGE_FLUSH_MS: '1' } });
  try {
    // Uso da loja (lojista logado) e da central (master).
    for (let i = 0; i < 3; i++) await f.api('/orders');
    await f.api('/master/tenants', { token: f.masterToken });
    await new Promise(r => setTimeout(r, 300));
    await f.api('/orders'); // dispara a gravação
    let rows = [];
    for (let i = 0; i < 30 && !rows.length; i++) { await new Promise(r => setTimeout(r, 100)); rows = (await f.db.query('SELECT subject,tenant_id,requests,db_queries FROM tenant_usage_daily')).rows; }
    const store = rows.find(r => r.subject === f.tenant), platform = rows.find(r => r.subject === 'platform');
    assert.ok(store && store.requests >= 3 && store.db_queries >= 3, JSON.stringify(rows));
    assert.equal(store.tenant_id, f.tenant);
    assert.ok(platform && platform.requests >= 1);
    assert.equal(rows.some(r => r.subject === f.foreignTenant), false);

    // Grupo de cobrança e custos fixos.
    await f.api('/master/tenants/' + f.tenant + '/billing-group', { method: 'PATCH', token: f.masterToken, body: { billing_group: 'Dono 1' } });
    await f.api('/master/tenants/' + f.foreignTenant + '/billing-group', { method: 'PATCH', token: f.masterToken, body: { billing_group: 'Dono 1' } });
    await f.api('/master/costs/settings', { method: 'PUT', token: f.masterToken, body: { usd_brl: 5, cost_items: [{ name: 'Ferramenta', amount: 50, currency: 'BRL', rule: 'per_store' }] } });
    const d = await f.api('/master/costs', { token: f.masterToken });
    assert.equal(d.neon.available, false); // sem chave do Neon nos testes
    assert.equal(d.usd_brl, 5);
    const s = d.stores.find(x => x.id === f.tenant);
    assert.ok(s.usage.requests >= 3);
    assert.equal(s.fixed_usd, 5); // R$ 50 = US$ 10 dividido por 2 lojas
    const grp = d.groups.find(g => g.name === 'Dono 1');
    assert.equal(grp.stores.length, 2); assert.equal(grp.total_brl, 50);
    // Só a central vê.
    assert.equal((await f.request('/master/costs')).status, 403);
    await f.api('/master/costs/settings', { method: 'PUT', token: f.masterToken, body: { usd_brl: 5, cost_items: [{ name: 'x', amount: 1, currency: 'EUR', rule: 'per_store' }] } }, 400);
  } finally { await f.cleanup(); }
});
