import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Quiosque: venda dividida em dois cartões de crédito com parcelas diferentes (ex. da Audace: um em 2x, outro em 4x).
const unitLogin = (base, body) => new Promise((resolve, reject) => {
  const u = new URL(base + '/api/auth/unit');
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: 'audace-pc.example.test', 'Content-Type': 'application/json' } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(JSON.parse(b || '{}')));
  });
  r.on('error', reject); r.write(JSON.stringify(body)); r.end();
});

test('quiosque: dois cartões de crédito com parcelas diferentes (2x e 4x) + débito', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const { api, tenant, masterToken, base } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace-pc', hostname: 'audace-pc.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Cascavel' } });
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-cascavel' } });
    await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Bia Souza', function: 'vendedora', unit_id: tenant, pin: '4321' } }, 201);
    await f.db.query("INSERT INTO products(tenant_id,name,barcode,code,price_cents,stock_qty) VALUES($1,'Colar Elos','777','777',21000,3)", [tenant]);
    const kt = (await unitLogin(base, { unit_id: tenant, password: 'senha-cascavel' })).token; assert.ok(kt);

    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.addInitScript(v => localStorage.setItem('fp_kiosk_token', v), kt);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(base + '/caixa');
    await page.waitForSelector('#closedBox:not([hidden])');
    await page.fill('#openCash', '0'); await page.click('#openBtn');
    await page.locator('#openWho [data-w]').first().click();
    await page.waitForSelector('#pinDlg[open]');
    for (const k of '4321') await page.click(`#keys [data-k="${k}"]`);
    await page.waitForSelector('#topClose:not([hidden])');
    await page.fill('#scan', '777'); await page.press('#scan', 'Enter');
    await page.waitForFunction(() => !/Nenhuma/.test(document.getElementById('itemsInfo').textContent));
    await page.locator('#sellers [data-s]').first().click();
    for (const k of '4321') await page.click(`#keys [data-k="${k}"]`);
    await page.waitForFunction(() => !document.getElementById('pinDlg').open);

    // R$ 210: cartão 1 R$ 100 em 2x, cartão 2 R$ 80 em 4x, débito R$ 30.
    await page.click('#pay [data-m="split"]');
    await page.waitForSelector('#splitBox:not([hidden]) [data-sv="1"]');
    await page.click('#splitAdd');
    const setRow = async (i, m, v) => { await page.selectOption(`[data-sm="${i}"]`, m); await page.fill(`[data-sv="${i}"]`, v); await page.dispatchEvent(`[data-sv="${i}"]`, 'change'); };
    await setRow(0, 'credit', '100'); await page.selectOption('[data-si="0"]', '2');
    await setRow(1, 'credit', '80'); await page.selectOption('[data-si="1"]', '4');
    await setRow(2, 'debit', '30');
    assert.equal(await page.locator('[data-si]').count(), 2, 'parcelas só nas linhas de crédito');
    assert.ok(await page.isHidden('#instRow'));
    await page.waitForFunction(() => /Fechou/.test(document.getElementById('splitInfo').textContent));
    await page.screenshot(shot('quiosque-dois-cartoes'));
    await page.click('#finish');
    await page.waitForSelector('#rvDlg[open]');
    const rv = await page.textContent('#rvBody');
    assert.match(rv, /Crédito R\$\s*100,00 em 2x de R\$\s*50,00/); assert.match(rv, /Crédito R\$\s*80,00 em 4x de R\$\s*20,00/); assert.match(rv, /Débito R\$\s*30,00/);
    await page.screenshot(shot('quiosque-dois-cartoes-conferencia'));
    await page.click('#rvOk');
    await page.waitForFunction(() => /registrada/.test(document.getElementById('doneBox').textContent), null, { timeout: 15000 });
    const sale = (await f.db.query('SELECT id,total_cents,payment_method,payments,installments,receipt_code FROM sales WHERE tenant_id=$1', [tenant])).rows[0];
    assert.equal(sale.total_cents, 21000); assert.equal(sale.payment_method, 'mixed'); assert.equal(sale.installments, 4);
    assert.deepEqual(sale.payments, [{ method: 'debit', amount_cents: 3000 }, { method: 'credit', amount_cents: 10000, installments: 2 }, { method: 'credit', amount_cents: 8000, installments: 4 }]);

    // Comprovante digital: cada cartão com as suas parcelas.
    const g = await context.newPage(); await g.goto(base + '/g/' + sale.receipt_code);
    await g.waitForFunction(() => /não é documento fiscal/i.test(document.body.innerText));
    const txt = await g.evaluate(() => document.body.innerText);
    assert.match(txt, /Crédito R\$\s*100,00 \(2x\)/); assert.match(txt, /Crédito R\$\s*80,00 \(4x\)/); assert.match(txt, /Débito R\$\s*30,00/);

    // Servidor: só o crédito repete; parcelas só no crédito.
    const seller = (await f.db.query("SELECT id FROM users WHERE tenant_id=$1 AND name='Bia Souza'", [tenant])).rows[0].id;
    const pid = (await f.db.query('SELECT id FROM products WHERE tenant_id=$1', [tenant])).rows[0].id;
    const post = b => page.evaluate(async b => { const r = await fetch('/api/store/sales', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('fp_kiosk_token'), 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; }, b);
    const b0 = { items: [{ product_id: pid, quantity: 1 }], seller_id: seller, seller_pin: '4321', anonymous: true, offline_payment: true };
    let r = await post({ ...b0, payments: [{ method: 'debit', amount_cents: 10000 }, { method: 'debit', amount_cents: 11000 }] });
    assert.equal(r.status, 400); assert.match(r.body.error, /só o crédito pode repetir/);
    r = await post({ ...b0, payments: [{ method: 'debit', amount_cents: 10000, installments: 2 }, { method: 'credit', amount_cents: 11000 }] });
    assert.equal(r.status, 400); assert.match(r.body.error, /Parcelamento só no crédito/);
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await f.cleanup(); }
});
