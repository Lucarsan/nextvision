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

test('quiosque: desconto de 40% no crédito e cancelamento com o PIN da vendedora', {
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
    await f.db.query("INSERT INTO products(tenant_id,name,barcode,code,price_cents,stock_qty) VALUES($1,'Brinco Gota','003622','003622',10000,3)", [tenant]);
    const kt = (await unitLogin(base, { unit_id: tenant, password: 'senha-cascavel' })).token; assert.ok(kt);

    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(v => localStorage.setItem('fp_kiosk_token', v), kt);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.type() === 'prompt' ? d.accept('Cliente desistiu') : d.accept());
    await page.goto(base + '/caixa');
    await page.waitForSelector('#closedBox:not([hidden])');
    await page.fill('#openCash', '0'); await page.click('#openBtn');
    await page.locator('#openWho [data-w]').first().click();
    await page.waitForSelector('#pinDlg[open]');
    for (const k of '4321') await page.click(`#keys [data-k="${k}"]`);
    await page.waitForSelector('#topClose:not([hidden])');

    await page.fill('#scan', '003622'); await page.press('#scan', 'Enter');
    await page.waitForFunction(() => !/Nenhuma/.test(document.getElementById('itemsInfo').textContent));
    await page.locator('#sellers [data-s]').first().click();
    for (const k of '4321') await page.click(`#keys [data-k="${k}"]`);
    await page.waitForFunction(() => !document.getElementById('pinDlg').open);
    await page.click('#pay [data-m="credit"]');
    assert.ok(await page.isVisible('#discRow'));
    await page.click('#discQuick [data-p="25"]');
    await page.waitForFunction(() => /R\$\s*25,00/.test(document.getElementById('discInfo').textContent));
    await page.click('#discQuick [data-p="40"]');
    await page.waitForFunction(() => /R\$\s*40,00/.test(document.getElementById('discInfo').textContent));
    await page.fill('#discPct', '60');
    await page.waitForFunction(() => document.getElementById('discPct').value === '50');
    await page.click('#discQuick [data-p="40"]');
    // Parcelas no crédito aparecem mesmo sem o pinpad (maquininha avulsa) e ficam na venda.
    assert.ok(await page.isVisible('#instRow'));
    await page.selectOption('#inst', '3');
    await page.screenshot(shot('quiosque-desconto'));
    // Sem anônimo? escolhe "sem cadastro" se houver; senão a venda segue como a tela pedir.
    const anon = page.locator('#anonBtn, [data-anon]'); if (await anon.count()) await anon.first().click();
    await page.click('#finish');
    await page.waitForFunction(() => !document.getElementById('doneBox')?.hidden || /Venda/.test(document.getElementById('saleMsg').textContent), null, { timeout: 15000 });
    const sale = (await f.db.query('SELECT id,total_cents,discount_cents,payment_method,installments FROM sales WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1', [tenant])).rows[0];
    assert.deepEqual([sale.total_cents, sale.discount_cents, sale.payment_method, sale.installments], [6000, 4000, 'credit', 3]);
    // Comprovante impresso (não fiscal): botão na venda concluída.
    await page.click('#printRc');
    await page.waitForFunction(() => /NÃO É DOCUMENTO FISCAL/.test(window.FPLastReceipt || ''));
    const rc = await page.evaluate(() => window.FPLastReceipt);
    assert.match(rc, /Venda nº 1/); assert.match(rc, /Desconto \(40%\)/); assert.match(rc, /Crédito 3x de R\$\s*20,00/); assert.match(rc, /Brinco Gota/); assert.match(rc, /data:image\/png;base64/);
    const pr = await page.context().newPage(); await pr.setContent(rc); await pr.screenshot({ ...shot('comprovante-impresso'), fullPage: true }); await pr.close();

    // Cancelar: só o PIN da Bia.
    await page.click('[data-view="sales"]');
    await page.waitForSelector('#tSales [data-cx]');
    await page.click('#tSales [data-cx]');
    await page.waitForSelector('#pinDlg[open]');
    assert.match(await page.textContent('#pinTitle'), /Bia/);
    for (const k of '4321') await page.click(`#keys [data-k="${k}"]`);
    await page.waitForSelector('#tSales tr.canceled');
    await page.screenshot(shot('quiosque-cancelada'));
    const c = (await f.db.query('SELECT s.canceled_at, u.name FROM sales s JOIN users u ON u.id = s.canceled_by WHERE s.id=$1', [sale.id])).rows[0];
    assert.ok(c.canceled_at); assert.equal(c.name, 'Bia Souza');
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await f.cleanup(); }
});
