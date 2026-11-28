import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Quiosque: desconto em % na hora do pagamento (até 50%, qualquer forma) e cancelamento só com o PIN da vendedora.
const unitLogin = (base, body) => new Promise((resolve, reject) => {
  const u = new URL(base + '/api/auth/unit');
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: 'audace-dc.example.test', 'Content-Type': 'application/json' } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(JSON.parse(b || '{}')));
  });
  r.on('error', reject); r.write(JSON.stringify(body)); r.end();
});

test('quiosque: desconto em R$, pagamento dividido e comprovante digital completo', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const { api, tenant, masterToken, base } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace-dc', hostname: 'audace-dc.example.test' } }, 201);
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

    // Desconto em R$: acima de 50% vale o máximo e avisa; R$ 20 fica 20.
    await page.click('#discMode [data-d="brl"]');
    await page.fill('#discBrl', '150');
    await page.waitForFunction(() => /Máximo de 50%/.test(document.getElementById('discInfo').textContent));
    await page.fill('#discBrl', '20');
    await page.waitForFunction(() => /R\$\s*190,00/.test(document.getElementById('total').textContent));

    // Dividido: 50 dinheiro + 100 débito + 30 crédito (3x) + 10 dinheiro = 190.
    await page.click('#pay [data-m="split"]');
    await page.waitForSelector('#splitBox:not([hidden]) [data-sv="1"]');
    await page.click('#splitAdd'); await page.click('#splitAdd');
    const setRow = async (i, m, v) => { await page.selectOption(`[data-sm="${i}"]`, m); await page.fill(`[data-sv="${i}"]`, v); await page.dispatchEvent(`[data-sv="${i}"]`, 'change'); };
    await setRow(0, 'cash', '50'); await setRow(1, 'debit', '100'); await setRow(2, 'credit', '30');
    assert.equal(await page.isDisabled('#finish'), true, 'faltando, não finaliza');
    assert.match(await page.textContent('#splitInfo'), /Falta R\$\s*10,00/);
    await page.selectOption('[data-sm="3"]', 'cash'); await page.click('[data-sf="3"]');
    await page.waitForFunction(() => /Fechou/.test(document.getElementById('splitInfo').textContent));
    assert.ok(await page.isVisible('#instRow')); await page.selectOption('#inst', '3');
    await page.screenshot(shot('quiosque-dividido'));
    await page.click('#finish'); await page.click('#rvOk');
    await page.waitForFunction(() => /registrada/.test(document.getElementById('doneBox').textContent), null, { timeout: 15000 });
    const sale = (await f.db.query('SELECT id,total_cents,discount_cents,payment_method,payments,installments,receipt_code FROM sales WHERE tenant_id=$1', [tenant])).rows[0];
    assert.equal(sale.total_cents, 19000); assert.equal(sale.discount_cents, 2000); assert.equal(sale.payment_method, 'mixed'); assert.equal(sale.installments, 3);
    assert.deepEqual(sale.payments.map(p => [p.method, p.amount_cents]).sort(), [['cash', 6000], ['credit', 3000], ['debit', 10000]]);

    // Comprovante digital (link do WhatsApp): desconto, formas e aviso de não fiscal.
    const pub = await (await fetch(base + '/api/public/receipt/' + sale.receipt_code)).json();
    assert.equal(pub.discount_cents, 2000); assert.equal(pub.installments, 3); assert.equal(pub.payments.length, 3);
    const g = await context.newPage(); await g.goto(base + '/g/' + sale.receipt_code);
    await g.waitForFunction(() => /não é documento fiscal/i.test(document.body.innerText));
    const txt = await g.evaluate(() => document.body.innerText);
    assert.match(txt, /Desconto \(10%\)/); assert.match(txt, /Dinheiro R\$\s*60,00/); assert.match(txt, /Crédito R\$\s*30,00 \(3x\)/);
    await g.screenshot({ ...shot('comprovante-digital'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await f.cleanup(); }
});
