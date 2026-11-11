import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// "+ Incluir" na venda a receber: o caixa monta os itens que faltaram (mesmo cliente e pet) e soma na venda, sem cobrar.
test('caixa inclui serviços numa venda a receber', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const errors = [];
    const open = async viewport => {
      const context = await browser.newContext({ viewport }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); return page;
    };
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const cli = await f.api('/customers', { method: 'POST', body: { name: 'Afonso Filho', phone: '85997106788' } }, 201);
    await f.api('/customers/' + cli.id + '/pets', { method: 'POST', body: { name: 'Dom', species: 'Cão', breed: 'Yorkshire Terrier', size: 'Médio' } }, 201);
    await f.api('/store/sales/service-items', { method: 'POST', body: { name: 'Banho de cheiro', price_cents: 4300, price_rules: { size: [{ name: 'Médio', cents: 700 }] } } }, 201);
    await f.api('/store/sales/service-items', { method: 'POST', body: { name: 'Hidratação', price_cents: 1800, addon: true } }, 201);
    await f.api('/store/sales/service-items', { method: 'POST', body: { name: 'taxi dog de 4km ate 7km', price_cents: 6000 } }, 201);
    const p = await f.api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, items: [{ service: 'Banho de cheiro', unit_price_cents: 5000, device_model: 'Dom' }] } }, 201);
    await f.api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);

    const page = await open({ width: 1500, height: 950 });
    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.waitForSelector('[data-pend-add]');
    await page.locator('[data-pend-add]').click();
    await page.waitForSelector('#fsAddBanner:not([hidden])');
    assert.match(await page.locator('.fs-newsale h2').innerText(), /Incluir na venda a receber #1/);
    assert.match(await page.locator('#fsCustomerBox').innerText(), /Afonso Filho/);
    assert.equal(await page.locator('#fsSaleBtn').isVisible(), false, 'não dá para registrar venda paga');
    assert.equal(await page.locator('.fs-methods').isVisible(), false);
    await page.waitForSelector('#fsSvcQuick:has-text("preços para Dom")');
    await page.locator('[data-fs-svc]', { hasText: 'Hidratação' }).click();
    await page.locator('[data-fs-svc]', { hasText: 'taxi dog' }).click();
    await page.screenshot(shot('incluir-a-receber'));
    await page.getByRole('button', { name: /Incluir na venda a receber #1/ }).click();
    await page.waitForFunction(() => /2 itens incluídos/.test(document.querySelector('#panelFeedback')?.innerText || ''));
    await page.waitForSelector('#fsPending:has-text("taxi dog")');
    assert.match(await page.locator('#fsPending').innerText(), /#1[\s\S]*Banho de cheiro[\s\S]*Hidratação[\s\S]*taxi dog[\s\S]*R\$\s*128,00/);
    assert.equal(await page.locator('#fsAddBanner').isVisible(), false, 'volta para nova venda');
    assert.match(await page.locator('#fsLaterBtn').innerText(), /Pagar depois/);
    const row = (await f.db.query('SELECT total_cents,paid_sale_id FROM pending_sales WHERE id=$1', [p.id])).rows[0];
    assert.equal(row.total_cents, 12800); assert.equal(row.paid_sale_id, null);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM sales WHERE tenant_id=$1', [f.tenant])).rows[0].n, 0, 'nada cobrado');

    // Sair sem incluir limpa o modo; celular sem rolagem lateral.
    const phone = page; await phone.setViewportSize({ width: 390, height: 844 });
    await phone.waitForSelector('[data-pend-add]');
    await phone.locator('[data-pend-add]').click();
    await phone.waitForSelector('#fsAddBanner:not([hidden])');
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await phone.screenshot(shot('incluir-a-receber-celular'));
    await phone.locator('#fsAddCancel').click();
    assert.equal(await phone.locator('#fsAddBanner').isVisible(), false);
    assert.match(await phone.locator('.fs-newsale h2').innerText(), /Nova venda/);
    assert.equal(await phone.locator('#fsSaleBtn').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
