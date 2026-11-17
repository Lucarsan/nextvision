import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// ELITECH 17/11: com "Abrir pedido ao vivo" lembrado no computador, cada venda de impressão abria um pedido.
test('caixa: venda só de produtos não abre pedido; fora do pet shop a caixinha começa desmarcada', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await context.addInitScript(value => { sessionStorage.setItem('nv_token', value); localStorage.setItem('fp_sale_live_order', JSON.stringify({ on: true })); }, f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'electronics' } });
    await f.api('/processes', { method: 'POST', body: { name: 'Assistência', steps: ['Recebido', 'Pronto'] } }, 201);
    await f.api('/customers', { method: 'POST', body: { name: 'Afonso Filho', phone: '85997106788' } }, 201);
    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsLiveOn');
    assert.equal(await page.locator('#fsLiveOn').isChecked(), false, 'não vem marcada do dia anterior');
    // Mesmo marcando, venda de produto (impressão) não abre pedido.
    await page.locator('#fsSearch').fill('afonso');
    await page.locator('[data-fs-pick]').first().click();
    await page.locator('#fsSale [name=total]').fill('2,00');
    await page.locator('#fsLiveOn').check();
    await page.locator('#fsSaleBtn').click();
    await page.waitForSelector('.fs-last');
    assert.equal((await f.db.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [f.tenant])).rows[0].n, 0);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM sales WHERE tenant_id=$1', [f.tenant])).rows[0].n, 1);
    assert.equal(await page.locator('#fsLiveOn').isChecked(), false, 'depois da venda volta desmarcada');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
