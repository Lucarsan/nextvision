import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Clicar no nome (ou na foto) do cliente em qualquer parte do painel abre o histórico dele, numa janela por cima.
test('painel: nome do cliente abre o histórico (status do dia, caixa, venda, clientes, pedidos)', {
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
    const { api } = f;
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const sale = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Dorys Lima', phone: '85996762945' }, total_cents: 2500, payment_method: 'pix' } }, 201);
    const dorys = sale.customer.id;
    const proc = await api('/processes', { method: 'POST', body: { name: 'Conserto', steps: ['Análise', 'Reparo'] } }, 201);
    await api('/orders', { method: 'POST', body: { customer_id: dorys, process_id: proc.id, external_reference: '777' } }, 201);

    const openedFor = async (click, where) => {
      await click();
      await page.waitForSelector('#chDialog[open] #chTitle', { timeout: 10000 }).catch(() => { throw Error('histórico não abriu: ' + where); });
      await page.waitForFunction(() => document.getElementById('chTitle').textContent === 'Dorys Lima');
      await page.screenshot(shot('hist-' + where.replace(/\W+/g, '-')));
      await page.mouse.click(8, 8);
      await page.waitForFunction(() => !document.getElementById('chDialog').open);
    };
    await page.goto(f.base + '/loja.html');
    await page.waitForSelector('.nv-menu [data-view="messages"]');

    // Mensagens → Status do dia.
    await page.locator('.nv-menu [data-view="messages"]').click();
    await page.waitForSelector('[data-fs-row] [data-customer-history]');
    await openedFor(() => page.locator('[data-fs-row] [data-customer-history]').first().click(), 'status do dia');

    // Caixa: lista de vendas.
    await page.locator('.nv-menu [data-view="cash"]').click();
    await page.waitForSelector('.fs-sale [data-customer-history]');
    await openedFor(() => page.locator('.fs-sale [data-customer-history]').first().click(), 'caixa');

    // Clientes: nome e foto.
    await page.locator('.nv-menu [data-view="customers"]').click();
    await page.waitForSelector('.nv-customer-row');
    await openedFor(() => page.locator('.nv-customer-row [data-customer-history]').first().click(), 'clientes foto');
    await openedFor(() => page.locator('.nv-customer-row [data-history-customer]').first().click(), 'clientes nome');

    // Pedidos e visão geral (fila).
    await page.locator('.nv-menu [data-view="orders"]').click();
    await page.waitForSelector('#sectionContent [data-customer-history]');
    await openedFor(() => page.locator('#sectionContent [data-customer-history]').first().click(), 'pedidos');
    await page.locator('.nv-menu [data-view="home"]').click();
    await page.waitForSelector('#dashboardContent [data-customer-history]');
    await openedFor(() => page.locator('#dashboardContent [data-customer-history]').first().click(), 'visao geral');

    // Por cima de uma janela aberta: a de baixo continua lá.
    await page.locator('.nv-menu [data-view="cash"]').click();
    await page.waitForSelector('.fs-sale [data-customer-history]');
    await page.evaluate(() => { const d = document.getElementById('editorDialog'); d.innerHTML = '<p id="below">janela de baixo <span class="fp-cust-link" role="button" tabindex="0" data-customer-history="' + document.querySelector('.fs-sale [data-customer-history]').dataset.customerHistory + '">Dorys</span></p>'; d.showModal(); });
    await page.locator('#below [data-customer-history]').click();
    await page.waitForSelector('#chDialog[open] #chTitle');
    assert.equal(await page.locator('#editorDialog').evaluate(d => d.open && !!d.querySelector('#below')), true, 'janela de baixo preservada');
    await page.locator('#chDialog [data-ch-close]').click();
    await page.waitForFunction(() => !document.getElementById('chDialog').open && document.getElementById('editorDialog').open);

    // Teclado: Enter no nome também abre.
    await page.locator('#below [data-customer-history]').focus(); await page.keyboard.press('Enter');
    await page.waitForSelector('#chDialog[open] #chTitle');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
