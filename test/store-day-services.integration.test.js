import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());

test('busca pelo nome do pet mostra o tutor; serviços do dia lista pagos, a receber e pedidos sem venda', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Recebido', 'Pronto'] } }, 201);
    const afonso = await api('/customers', { method: 'POST', body: { name: 'Afonso Filho', phone: '85997106788' } }, 201);
    const dom = await api('/customers/' + afonso.id + '/pets', { method: 'POST', body: { name: 'Dom', breed: 'Yorkshire Terrier', size: 'Médio' } }, 201);
    const maria = await api('/customers', { method: 'POST', body: { name: 'Maria Dominga', phone: '85988881234' } }, 201);

    // "dom" acha a cliente pelo nome e o pet Dom com o tutor.
    const found = await api('/store/sales/customers?q=dom');
    assert.deepEqual(found.map(x => [x.name, x.pet?.name || null]), [['Maria Dominga', null], ['Afonso Filho', 'Dom']]);
    assert.equal(found[1].pet.id, dom.id); assert.equal(found[1].pet.breed, 'Yorkshire Terrier');

    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    await api('/store/sales', { method: 'POST', body: { customer_id: afonso.id, payment_method: 'pix', items: [{ service: 'Banho de cheiro', unit_price_cents: 5000, device_model: 'Dom' }, { name: 'Shampoo', quantity: 1, unit_price_cents: 3000 }] } }, 201);
    const canceled = await api('/store/sales', { method: 'POST', body: { customer_id: afonso.id, payment_method: 'cash', items: [{ service: 'Tosa', unit_price_cents: 4000 }] } }, 201);
    await api(`/store/sales/${canceled.sale.id}/cancel`, { method: 'POST', body: { reason: 'Lançado errado' } });
    await api('/store/sales/pending', { method: 'POST', body: { customer_id: maria.id, items: [{ service: 'Hidratação', unit_price_cents: 2000, device_model: 'Mel' }] } }, 201);
    await api('/store/sales/pending', { method: 'POST', body: { customer_id: maria.id, total_cents: 1500, description: 'Corte de unhas' } }, 201);
    const lonely = await api('/orders', { method: 'POST', body: { customer_id: maria.id, process_id: proc.id, details: { item_type: 'pet', pet_name: 'Mel', service: 'Banho' } } }, 201);
    await api('/store/sales', { method: 'POST', body: { customer_id: afonso.id, payment_method: 'pix', total_cents: 1000, live_order: { process_id: proc.id, details: { pet_name: 'Dom' } } } }, 201);

    const d = await api('/store/sales/day-services');
    assert.equal(d.day, today());
    assert.deepEqual(d.paid.map(x => [x.service, x.pet, x.total_cents, x.payment_method]), [['Banho de cheiro', 'Dom', 5000, 'pix']], 'só serviços, sem cancelada');
    assert.deepEqual(d.pending.map(x => [x.service, x.pet, x.total_cents]), [['Hidratação', 'Mel', 2000], ['Corte de unhas', null, 1500]]);
    assert.deepEqual(d.orders_without_sale.map(o => o.id), [lonely.id], 'pedido com venda não aparece');
    const old = await api('/store/sales/day-services?day=2020-01-01');
    assert.deepEqual([old.paid.length, old.pending.length, old.orders_without_sale.length], [0, 0, 0]);
    assert.equal((await request('/store/sales/day-services?day=ontem')).status, 400);
  } finally { await f.cleanup(); }
});

test('painel: achar pelo pet no caixa e conferir os serviços do dia', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const cli = await f.api('/customers', { method: 'POST', body: { name: 'Afonso Filho', phone: '85997106788' } }, 201);
    await f.api('/customers/' + cli.id + '/pets', { method: 'POST', body: { name: 'Thor', breed: 'Golden Retriever', size: 'Grande' } }, 201);
    await f.api('/customers/' + cli.id + '/pets', { method: 'POST', body: { name: 'Dom', breed: 'Yorkshire Terrier', size: 'Médio' } }, 201);
    await f.api('/store/sales/service-items', { method: 'POST', body: { name: 'Banho de cheiro', price_cents: 4300, price_rules: { size: [{ name: 'Médio', cents: 700 }] } } }, 201);

    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');
    assert.match(await page.locator('#fsSearch').getAttribute('placeholder'), /pet/);
    await page.locator('#fsSearch').fill('dom');
    await page.waitForSelector('[data-fs-pick-pet]');
    assert.match(await page.locator('[data-fs-pick-pet]').innerText(), /Dom\s*Yorkshire Terrier · tutor Afonso Filho/);
    await page.locator('[data-fs-pick-pet]').click();
    // O pet escolhido já vem marcado e os serviços abertos.
    await page.waitForSelector('#fsSvcQuick:has-text("preços para Dom")');
    assert.match(await page.locator('[data-fs-pet][aria-pressed="true"]').innerText(), /Dom/);
    await page.locator('[data-fs-svc]', { hasText: 'Banho de cheiro' }).click();
    await page.getByRole('button', { name: 'Registrar serviço' }).click();
    await page.waitForSelector('.fs-last');

    await page.locator('.nv-sidebar [data-view="dayservices"]').click();
    await page.waitForSelector('.fs-day-table');
    assert.match(await page.locator('.fs-day').innerText(), /1\s*serviços[\s\S]*1\s*banhos[\s\S]*R\$\s*50,00/);
    assert.match(await page.locator('.fs-day-table').innerText(), /Afonso Filho\s*Dom\s*Banho de cheiro\s*R\$\s*50,00\s*Pago · Pix/);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#fsDayCsv').click()]);
    const csv = await (await download.createReadStream()).toArray().then(b => Buffer.concat(b).toString('utf8'));
    assert.match(download.suggestedFilename(), /^servicos-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.match(csv, /"Afonso Filho";"Dom";"Banho de cheiro";"50,00";"Pago";"Pix R\$\s50,00"|"Afonso Filho";"Dom";"Banho de cheiro";"50,00";"Pago";"Pix"/);
    await page.screenshot(shot('servicos-do-dia'));
    await page.locator('#fsDayPrev').click();
    await page.waitForSelector('.fs-day:has-text("Nenhum serviço lançado")');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#fsDayNext').click();
    await page.waitForSelector('.fs-day-table');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'sem rolagem lateral no celular');
    await page.screenshot(shot('servicos-do-dia-celular'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
