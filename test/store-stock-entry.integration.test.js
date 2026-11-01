import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

// API da entrada rápida: busca por palavras em qualquer ordem, excluídos sugeridos e reativados, entrada em lote com custo.
test('entrada de estoque: busca por palavras, excluídos e reativação', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    const cabo = await api('/store/products', { method: 'POST', body: { name: 'Cabo USB Tipo-C 1m Kaidi', barcode: '7890000000017', price_cents: 2500, cost_cents: 900, stock_qty: 0 } }, 201);
    await api('/store/products', { method: 'POST', body: { name: 'Fone Bluetooth', price_cents: 5000 } }, 201);

    // Palavras fora de ordem e sem acento; produto com estoque zerado continua aparecendo.
    assert.deepEqual((await api('/store/products?q=' + encodeURIComponent('kaidi tipo c'))).map(p => p.id), [cabo.id]);
    assert.equal((await api('/store/products?q=CABO usb')).length, 1);
    assert.equal((await api('/store/products?q=7890000000017'))[0].id, cabo.id, 'busca pelo código');

    // Entrada em lote: 30 unidades de uma vez, com custo; reposição usa o mesmo cadastro.
    const after = await api(`/store/products/${cabo.id}/stock`, { method: 'POST', body: { add: 30, unit_cost_cents: 850 } });
    assert.equal(after.stock_qty, 30);

    // Excluído: não aparece na busca normal; com include_deleted aparece depois dos ativos e pode ser reativado.
    const capa = await api('/store/products', { method: 'POST', body: { name: 'Capinha Galaxy A12', barcode: 'CAPA-A12', price_cents: 3000, stock_qty: 4 } }, 201);
    await api('/store/products/' + capa.id, { method: 'DELETE' });
    assert.equal((await api('/store/products?q=capinha')).length, 0);
    const withDeleted = await api('/store/products?include_deleted=1&q=capinha a12');
    assert.deepEqual(withDeleted.map(p => [p.id, p.active]), [[capa.id, false]]);
    assert.equal((await api('/store/products?include_deleted=1')).some(p => !p.active), false, 'sem termo não lista excluídos');
    const back = await api(`/store/products/${capa.id}/restore`, { method: 'POST', body: {} });
    assert.equal(back.active, true); assert.equal(back.stock_qty, 0, 'estoque recomeça do zero'); assert.equal(back.barcode, 'CAPA-A12');
    assert.equal((await api('/store/products/barcode/CAPA-A12')).id, capa.id);
    assert.equal((await request(`/store/products/${capa.id}/restore`, { method: 'POST', body: {} })).status, 404, 'já ativo');

    // Reativar com código que outro produto ativo passou a usar: recusa (409).
    const velho = await api('/store/products', { method: 'POST', body: { name: 'Película velha', barcode: 'PEL-1', price_cents: 1000 } }, 201);
    await api('/store/products/' + velho.id, { method: 'DELETE' });
    await api('/store/products', { method: 'POST', body: { name: 'Película nova', barcode: 'PEL-1', price_cents: 1200 } }, 201);
    assert.equal((await request(`/store/products/${velho.id}/restore`, { method: 'POST', body: {} })).status, 409);

    // Código bipado salvo num produto que não tinha.
    const fone = (await api('/store/products?q=fone'))[0];
    assert.equal((await api('/store/products/' + fone.id, { method: 'PATCH', body: { barcode: '7891111111119' } })).barcode, '7891111111119');
  } finally { await f.cleanup(); }
});

// Painel: bipar código novo cadastra com quantidade; bipar de novo o mesmo produto soma; nome sugere o já cadastrado.
test('painel: entrada rápida pelo leitor e por nome', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 950 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    const antigo = await f.api('/store/products', { method: 'POST', body: { name: 'Carregador Turbo 20W', price_cents: 6000, cost_cents: 2500, stock_qty: 0 } }, 201);

    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');
    await page.locator('#fsProducts').click();
    await page.getByRole('tab', { name: '📥 Entrada rápida' }).click();

    // Leitor: digita o código e Enter. Código desconhecido abre o cadastro com o código preenchido.
    await page.locator('#fsEnScan').pressSequentially('7894444444442\n', { delay: 5 });
    await page.waitForSelector('#fsEnNew');
    assert.equal(await page.locator('#fsEnNew [name="barcode"]').inputValue(), '7894444444442');
    await page.locator('#fsEnNew [name="name"]').fill('Película 3D iPhone 13');
    await page.locator('#fsEnNew [name="n"]').fill('29');
    // Bipar a mesma embalagem com o cursor na quantidade soma 1 (não vira número gigante).
    await page.locator('#fsEnNew [name="n"]').pressSequentially('7894444444442\n', { delay: 5 });
    assert.equal(await page.locator('#fsEnNew [name="n"]').inputValue(), '30');
    await page.locator('#fsEnNew [name="cost"]').fill('3,50'); await page.locator('#fsEnNew [name="price"]').fill('20,00');
    await page.getByRole('button', { name: 'Cadastrar e somar ao estoque' }).click();
    await page.waitForFunction(() => document.querySelector('#fsEnLog')?.innerText.includes('30 unidade'));
    const p = await f.api('/store/products/barcode/7894444444442');
    assert.equal(p.stock_qty, 30); assert.equal(p.cost_cents, 350); assert.equal(p.price_cents, 2000);

    // Reposição do mesmo código: só pede a quantidade.
    await page.locator('#fsEnScan').pressSequentially('7894444444442\n', { delay: 5 });
    await page.waitForSelector('#fsEnStock');
    await page.locator('#fsEnStock [name="n"]').fill('10');
    await page.getByRole('button', { name: 'Somar ao estoque' }).click();
    await page.waitForFunction(() => document.querySelector('#fsEnLog')?.innerText.includes('40 unidade'));
    assert.equal((await f.api('/store/products/barcode/7894444444442')).stock_qty, 40);

    // Por nome: produto com estoque zerado é sugerido; o código bipado no cadastro novo vai para ele.
    await page.locator('#fsEnScan').pressSequentially('7895555555551\n', { delay: 5 });
    await page.waitForSelector('#fsEnNew');
    await page.locator('#fsEnNew [name="name"]').pressSequentially('turbo carreg', { delay: 10 });
    await page.locator('#fsEnSame button', { hasText: 'Carregador Turbo 20W' }).click();
    await page.waitForSelector('#fsEnStock');
    assert.match(await page.locator('#fsEnStock').innerText(), /7895555555551 será salvo/);
    await page.locator('#fsEnStock [name="n"]').fill('5');
    await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/entrada-rapida.png' : undefined });
    await page.getByRole('button', { name: 'Somar ao estoque' }).click();
    await page.waitForFunction(() => document.querySelector('#fsEnLog')?.innerText.includes('45 unidade'));
    const c = await f.api('/store/products/barcode/7895555555551');
    assert.equal(c.id, antigo.id); assert.equal(c.stock_qty, 5);
    await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/entrada-rapida-lista.png' : undefined });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
