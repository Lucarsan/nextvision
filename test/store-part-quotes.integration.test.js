import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

const setup = async f => {
  await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'electronics' } });
  const mk = (model, loc, qty) => f.api('/store/products', { method: 'POST', body: { kind: 'part', name: 'Tela', device_model: model, location: loc, cost_cents: 5000, price_cents: 15000, stock_qty: qty } }, 201);
  const a01 = await mk('Samsung A01', 'Caixa 01', 0);
  const a02 = await mk('Samsung A02', 'Caixa 01', 3);
  const g9 = await mk('Moto G9', 'Caixa 02', 1);
  const k41 = await mk('LG K41S', 'Caixa 03', 0);
  await f.api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
  // A02: saíram 2 em serviços (continua com 1 no estoque, mas precisa repor).
  for (let i = 0; i < 2; i++) await f.api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ service: 'Troca de tela', unit_price_cents: 15000, part_id: a02.id }] } }, 201);
  return { a01, a02, g9, k41 };
};

test('cotação: zeradas + reposição, preço por fornecedor, mais barato primeiro', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { a01, a02, g9, k41 } = await setup(f);
    let rows = await f.api('/store/stock/quote');
    assert.deepEqual(rows.map(r => [r.device_model, r.order_qty]), [['Samsung A01', 1], ['Samsung A02', 2], ['LG K41S', 1]], 'G9 (tem estoque, nada a repor) fica fora');
    assert.ok(!rows.some(r => r.id === g9.id));
    let r = await f.api('/store/stock/quote/' + a01.id, { method: 'PUT', body: { supplier: 'ZL', price_cents: 6000 } });
    r = await f.api('/store/stock/quote/' + a01.id, { method: 'PUT', body: { supplier: 'Chen', price_cents: 5000 } });
    assert.deepEqual(r.quotes.map(x => [x.supplier_name, x.price_cents]), [['Chen', 5000], ['ZL', 6000]]);
    // Lançar de novo atualiza (sem duplicar); "chen" é o mesmo fornecedor.
    r = await f.api('/store/stock/quote/' + a01.id, { method: 'PUT', body: { supplier: 'chen', price_cents: 6500 } });
    assert.deepEqual(r.quotes.map(x => [x.supplier_name, x.price_cents]), [['ZL', 6000], ['Chen', 6500]]);
    // Preço vazio tira o fornecedor da peça.
    r = await f.api('/store/stock/quote/' + a01.id, { method: 'PUT', body: { supplier: 'ZL', price_cents: null } });
    assert.deepEqual(r.quotes.map(x => x.supplier_name), ['Chen']);
    assert.equal((await f.request('/store/stock/quote/' + a01.id, { method: 'PUT', body: { supplier: '', price_cents: 100 } })).status, 400);
    assert.equal((await f.request('/store/stock/quote/' + a01.id, { method: 'PUT', body: { supplier: 'X', price_cents: -1 } })).status, 400);
    assert.ok([403, 404].includes((await f.request('/store/stock/quote/' + a01.id, { method: 'PUT', token: f.foreignToken, body: { supplier: 'X', price_cents: 1 } })).status), 'outra loja não mexe');
    { const o = await f.request('/store/stock/quote', { token: f.foreignToken }); assert.ok(o.status !== 200 || !o.data.some(x => x.id === a01.id), 'outra loja não vê'); }
    // Quantidade a pedir digitada.
    r = await f.api(`/store/stock/quote/${k41.id}/qty`, { method: 'POST', body: { qty: 3 } });
    assert.equal(r.order_qty, 3);
    assert.equal((await f.request(`/store/stock/quote/${k41.id}/qty`, { method: 'POST', body: { qty: 0 } })).status, 400);
    r = await f.api(`/store/stock/quote/${k41.id}/qty`, { method: 'POST', body: { qty: null } });
    assert.equal(r.order_qty, 1);
    // Incluir à mão (tem estoque) e tirar à mão (zerada).
    r = await f.api(`/store/stock/quote/${g9.id}/include`, { method: 'POST', body: { include: true } });
    assert.deepEqual([r.in_quote, r.order_qty], [true, 1]);
    await f.api(`/store/stock/quote/${a01.id}/include`, { method: 'POST', body: { include: false } });
    rows = await f.api('/store/stock/quote');
    assert.deepEqual(rows.filter(x => x.in_quote).map(x => x.device_model), ['Samsung A02', 'Moto G9', 'LG K41S']);
    assert.equal(rows.find(x => x.id === a01.id).in_quote, false, 'tirada vem marcada, para poder voltar');
    assert.ok([403, 404].includes((await f.request(`/store/stock/quote/${a01.id}/include`, { method: 'POST', token: f.foreignToken, body: { include: true } })).status));
    // Estoque subiu: volta ao automático (G9 com 3 sai; A01 com 2 sai e não fica como "tirada").
    await f.api(`/store/products/${g9.id}/count`, { method: 'POST', body: { qty: 3 } });
    await f.api(`/store/products/${a01.id}/count`, { method: 'POST', body: { qty: 2 } });
    rows = await f.api('/store/stock/quote');
    assert.ok(!rows.some(x => x.id === g9.id || x.id === a01.id));
    // Peça repõe e sai da cotação; o preço fica guardado.
    await f.api(`/store/products/${k41.id}/count`, { method: 'POST', body: { qty: 2 } });
    rows = await f.api('/store/stock/quote');
    assert.ok(!rows.some(x => x.id === k41.id));
    assert.ok(rows.find(x => x.id === a02.id));
  } finally { await f.cleanup(); }
});

