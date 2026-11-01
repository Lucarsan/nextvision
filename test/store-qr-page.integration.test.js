import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Página do QR (/<loja>/oi): o botão "Continuar no WhatsApp" só fica ativo com nome e WhatsApp válidos.
test('página do QR só libera o botão do WhatsApp com nome e telefone preenchidos', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => process.env.SHOT_DIR ? { path: process.env.SHOT_DIR + '/' + name + '.png' } : {};
  try {
    const slug = 'qrp-' + f.tenant.slice(0, 8);
    await f.db.query("UPDATE tenants SET slug=$1, whatsapp='558532130953' WHERE id=$2", [slug, f.tenant]);
    await f.db.query('INSERT INTO tenant_slugs(slug,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [slug, f.tenant]);
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    const opened = [];
    await page.route('https://wa.me/**', route => { opened.push(route.request().url()); route.fulfill({ status: 200, body: 'ok' }); });

    await page.goto(f.base + '/' + slug + '/oi');
    await page.waitForFunction(() => document.getElementById('storeName').textContent === 'Loja de teste');
    const go = page.locator('#go');
    assert.equal(await go.isDisabled(), true, 'vazio: botão travado');
    await page.screenshot(shot('qr-vazio'));
    await go.click({ force: true }); await page.waitForTimeout(300);
    assert.equal(opened.length, 0, 'clicar travado não abre o WhatsApp');

    await page.fill('#name', 'Maria Souza');
    assert.equal(await go.isDisabled(), true, 'só nome: travado');
    assert.match(await page.locator('#hint').innerText(), /WhatsApp/);
    await page.fill('#phone', '9888-7777');
    assert.equal(await go.isDisabled(), true, 'telefone sem DDD: travado');
    await page.fill('#name', '');
    await page.fill('#phone', '(85) 98888-7777');
    assert.equal(await go.isDisabled(), true, 'só telefone: travado');
    await page.fill('#name', '123');
    assert.equal(await go.isDisabled(), true, 'nome sem letras: travado');

    await page.fill('#name', 'Maria Souza');
    assert.equal(await go.isDisabled(), false, 'nome + WhatsApp: liberado');
    assert.equal(await page.locator('#hint').innerText(), '');
    await page.screenshot(shot('qr-liberado'));
    await go.click();
    await page.waitForFunction(() => location.host === 'wa.me', null, { timeout: 10000 });
    assert.equal(opened.length, 1);
    assert.match(opened[0], /^https:\/\/wa\.me\/558532130953\?text=/);

    // Voltando à página, os dados salvos já liberam o botão.
    await page.goto(f.base + '/' + slug + '/oi');
    await page.waitForFunction(() => document.getElementById('storeName').textContent === 'Loja de teste');
    assert.equal(await page.inputValue('#name'), 'Maria Souza');
    assert.equal(await go.isDisabled(), false, 'dados salvos: liberado');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
