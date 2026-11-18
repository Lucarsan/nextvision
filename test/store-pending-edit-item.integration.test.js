import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// "Editar" no A receber: corrige custo (peça), fornecedor e garantia do serviço antes de receber;
// o custo corrigido vai para a venda ao receber.
test('editar custo de serviço a receber (API e painel)', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'electronics' } });
    const cli = await f.api('/customers', { method: 'POST', body: { name: 'Diego Moraes', phone: '85997106700' } }, 201);
    const p = await f.api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, items: [{ service: 'Troca de tela', unit_price_cents: 18000, cost_cents: 8500, warranty_days: 90 }] } }, 201);
    const other = await f.api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, items: [{ service: 'Troca de bateria', unit_price_cents: 9000, cost_cents: 4000 }] } }, 201);

    // API: validação, outra loja, item que não é serviço.
    assert.equal((await f.request(`/store/sales/pending/${p.id}/items/0`, { method: 'PATCH', body: {} })).status, 400);
    assert.equal((await f.request(`/store/sales/pending/${p.id}/items/0`, { method: 'PATCH', body: { cost_cents: -1 } })).status, 400);
    assert.equal((await f.request(`/store/sales/pending/${p.id}/items/5`, { method: 'PATCH', body: { cost_cents: 0 } })).status, 409);
    assert.ok([403, 409].includes((await f.request(`/store/sales/pending/${p.id}/items/0`, { method: 'PATCH', token: f.foreignToken, body: { cost_cents: 0 } })).status), 'outra loja não edita');
    const upd = await f.api(`/store/sales/pending/${other.id}/items/0`, { method: 'PATCH', body: { cost_cents: null, supplier: 'Fornecedor X' } });
    assert.equal(upd.payload.items[0].cost_cents, undefined); assert.equal(upd.payload.items[0].supplier, 'Fornecedor X');

    // Painel: botão Editar no card, custo 0, salva sem mexer no total.
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await f.api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.waitForSelector(`[data-pend-edit="${p.id}"]`);
    await page.locator(`[data-pend-edit="${p.id}"]`).click();
    const fs = page.locator('#fsPendEditForm .fs-pend-edit');
    assert.equal(await fs.locator('[name=cost]').inputValue(), '85,00');
    assert.equal(await fs.locator('[name=warranty]').inputValue(), '90');
    await fs.locator('[name=cost]').fill('0');
    await page.screenshot(shot('editar-a-receber'));
    await page.locator('#fsPendEditForm button.nv-button').click();
    await page.waitForFunction(() => /A receber #\d+ atualizado/.test(document.querySelector('#panelFeedback')?.innerText || ''));
    const row = (await f.db.query('SELECT total_cents,payload FROM pending_sales WHERE id=$1', [p.id])).rows[0];
    assert.equal(row.total_cents, 18000); assert.equal(row.payload.items[0].cost_cents, 0); assert.equal(row.payload.items[0].warranty_days, 90);
    assert.deepEqual(errors, []);

    // Recebe no Pix: a venda grava custo 0.
    const r = await f.api(`/store/sales/pending/${p.id}/pay`, { method: 'POST', body: { payment_method: 'pix' } }, 201);
    const item = (await f.db.query('SELECT unit_cost_cents FROM sale_items WHERE sale_id=$1', [r.sale.id])).rows[0];
    assert.equal(item.unit_cost_cents, 0);
    // Depois de recebida, não edita mais.
    assert.equal((await f.request(`/store/sales/pending/${p.id}/items/0`, { method: 'PATCH', body: { cost_cents: 100 } })).status, 409);
  } finally { await browser?.close(); await f.cleanup(); }
});
