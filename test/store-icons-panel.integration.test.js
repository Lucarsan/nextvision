import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// O painel usa só ícones em SVG (traço fino): nenhum emoji nem símbolo usado como ícone pode aparecer na tela.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{25A0}-\u{25FF}\u{2610}\u{2630}]/u;

test('painel da loja sem emojis: menu, caixa, estoque e mensagens usam ícones SVG', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => process.env.SHOT_DIR ? { path: process.env.SHOT_DIR + '/' + name + '.png' } : {};
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    await f.api('/store/sales/cashback', { method: 'PATCH', body: { cashback_enabled: true } });
    await f.api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    await f.api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Ana Lima', phone: '85 97777-1111' }, total_cents: 5000, payment_method: 'pix' } }, 201);
    const clean = async where => { const text = await page.locator('body').innerText(); const hit = text.match(EMOJI); assert.equal(hit, null, `${where}: "${hit?.[0]}" na tela`); };

    await page.goto(f.base + '/loja.html');
    await page.waitForSelector('.nv-sidebar [data-view="cash"] svg.fp-ic');
    assert.equal(await page.locator('.nv-sidebar .nv-menu button svg.fp-ic').count(), await page.locator('.nv-sidebar .nv-menu button').count(), 'todo item do menu tem ícone');
    assert.equal(await page.locator('i[data-ic]').count(), 0, 'nenhum marcador sem desenho');
    await clean('início'); await page.screenshot(shot('icones-inicio'));

    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.waitForSelector('#fsSale');
    await page.locator('#fsSearch').fill('ana'); await page.locator('[data-fs-pick]').first().click();
    await page.waitForSelector('#fsCbBox .fs-cb svg');
    await clean('caixa'); await page.screenshot(shot('icones-caixa'));
    await page.getByRole('button', { name: 'Serviço', exact: true }).click(); await clean('caixa serviço');

    await page.getByRole('button', { name: 'Estoque' }).click();
    for (const tab of ['Entrada rápida', 'Peças', 'Fornecedores', 'Gerar códigos', 'Reposição']) {
      await page.getByRole('tab', { name: tab }).click(); await page.waitForTimeout(150); await clean('estoque ' + tab);
      assert.ok(await page.getByRole('tab', { name: tab }).locator('svg').count(), `aba ${tab} com ícone`);
    }
    await page.screenshot(shot('icones-estoque'));
    await page.locator('[data-close-dialog]').first().click();

    await page.locator('.nv-sidebar [data-view="messages"]').click();
    for (const tab of ['Status do dia', 'Cashback', 'Ofertas', 'Configurar']) { await page.getByRole('tab', { name: tab }).click(); await page.waitForTimeout(200); await clean('mensagens ' + tab); }
    for (const view of ['processes', 'customers', 'orders', 'queues', 'cameras', 'settings', 'plan', 'support']) { await page.locator(`.nv-sidebar [data-view="${view}"]`).click(); await page.waitForTimeout(250); await clean(view); }

    // Celular: barra inferior também com ícones.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.nv-phone-nav [data-view="home"]').click();
    assert.equal(await page.locator('.nv-phone-nav button svg.fp-ic').count(), await page.locator('.nv-phone-nav button').count());
    await clean('celular'); await page.screenshot(shot('icones-celular'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
