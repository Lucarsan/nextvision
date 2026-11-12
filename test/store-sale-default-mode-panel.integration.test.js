import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Pet shop: o caixa abre em "Serviço" (botão primeiro); "Produto" só quando a atendente toca.
// Depois de registrar a venda, a próxima volta para Serviço. Outras lojas continuam em Produto.
test('caixa do pet shop começa em Serviço e volta para Serviço após a venda', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    const pressed = async () => page.locator('[data-fs-mode][aria-pressed="true"]').getAttribute('data-fs-mode');

    // Loja que não é pet: continua em Produto.
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');
    assert.equal(await pressed(), 'product');

    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { niche: 'pet' } });
    await page.reload(); await page.locator('.nv-sidebar [data-view="cash"]').click(); await page.waitForSelector('#fsSale');
    assert.equal(await pressed(), 'service', 'pet shop abre em Serviço');
    assert.equal(await page.locator('[data-fs-mode]').first().getAttribute('data-fs-mode'), 'service', 'Serviço vem primeiro');
    assert.equal(await page.locator('#fsSale [name="total"]').isVisible(), false);

    // Escolhe Produto, registra uma venda avulsa: a próxima volta para Serviço.
    await page.locator('[data-fs-mode="product"]').click();
    assert.equal(await pressed(), 'product');
    await page.locator('#fsSale [name="total"]').fill('10');
    await page.getByRole('button', { name: 'Não quis se identificar' }).click();
    await page.getByRole('button', { name: 'Registrar venda' }).click();
    await page.waitForFunction(() => /Venda #1 registrada/.test(document.body.innerText));
    await page.waitForSelector('[data-fs-mode="service"][aria-pressed="true"]');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
