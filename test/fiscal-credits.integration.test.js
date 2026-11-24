import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';
import { checkFiscalCredits, recordOperation } from '../src/fiscal-credits.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('créditos do emissor: pacote, uso, painel da rede e aviso em 85% e 100%', { skip }, async () => {
  const f = await createStoreFixture(); const realFetch = global.fetch; const sent = [];
  try {
    const { api, request, tenant, masterToken, db } = f;
    const q = db.query.bind(db);
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'aud-cred', hostname: 'aud-cred.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Grand Shopping' } });
    await api(`/master/networks/${net.id}/report-emails`, { method: 'PUT', token: masterToken, body: { emails: ['gestao@audace.test'] } });
    await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'g@aud-cred.test', function: 'dono', password: 'senha-do-gabriel-123' } }, 201);
    const tok = (await request('/auth/login', { method: 'POST', token: null, body: { email: 'g@aud-cred.test', password: 'senha-do-gabriel-123' } })).data.token;

    assert.equal((await api('/network/fiscal-credits', { token: tok })).purchased, 0);
    assert.equal((await request(`/master/networks/${net.id}/fiscal-credits/packages`, { method: 'POST', token: tok, body: { provider: 'ACBr API', operations: 100, purchased_on: '2026-11-24' } })).status, 403);
    let s = await api(`/master/networks/${net.id}/fiscal-credits/packages`, { method: 'POST', token: masterToken, body: { provider: 'ACBr API', operations: 100, price_cents: 24000, purchased_on: '2026-11-24' } }, 201);
    assert.equal(s.purchased, 100); assert.equal(s.used, 0);

    process.env.RESEND_API_KEY = 'test'; process.env.EMAIL_FROM = 'FicouPronto <x@test>';
    global.fetch = async (url, opts) => { if (!String(url).includes('resend')) return realFetch(url, opts); sent.push(JSON.parse(opts.body)); return { ok: true, text: async () => '' }; };
    for (let i = 0; i < 84; i++) await recordOperation(q, { networkId: net.id, tenantId: tenant, kind: 'emissao' });
    assert.deepEqual(await checkFiscalCredits(q), []);
    await recordOperation(q, { networkId: net.id, tenantId: tenant, kind: 'cancelamento' });
    const out = await checkFiscalCredits(q);
    assert.equal(out[0].threshold, 85); assert.equal(sent.length, 1); assert.match(sent[0].subject, /85% dos créditos/); assert.equal(sent[0].to[0], 'gestao@audace.test');
    assert.deepEqual(await checkFiscalCredits(q), [], 'não repete');
    s = await api('/network/fiscal-credits', { token: tok });
    assert.equal(s.used, 85); assert.equal(s.percent, 85); assert.equal(s.remaining, 15); assert.deepEqual(s.by_unit_this_month, [{ unit: 'Grand Shopping', n: 85 }]);
    // Acerto com o painel do emissor (100 usadas) → aviso de 100%.
    s = await api(`/master/networks/${net.id}/fiscal-credits/adjust`, { method: 'POST', token: masterToken, body: { used_total: 100 } });
    assert.equal(s.used, 100);
    assert.equal((await checkFiscalCredits(q))[0].threshold, 100); assert.match(sent[1].subject, /acabaram/);
    // Novo pacote: libera novos avisos e baixa o percentual.
    s = await api(`/master/networks/${net.id}/fiscal-credits/packages`, { method: 'POST', token: masterToken, body: { provider: 'ACBr API', operations: 1000, purchased_on: '2026-11-25' } }, 201);
    assert.equal(s.purchased, 1100); assert.equal(s.percent, 9.1);
    assert.deepEqual(await checkFiscalCredits(q), []);
  } finally { global.fetch = realFetch; delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; await f.cleanup(); }
});
