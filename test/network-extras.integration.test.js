import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('rede: corrigir venda, crédito de troca em qualquer unidade, estoque mínimo e exportação', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignTenant, masterToken, foreignToken, db } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'aud-ex', hostname: 'aud-ex.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Grand Shopping' } });
    await api(`/master/tenants/${foreignTenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Benfica' } });
    for (const t of [tenant, foreignTenant]) await api('/master/tenants/' + t, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    const people = `/master/networks/${net.id}/people`;
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'g@aud-ex.test', function: 'dono', password: 'senha-do-gabriel-123', pin: '1234' } }, 201);
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Dani', email: 'd@aud-ex.test', function: 'supervisor', unit_ids: [tenant], password: 'senha-da-dani-1234', pin: '5555' } }, 201);
    const ana = await api(people, { method: 'POST', token: masterToken, body: { name: 'Ana', function: 'vendedora', unit_id: tenant, pin: '1111' } }, 201);
    const bia = await api(people, { method: 'POST', token: masterToken, body: { name: 'Bia', function: 'vendedora', unit_id: tenant, pin: '2222' } }, 201);
    const login = async (email, password) => (await request('/auth/login', { method: 'POST', token: null, body: { email, password } })).data.token;
    const dono = await login('g@aud-ex.test', 'senha-do-gabriel-123'), sup = await login('d@aud-ex.test', 'senha-da-dani-1234');
    await api('/network/settings/cashback', { method: 'PUT', token: dono, body: { enabled: true, percent: 10, max_use_percent: 100, valid_days: 90, min_sale_cents: 0 } });

    // Venda sem cliente, com a vendedora errada.
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const s1 = await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 30000, payment_method: 'cash', seller_id: ana.id } }, 201);
    const saleId = s1.id || s1.sale?.id;
    const maria = (await db.query("INSERT INTO customers(tenant_id,name,phone) VALUES($1,'Maria Souza','85988887777') RETURNING id", [foreignTenant])).rows[0];
    assert.equal((await request(`/network/sales/${saleId}/correct`, { method: 'POST', token: sup, body: { seller_id: bia.id } })).status, 400, 'motivo obrigatório');
    let r = await api(`/network/sales/${saleId}/correct`, { method: 'POST', token: sup, body: { seller_id: bia.id, customer_id: maria.id, payment_method: 'pix', reason: 'Vendedora e cliente errados' } });
    assert.equal(r.seller, 'Bia'); assert.equal(r.payment_method, 'pix'); assert.equal(r.cashback_earned_cents, 3000);
    const sale = (await db.query('SELECT seller_id, payment_method, customer_id, cashback_earned_cents FROM sales WHERE id=$1', [saleId])).rows[0];
    assert.equal(sale.seller_id, bia.id); assert.equal(sale.payment_method, 'pix');
    const local = (await db.query('SELECT tenant_id, link_id FROM customers WHERE id=$1', [sale.customer_id])).rows[0];
    assert.equal(local.tenant_id, tenant, 'ficha local criada'); assert.ok(local.link_id, 'ligada à ficha da outra unidade');
    assert.equal((await db.query('SELECT count(*)::int n FROM sale_corrections WHERE sale_id=$1', [saleId])).rows[0].n, 3);
    // Supervisor não corrige venda fora das unidades dele.
    const s2 = await api('/store/sales', { method: 'POST', token: foreignToken, body: { anonymous: true, total_cents: 1000, payment_method: 'cash' } }, 201).catch(async () => { await api('/store/cash/open', { method: 'POST', token: foreignToken, body: { opening_cents: 0 } }, 201); return api('/store/sales', { method: 'POST', token: foreignToken, body: { anonymous: true, total_cents: 1000, payment_method: 'cash' } }, 201); });
    assert.equal((await request(`/network/sales/${s2.id || s2.sale?.id}/correct`, { method: 'POST', token: sup, body: { payment_method: 'pix', reason: 'teste fora' } })).status, 404);

    // Troca com crédito (fora do quiosque: o próprio usuário gera; no quiosque, a vendedora com o PIN — ver exchange-credit).
    const code = (await db.query('SELECT receipt_code FROM sales WHERE id=$1', [saleId])).rows[0].receipt_code;
    const claim = await api(`/store/warranty/${code}/claims`, { method: 'POST', body: { kind: 'troca', note: 'banho escureceu' } }, 201);
    assert.equal((await request(`/store/warranty/claims/${claim.id}/credit`, { method: 'POST', body: { amount_cents: 99999 } })).status, 400);
    r = await api(`/store/warranty/claims/${claim.id}/credit`, { method: 'POST', body: { amount_cents: 30000 } }, 201);
    assert.equal(r.valid_days, 180);
    assert.equal((await request(`/store/warranty/claims/${claim.id}/credit`, { method: 'POST', body: { amount_cents: 100, supervisor_pin: '5555' } })).status, 409);
    const bal = (await db.query(`SELECT sum(l.remaining_cents)::int n FROM cashback_lots l JOIN customers g ON g.id=l.customer_id WHERE coalesce(g.link_id,g.id)=$1 AND l.reversed_at IS NULL`, [local.link_id])).rows[0].n;
    assert.equal(bal, 33000, 'cashback 30,00 + crédito 300,00');
    const kinds = (await db.query(`SELECT l.kind, sum(l.remaining_cents)::int n FROM cashback_lots l JOIN customers g ON g.id=l.customer_id WHERE coalesce(g.link_id,g.id)=$1 AND l.reversed_at IS NULL GROUP BY 1 ORDER BY 1`, [local.link_id])).rows;
    assert.deepEqual(kinds.map(k => [k.kind, k.n]), [['cashback', 3000], ['credit', 30000]], 'saldos separados');
    const w = await api(`/store/warranty/${code}`);
    assert.equal(w.claims[0].credit_cents, 30000); assert.equal(w.claims[0].mine, true); assert.equal(w.has_customer, true);

    // Estoque mínimo da rede.
    await api('/network/settings/stock', { method: 'PUT', token: sup, body: { low_stock_min: 3, credit_valid_days: 120 } });
    assert.deepEqual((await db.query('SELECT low_stock_min, credit_valid_days FROM store_networks WHERE id=$1', [net.id])).rows[0], { low_stock_min: 3, credit_valid_days: 120 });

    // Exportação: dono sim, supervisor não; central também.
    const ex = await fetch(f.base + '/api/network/export/vendas', { headers: { Authorization: 'Bearer ' + dono } });
    assert.equal(ex.status, 200); const txt = await ex.text();
    assert.match(txt, /Grand Shopping/); assert.match(txt, /Maria Souza/); assert.match(txt, /300,00/);
    assert.equal((await fetch(f.base + '/api/network/export/clientes', { headers: { Authorization: 'Bearer ' + sup } })).status, 403);
    const ce = await fetch(f.base + `/api/master/networks/${net.id}/export/clientes`, { headers: { Authorization: 'Bearer ' + masterToken } });
    assert.equal(ce.status, 200); assert.match(await ce.text(), /Maria Souza/);
  } finally { await f.cleanup(); }
});
