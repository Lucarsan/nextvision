import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Menu "Serviços e preços": a lista de serviços cadastrados sem precisar abrir o caixa (pedido da Alê Pet's).
test('menu Serviços e preços lista, edita, cadastra e exclui serviços', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'pet' } });
    await f.api('/store/sales/service-items', { method: 'POST', body: { name: 'Banho teste', price_cents: 5000 } }, 201);

    await page.goto(f.base + '/loja.html');
    const menu = page.locator('.nv-sidebar [data-view="svcprices"]');
    await menu.waitFor();
    assert.match(await menu.innerText(), /Serviços e preços/);
    await menu.click();
    await page.waitForSelector('#fsSvcPage #fsSvcList');
    assert.equal(await page.locator('.nv-top h1').innerText(), 'Serviços e preços');
    assert.equal(await page.locator('#editorDialog[open]').count(), 0, 'abre na página, não em janela');
    assert.match(await page.locator('#fsSvcList').innerText(), /Banho teste[\s\S]*50,00/);
    assert.equal(await page.locator('#fsSvcPage [data-close-dialog]').count(), 0, 'sem botão de fechar janela');
    assert.match(await page.locator('#fsSvcList .fs-sale', { hasText: 'Banho teste' }).innerText(), /sem custo/);

    // Editar: preço e porte; continua na página.
    await page.locator('#fsSvcList .fs-sale', { hasText: 'Banho teste' }).locator('[data-svc-edit]').click();
    await page.locator('#fsSvcCancelEdit').waitFor();
    await page.locator('#fsSvcForm [name="price"]').fill('55,00');
    await page.locator('#fsSvcForm [name="cost"]').fill('12,00');
    await page.locator('#fsSvcForm details.fs-vars summary').click().catch(() => {});
    await page.locator('#fsSvcForm [data-size="Grande"]').fill('20,00');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await page.waitForFunction(() => /salvo/.test(document.querySelector('#fsSvcStatus')?.textContent || ''));
    assert.match(await page.locator('#fsSvcList').innerText(), /Banho teste[\s\S]*55,00 · custo R\$\s12,00/);
    assert.equal(await page.locator('#editorDialog[open]').count(), 0);

    // Cadastrar novo.
    await page.locator('#fsSvcForm [name="name"]').fill('Hidratação teste');
    await page.locator('#fsSvcForm [name="price"]').fill('25,00');
    await page.locator('#fsSvcForm [name="addon"]').check();
    await page.getByRole('button', { name: 'Cadastrar' }).click();
    await page.waitForFunction(() => /Hidratação teste/.test(document.querySelector('#fsSvcList')?.textContent || ''));

    // Excluir.
    page.once('dialog', d => d.accept());
    await page.locator('#fsSvcList .fs-sale', { hasText: 'Hidratação teste' }).locator('[data-svc-del]').click();
    await page.waitForFunction(() => !/Hidratação teste/.test(document.querySelector('#fsSvcList')?.textContent || ''));

    const items = await f.api('/store/sales/service-items');
    const banho = items.find(i => i.name === 'Banho teste');
    assert.equal(banho.price_cents, 5500); assert.equal(banho.cost_cents, 1200);
    assert.deepEqual(banho.price_rules.size.find(x => x.name === 'Grande')?.cents, 2000);
    assert.ok(!items.some(i => i.name === 'Hidratação teste'));

    // O caixa continua abrindo a mesma lista em janela.
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');
    await page.getByRole('button', { name: 'Serviço', exact: true }).click();
    await page.locator('#fsSvcManage').click();
    await page.waitForSelector('#editorDialog[open] #fsSvcList');
    assert.match(await page.locator('#editorDialog #fsSvcList').innerText(), /Banho teste/);
    await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/servicos-caixa.png' : undefined });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