test('painel: Reposição → Cotação, preços por fornecedor e pedido no mais barato', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const { createRequire } = await import('node:module');
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    await context.addInitScript(value => { sessionStorage.setItem('nv_token', value); window.open = () => null; window.confirm = () => true; }, f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    const { a01, a02, k41 } = await setup(f);
    await f.api('/store/suppliers', { method: 'POST', body: { name: 'Chen', phone: '85999990000' } }, 201);

    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click(); await page.waitForSelector('#fsSale');
    await page.locator('#fsProducts').click(); await page.locator('[data-ptab=restock]').click();
    await page.locator('[data-rv=quote]').click();
    await page.waitForSelector('#fsQHead:has-text("Peças para cotar (3)")');
    // Fornecedor Chen: digita os preços com Enter (vai para a próxima).
    await page.locator('#fsQSup').fill('chen');
    await page.waitForSelector(`[data-q-price="${a01.id}"]`);
    await page.locator(`[data-q-price="${a01.id}"]`).fill('50'); await page.locator(`[data-q-price="${a01.id}"]`).press('Enter');
    await page.waitForFunction(id => document.activeElement?.dataset?.qPrice === id, a02.id);
    await page.locator(`[data-q-price="${a02.id}"]`).fill('70'); await page.locator(`[data-q-price="${a02.id}"]`).press('Enter');
    await page.waitForFunction(id => document.activeElement?.dataset?.qPrice === id, k41.id);
    // Fornecedor novo ZL: mais barato no A02, mais caro no A01.
    await page.locator('#fsQSup').fill('ZL');
    await page.waitForSelector('label:has-text("Preço na ZL")');
    await page.locator(`[data-q-price="${a01.id}"]`).fill('60'); await page.locator(`[data-q-price="${a01.id}"]`).press('Enter');
    await page.waitForFunction(id => document.activeElement?.dataset?.qPrice === id, a02.id);
    await page.locator(`[data-q-price="${a02.id}"]`).fill('65,50'); await page.locator(`[data-q-price="${a02.id}"]`).press('Enter');
    await page.waitForSelector('.fs-q-order:has-text("ZL")');
    assert.match(await page.locator(`[data-q="${a01.id}"]`).innerText(), /Chen R\$\s?50,00 · mais barato[\s\S]*ZL R\$\s?60,00/);
    const orders = await page.locator('#fsQOrders').innerText();
    assert.match(orders, /Chen · 1 peça\(s\) · R\$\s?50,00[\s\S]*1× Tela · Samsung A01/);
    assert.match(orders, /ZL · 1 peça\(s\) · R\$\s?131,00[\s\S]*2× Tela · Samsung A02 \(R\$\s?65,50\)/);
    assert.match(orders, /1 peça\(s\) ainda sem preço/);
    assert.match(await page.locator('.fs-q-order', { hasText: 'Chen' }).locator('a').getAttribute('href'), /wa\.me\/5585999990000\?text=.*1x%20Tela%20%C2%B7%20Samsung%20A01/);
    // Tirar e voltar.
    await page.locator(`[data-q-out="${k41.id}"]`).click();
    await page.waitForSelector('#fsQOut:has-text("Tiradas da cotação (1)")');
    assert.match(await page.locator('#fsQHead').innerText(), /\(2\)/);
    await page.locator(`[data-q-in="${k41.id}"]`).click();
    await page.waitForSelector('#fsQHead:has-text("(3)")');
    // Incluir outra peça pelo modelo.
    await f.api('/store/products', { method: 'POST', body: { kind: 'part', name: 'Tela', device_model: 'Redmi 13C', location: 'Caixa 05', cost_cents: 5000, price_cents: 15000, stock_qty: 1 } }, 201);
    await page.locator('[data-rv=quote]').click(); await page.waitForSelector('#fsQHead:has-text("(3)")');
    await page.locator('#fsQAdd').fill('Tela · Redmi 13C'); await page.locator('#fsQAdd').dispatchEvent('change');
    await page.waitForSelector('#fsQHead:has-text("(4)")');
    assert.equal(await page.locator('[data-q-qty]').last().inputValue(), '1');
    // Mudar a quantidade a pedir: o pedido do fornecedor acompanha.
    await page.locator(`[data-q-qty="${a01.id}"]`).fill('2'); await page.locator(`[data-q-qty="${a01.id}"]`).press('Enter');
    await page.waitForSelector('.fs-q-order:has-text("2× Tela · Samsung A01")');
    assert.match(await page.locator('#fsQOrders').innerText(), /Chen · 1 peça\(s\) · R\$\s?100,00/);
    await page.screenshot(shot('cotacao'));
    // Preço guardado no servidor.
    const saved = (await f.api('/store/stock/quote')).find(r => r.id === a02.id);
    assert.deepEqual(saved.quotes.map(x => [x.supplier_name, x.price_cents]), [['ZL', 6550], ['Chen', 7000]]);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
