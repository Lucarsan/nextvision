import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';
import { reportData, reportHtml } from '../src/reports.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

// Uber moto do serviço: gasto da loja. Não muda o total cobrado; entra no custo e abate do lucro.
test('custo do Uber moto no serviço: só nas lojas ligadas, entra no custo e não no total', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    assert.equal((await api('/store/sales/config')).ride_cost_enabled, false, 'desligado por padrão');
    await f.db.query('UPDATE tenants SET ride_cost_enabled=true WHERE id=$1', [tenant]);
    assert.equal((await api('/store/sales/config')).ride_cost_enabled, true);

    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const { sale } = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'cash',
      items: [{ service: 'Troca de tela', unit_price_cents: 30000, cost_cents: 12000, supplier: 'João Peças', device_model: 'Galaxy A12', ride_cost_cents: 1500 }] } }, 201);
    assert.equal(sale.total_cents, 30000, 'Uber não soma no valor do cliente');
    assert.equal(sale.items[0].ride_cost_cents, 1500);
    // Serviço sem Uber continua como antes.
    await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'cash', items: [{ service: 'Troca de bateria', unit_price_cents: 10000, cost_cents: 4000 }] } }, 201);

    const cash = await api('/store/cash');
    assert.equal(cash.summary.sales_total_cents, 40000);
    assert.equal(cash.summary.costs_cents, 12000 + 1500 + 4000, 'custo do caixa inclui o Uber');
    assert.equal(cash.summary.net_cents, 40000 - 17500);
    assert.ok(cash.sales.some(x => x.items.some(i => i.ride_cost_cents === 1500)));

    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Fortaleza' });
    const data = await reportData((sql, params) => f.db.query(sql, params), tenant, 'daily', day);
    const tela = data.services.find(s => s.name === 'Troca de tela');
    assert.deepEqual([tela.part_cost, tela.ride, tela.cost], [12000, 1500, 13500]);
    assert.equal(data.parts_cost, 12000 + 1500 + 4000);
    assert.equal(data.by_supplier.find(x => x.name === 'João Peças').services_cost, 12000, 'fornecedor só conta a peça');
    assert.ok(reportHtml(data).includes('inclui Uber'));

    // Valor inválido é recusado.
    const bad = await f.request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'cash', items: [{ service: 'Troca de tela', unit_price_cents: 100, ride_cost_cents: -5 }] } });
    assert.equal(bad.status, 400);
  } finally { await f.cleanup(); }
});

test('caixa mostra o campo Uber moto só quando a loja tem o recurso', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const { createRequire } = await import('node:module');
  const f = await createStoreFixture(); let browser;
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 950 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    await f.db.query('UPDATE tenants SET ride_cost_enabled=true,niche=$2 WHERE id=$1', [f.tenant, 'electronics']);
    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');
    await page.getByRole('button', { name: 'Serviço', exact: true }).click();
    await page.waitForSelector('#fsSvcRide');
    await page.locator('#fsSvcName').fill('Troca de tela');
    await page.locator('#fsSvcPrice').fill('250,00');
    await page.locator('#fsSvcCost').fill('80,00');
    await page.locator('#fsSvcRide').fill('15,00');
    assert.match(await page.locator('#fsSvcProfit').innerText(), /155,00/);
    await page.getByRole('button', { name: 'Não quis se identificar' }).click();
    await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/caixa-uber.png' : undefined });
    await page.getByRole('button', { name: 'Registrar serviço' }).click();
    await page.waitForSelector('.fs-tag-svc');
    const r = await f.db.query('SELECT i.total_cents,i.unit_cost_cents,i.ride_cost_cents FROM sale_items i WHERE i.tenant_id=$1', [f.tenant]);
    assert.deepEqual(r.rows, [{ total_cents: 25000, unit_cost_cents: 8000, ride_cost_cents: 1500 }]);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
