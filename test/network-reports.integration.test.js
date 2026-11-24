import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';
import { unitTotals, runNetworkReports } from '../src/network-reports.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('relatórios da rede: faturamento do mês por unidade e resumo diário por e-mail', { skip }, async () => {
  const f = await createStoreFixture();
  const sent = [];
  const realFetch = global.fetch;
  try {
    const { tenant, masterToken, api, request } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace-rep', hostname: 'audace-rep.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Maracanaú' } });
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 10000, payment_method: 'pix' } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 3000, payments: [{ method: 'cash', amount_cents: 1000 }, { method: 'credit', amount_cents: 2000 }] } }, 201);
    assert.equal((await request(`/master/networks/${net.id}/report-emails`, { method: 'PUT', token: masterToken, body: { emails: ['nao-e-email'] } })).status, 400);
    await api(`/master/networks/${net.id}/report-emails`, { method: 'PUT', token: masterToken, body: { emails: ['gabriel@audace.test', 'dani@audace.test'] } });
    await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'g@audace-rep.test', function: 'dono', password: 'senha-do-gabriel-123' } }, 201);
    const tok = (await request('/auth/login', { method: 'POST', token: null, body: { email: 'g@audace-rep.test', password: 'senha-do-gabriel-123' } })).data.token;
    const month = (await f.db.query("SELECT to_char(now() AT TIME ZONE 'America/Fortaleza','YYYY-MM') m")).rows[0].m;
    const rep = await api('/network/report/month?month=' + month, { token: tok });
    assert.equal(rep.rows.length, 1); assert.equal(rep.rows[0].sales, 2); assert.equal(rep.rows[0].total_cents, 13000);
    const day = (await f.db.query("SELECT to_char(now() AT TIME ZONE 'America/Fortaleza','YYYY-MM-DD') d")).rows[0].d;
    const tot = await unitTotals(f.db.query.bind(f.db), net.id, day, day);
    assert.deepEqual({ pix: tot[0].by_method.pix, cash: tot[0].by_method.cash, credit: tot[0].by_method.credit }, { pix: 10000, cash: 1000, credit: 2000 });
    // Resumo diário: roda às 8h do dia seguinte e manda para os 2 e-mails, uma vez só.
    process.env.RESEND_API_KEY = 'test'; process.env.EMAIL_FROM = 'FicouPronto <x@test>';
    global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, text: async () => '' }; };
    const tomorrow8 = new Date(new Date(day + 'T08:30:00-03:00').getTime() + 86400000);
    const out = await runNetworkReports(f.db.query.bind(f.db), tomorrow8);
    assert.equal(out.filter(o => o.network === net.id && o.ok).length, 1);
    const mine = sent.filter(m => m.subject.startsWith('Audace Joias'));
    assert.deepEqual(mine.map(m => m.to[0]).sort(), ['dani@audace.test', 'gabriel@audace.test']);
    assert.match(mine[0].html, /Maracanaú/); assert.match(mine[0].html, /R\$ 130,00/);
    await runNetworkReports(f.db.query.bind(f.db), tomorrow8);
    assert.equal(sent.filter(m => m.subject.startsWith('Audace Joias')).length, 2);
    // Dia sem movimento (dois dias depois): não manda e-mail.
    const later = await runNetworkReports(f.db.query.bind(f.db), new Date(tomorrow8.getTime() + 86400000));
    assert.equal(later.find(o => o.network === net.id).skipped, true);
    assert.equal(sent.filter(m => m.subject.startsWith('Audace Joias')).length, 2);
  } finally { global.fetch = realFetch; delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; await f.cleanup(); }
});
