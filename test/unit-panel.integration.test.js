import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('painel da loja: dia da unidade, por vendedora e forma, e supervisor confere o fechamento', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignTenant, masterToken, db } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'aud-up', hostname: 'aud-up.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Grand Shopping' } });
    await api(`/master/tenants/${foreignTenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Benfica' } });
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Dani', email: 'dani@aud-up.test', function: 'supervisor', unit_ids: [tenant], password: 'senha-da-dani-123', pin: '5555' } }, 201);
    const sup = (await request('/auth/login', { method: 'POST', token: null, body: { email: 'dani@aud-up.test', password: 'senha-da-dani-123' } })).data.token;

    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 5000 } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 10000, payment_method: 'pix' } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 3000, payments: [{ method: 'cash', amount_cents: 1000 }, { method: 'credit', amount_cents: 2000 }] } }, 201);
    let d = await api(`/network/units/${tenant}/day`, { token: sup });
    assert.equal(d.unit.name, 'Grand Shopping'); assert.equal(d.kpis.total_cents, 13000); assert.equal(d.kpis.count, 2); assert.equal(d.kpis.ticket_cents, 6500);
    assert.deepEqual({ pix: d.by_method.pix, cash: d.by_method.cash, credit: d.by_method.credit }, { pix: 10000, cash: 1000, credit: 2000 });
    assert.equal(d.sales.length, 2); assert.ok(d.sales[0].at.match(/^\d\d:\d\d$/)); assert.equal(d.sessions[0].status, 'open');
    // Supervisor não vê unidade fora da supervisão.
    assert.equal((await request(`/network/units/${foreignTenant}/day`, { token: sup })).status, 404);
    // Fecha com R$ 1,00 a menos e o supervisor confere.
    const sid = d.sessions[0].id;
    assert.equal((await request(`/network/cash-sessions/${sid}/review`, { method: 'POST', token: sup, body: {} })).status, 409);
    await db.query("UPDATE cash_sessions SET status='closed', closed_at=now(), closed_by=opened_by, expected_cash_cents=6000, counted_cash_cents=5900 WHERE id=$1", [sid]);
    d = await api(`/network/units/${tenant}/day`, { token: sup });
    assert.equal(d.pending.unreviewed, 1); assert.equal(d.sessions[0].counted_cash_cents - d.sessions[0].expected_cash_cents, -100);
    await api(`/network/cash-sessions/${sid}/review`, { method: 'POST', token: sup, body: { note: 'Diferença de troco, ok' } });
    d = await api(`/network/units/${tenant}/day`, { token: sup });
    assert.equal(d.pending.unreviewed, 0); assert.equal(d.sessions[0].reviewed_by, 'Dani'); assert.equal(d.sessions[0].review_note, 'Diferença de troco, ok');
    assert.equal((await request(`/network/cash-sessions/${sid}/review`, { method: 'POST', token: sup, body: {} })).status, 409);
  } finally { await f.cleanup(); }
});
