import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import { once } from 'node:events';
import { createStoreFixture } from './helpers/store-fixture.js';

// Central → Cobranças: cadastra quem paga, monta a implantação em 3x e a mensalidade; o dono vê o aviso
// no painel; bloqueada, a tela de entrada mostra o link para pagar.
const iso = (offset = 0) => new Date(Date.now() - 3 * 3600000 + offset * 86400000).toISOString().slice(0, 10);

test('central cobra pelo Asaas e o dono vê o aviso e o link', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const payments = new Map(); let n = 0;
  const fake = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c; const d = body ? JSON.parse(body) : {};
    const send = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/v3/, ''); let m;
    if (req.method === 'POST' && path === '/customers') return send({ id: 'cus_1', ...d });
    if (req.method === 'PUT' && path.startsWith('/customers/')) return send({});
    if (req.method === 'POST' && path === '/payments') { const p = { id: 'pay_' + (++n), customer: d.customer, value: d.value, dueDate: d.dueDate, description: d.description, status: 'PENDING', invoiceUrl: 'https://www.asaas.com/i/' + n }; payments.set(p.id, p); return send(p); }
    if (req.method === 'POST' && path === '/subscriptions') { const id = 'sub_' + (++n); const p = { id: 'pay_' + (++n), customer: d.customer, subscription: id, value: d.value, dueDate: d.nextDueDate, description: d.description, status: 'PENDING', invoiceUrl: 'https://www.asaas.com/i/' + n }; payments.set(p.id, p); return send({ id }); }
    if (req.method === 'GET' && path === '/payments') return send({ data: [...payments.values()], hasMore: false });
    if (req.method === 'GET' && (m = /^\/payments\/(.+)$/.exec(path))) return send(payments.get(m[1]));
    if (req.method === 'GET' && path === '/webhooks') return send({ data: [] });
    res.writeHead(404); res.end('{}');
  });
  fake.listen(0, '127.0.0.1'); await once(fake, 'listening');
  const f = await createStoreFixture({ env: { ASAAS_API_KEY: '$aact_hmlg_x', ASAAS_API_URL: 'http://127.0.0.1:' + fake.address().port + '/v3', BILLING_SYNC: 'off' } });
  let browser;
  const shot = name => process.env.SHOT_DIR ? { path: process.env.SHOT_DIR + '/' + name + '.png', fullPage: true } : {};
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const { masterToken, ownerToken, base, db, tenant } = f;
    const central = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await central.addInitScript(v => sessionStorage.setItem('nv_token', v), masterToken);
    const cp = await central.newPage(); const errors = []; cp.on('pageerror', e => errors.push(e.message));
    cp.on('dialog', d => d.accept());
    await cp.goto(base + '/central.html');
    await cp.getByRole('button', { name: 'Cobranças' }).click();
    await cp.waitForSelector('.blOpen');
    await cp.screenshot(shot('cobrancas-lista'));
    await cp.click(`.blOpen[data-tenant="${tenant}"]`);
    await cp.fill('#bDoc', '529.982.247-25'); await cp.fill('#bEmail', 'dono@loja.test'); await cp.fill('#bGrace', '5');
    await cp.click('#bSave');
    await cp.waitForSelector('#cSplit');
    // Implantação R$ 2.500 em 3x: 833,34 + 833,33 + 833,33.
    await cp.fill('#cTotal', '2.500,00'); await cp.fill('#cN', '3'); await cp.click('#cSplit');
    assert.deepEqual(await cp.$$eval('.cV', xs => xs.map(x => x.value)), ['833,34', '833,33', '833,33']);
    await cp.locator('.cD').nth(1).fill(iso(26));
    await cp.click('#cCreate');
    await cp.waitForFunction(() => document.querySelectorAll('.cDel').length === 3);
    await cp.fill('#sValue', '1.750,00'); await cp.fill('#sFirst', iso(26)); await cp.click('#sCreate');
    await cp.waitForSelector('#sCancel');
    await cp.screenshot(shot('cobrancas-conta'));
    assert.deepEqual(errors, []);
    const rows = (await db.query("SELECT kind,value_cents FROM billing_charges ORDER BY created_at, value_cents DESC")).rows;
    assert.deepEqual(rows.map(r => r.kind + ':' + r.value_cents).sort(), ['monthly:175000', 'setup:83333', 'setup:83333', 'setup:83334']);

    // Dono: aviso da parcela que vence hoje, com o botão de pagar.
    const store = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    await store.addInitScript(v => sessionStorage.setItem('nv_token', v), ownerToken);
    const sp = await store.newPage(); sp.on('pageerror', e => errors.push(e.message));
    await sp.goto(base + '/loja.html');
    await sp.waitForSelector('.fp-billing-banner');
    assert.match(await sp.textContent('.fp-billing-banner'), /vence hoje/);
    assert.equal(await sp.getAttribute('.fp-billing-banner a', 'href'), 'https://www.asaas.com/i/1');
    await sp.screenshot(shot('loja-aviso'));

    // Bloqueada: o painel mostra o link para pagar.
    await db.query("UPDATE billing_charges SET due_date=$1,status='OVERDUE' WHERE value_cents=83334", [iso(-9)]);
    const pay = [...payments.values()].find(p => p.value === 833.34); Object.assign(pay, { dueDate: iso(-9), status: 'OVERDUE' });
    const r = await fetch(base + '/api/master/billing/sync', { method: 'POST', headers: { Authorization: 'Bearer ' + masterToken } });
    assert.deepEqual((await r.json()).changes.map(c => c.action), ['blocked']);
    await sp.reload();
    await sp.waitForFunction(() => /pagamento em atraso/.test(document.querySelector('.fp-billing-banner')?.textContent || ''));
    await sp.screenshot(shot('loja-bloqueada'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); fake.close(); }
});
