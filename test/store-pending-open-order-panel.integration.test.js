import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Venda guardada em "A receber" sem pedido ao vivo: o botão "Abrir pedido" cria os pedidos (um por pet),
// eles aparecem na Visão geral com "Iniciar", e a lista de pedidos não fica com "Carregando pedidos…".
test('a receber: abrir pedido depois e iniciar pela visão geral', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'pet' } });
    await f.api('/processes', { method: 'POST', body: { name: 'Serviço Completo', steps: ['Área de Espera', 'Banho', 'Pronto'] } }, 201);
    const cli = await f.api('/customers', { method: 'POST', body: { name: 'Mayara Basilio', phone: '85997100000' } }, 201);
    const done = await f.api('/customers', { method: 'POST', body: { name: 'Cliente Antigo', phone: '85997100001' } }, 201);
    await f.api('/store/sales/pending', { method: 'POST', body: { customer_id: done.id, total_cents: 1000, description: 'só para ter algo' } }, 201);
    await f.api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, items: [
      { service: 'Banho de cheiro', unit_price_cents: 4300, device_model: 'MARVIM' }, { service: 'Banho de cheiro', unit_price_cents: 4300, device_model: 'MEG' }] } }, 201);

    await page.goto(f.base + '/loja.html');
    await page.waitForFunction(() => /Nenhum pedido|pedidos/.test(document.querySelector('#ordersList')?.innerText || ''));
    assert.doesNotMatch(await page.locator('#ordersList').innerText(), /Carregando/);
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('[data-pend-open]');
    assert.equal(await page.locator('[data-pend-open]').count(), 2);
    await page.locator('.fs-pend', { hasText: 'Mayara' }).locator('[data-pend-open]').click();
    await page.waitForFunction(() => /Pedidos \d+ \(MARVIM\) e \d+ \(MEG\) abertos/.test(document.body.innerText));
    await page.waitForFunction(() => document.querySelectorAll('[data-pend-open]').length === 1);
    assert.match(await page.locator('.fs-pend', { hasText: 'Mayara' }).innerText(), /na fila/);
    await page.screenshot(shot('a-receber-abrir-pedido'));

    await page.locator('.nv-sidebar [data-view="dashboard"], .nv-sidebar [data-view="home"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#ordersList [data-order-id]').length === 2);
    const txt = await page.locator('#ordersList').innerText();
    assert.match(txt, /MARVIM/); assert.match(txt, /MEG/); assert.doesNotMatch(txt, /Carregando/);
    assert.ok(await page.locator('#ordersList [data-order-id]').first().getByRole('button', { name: /Iniciar/ }).count(), 'pedido tem botão de iniciar');
    await page.screenshot(shot('visao-geral-pedidos'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
