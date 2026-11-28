import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Quiosque: desconto por peça (em % ou R$) junto com o desconto da venda. Ex. da consultora:
// brinco R$ 59,00 com desconto, colar R$ 108,00 sem desconto.
const unitLogin = (base, body) => new Promise((resolve, reject) => {
  const u = new URL(base + '/api/auth/unit');
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: 'audace-id.example.test', 'Content-Type': 'application/json' } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(JSON.parse(b || '{}')));
  });
  r.on('error', reject); r.write(JSON.stringify(body)); r.end();
});

test('quiosque: desconto só numa peça, em % e em R$, com o desconto da venda por cima', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const { api, tenant, masterToken, base } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace-id', hostname: 'audace-id.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Messejana' } });
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-messejana' } });
    await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Bia Souza', function: 'vendedora', unit_id: tenant, pin: '4321' } }, 201);
    await f.db.query("INSERT INTO products(tenant_id,name,barcode,code,price_cents,stock_qty) VALUES($1,'Brinco Gota','777','777',5900,3),($1,'Colar Elos','888','888',10800,3)", [tenant]);
    const kt = (await unitLogin(base, { unit_id: tenant, password: 'senha-messejana' })).token; assert.ok(kt);

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
    for (const code of ['777', '888']) {
      await page.fill('#scan', code); await page.press('#scan', 'Enter');
      await page.waitForFunction(n => document.querySelectorAll('#items tr').length === n, code === '777' ? 1 : 2);
    }
    await page.locator('#sellers [data-s]').first().click();
    for (const k of '4321') await page.click(`#keys [data-k="${k}"]`);
    await page.waitForFunction(() => !document.getElementById('pinDlg').open);

    // Brinco: 10% → R$ 53,10; acima de 50% avisa e vale o máximo; em R$ 9,00 → R$ 50,00. O colar fica cheio.
    await page.click('[data-do="0"]');
    await page.type('[data-di="0"]', '10');
    await page.waitForFunction(() => /R\$\s*161,10/.test(document.getElementById('subtotal').textContent));
    await page.fill('[data-di="0"]', '60'); await page.dispatchEvent('[data-di="0"]', 'input');
    await page.waitForFunction(() => /máx\. 50%/.test(document.getElementById('items').textContent));
    await page.click('[data-dm="0"][data-d="brl"]');
    await page.type('[data-di="0"]', '9');
    await page.waitForFunction(() => /R\$\s*158,00/.test(document.getElementById('subtotal').textContent));
    assert.match(await page.textContent('#items'), /R\$\s*59,00\s*R\$\s*50,00/);
    assert.match(await page.textContent('#items'), /R\$\s*108,00/);

    // Desconto da venda (10%) por cima do que sobrou: 158,00 − 15,80 = 142,20.
    await page.fill('#discPct', '10'); await page.dispatchEvent('#discPct', 'input'); await page.dispatchEvent('#discPct', 'change');
    await page.waitForFunction(() => /R\$\s*142,20/.test(document.getElementById('total').textContent));
    await page.click('#pay [data-m="cash"]');
    await page.screenshot(shot('quiosque-desconto-por-peca'));
    await page.click('#finish');
    await page.waitForFunction(() => /registrada/.test(document.getElementById('doneBox').textContent), null, { timeout: 15000 });

    const sale = (await f.db.query('SELECT id,total_cents,discount_cents,receipt_code FROM sales WHERE tenant_id=$1', [tenant])).rows[0];
    assert.equal(sale.total_cents, 14220); assert.equal(sale.discount_cents, 900 + 1580);
    const it = (await f.db.query('SELECT name,unit_price_cents,list_price_cents,quantity,total_cents FROM sale_items WHERE sale_id=$1 ORDER BY position', [sale.id])).rows;
    assert.equal(it[0].unit_price_cents, 5900); assert.equal(it[1].unit_price_cents, 10800);
    assert.equal(it[0].total_cents + it[1].total_cents, 14220);
    assert.ok(it[0].total_cents < 5000 && it[1].total_cents < 10800, 'o desconto da venda é dividido entre as peças');
    const stock = (await f.db.query("SELECT barcode,stock_qty FROM products WHERE tenant_id=$1 ORDER BY barcode", [tenant])).rows.map(x => x.stock_qty);
    assert.deepEqual(stock, [2, 2]);

    // Comprovante: subtotal cheio, desconto somado (peça + venda) e total pago.
    const pub = await (await fetch(base + '/api/public/receipt/' + sale.receipt_code)).json();
    assert.equal(pub.items.reduce((a, i) => a + i.unit_price_cents * i.quantity, 0), 16700); assert.equal(pub.discount_cents, 2480); assert.equal(pub.total_cents, 14220);

    // Servidor confere os limites mesmo sem a tela: peça acima de 50% e soma acima de 50% da venda.
    const seller = (await f.db.query("SELECT id FROM users WHERE tenant_id=$1 AND name='Bia Souza'", [tenant])).rows[0].id;
    const ids = Object.fromEntries((await f.db.query('SELECT barcode,id FROM products WHERE tenant_id=$1', [tenant])).rows.map(x => [x.barcode, x.id]));
    const post = body => page.evaluate(async b => { const r = await fetch('/api/store/sales', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('fp_kiosk_token'), 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; }, body);
    const base2 = { payment_method: 'cash', seller_id: seller, seller_pin: '4321', anonymous: true };
    let r = await post({ ...base2, items: [{ product_id: ids['777'], quantity: 1, discount_cents: 3000 }] });
    assert.equal(r.status, 403); assert.match(r.body.error, /Brinco Gota/);
    r = await post({ ...base2, items: [{ product_id: ids['777'], quantity: 1, discount_cents: 2900 }, { product_id: ids['888'], quantity: 1 }], discount_cents: 5500 });
    assert.equal(r.status, 403); assert.match(r.body.error, /50% da venda/);
    r = await post({ ...base2, items: [{ product_id: ids['777'], quantity: 1, discount_cents: 2900 }, { product_id: ids['888'], quantity: 1 }], discount_cents: 5450 });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.sale?.discount_cents ?? (await f.db.query('SELECT discount_cents FROM sales WHERE tenant_id=$1 ORDER BY sale_number DESC LIMIT 1', [tenant])).rows[0].discount_cents, 8350);
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await f.cleanup(); }
});
