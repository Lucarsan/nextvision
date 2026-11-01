import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import bcrypt from 'bcryptjs';
import { createStoreFixture } from './helpers/store-fixture.js';

// Senha só deste teste (a real fica no Render, como hash).
process.env.STOCK_VALUE_LOGIN = 'admin';
process.env.STOCK_VALUE_PASSWORD_HASH = bcrypt.hashSync('senha-de-teste-1', 8);
const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

async function seed(f) {
  await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
  const mk = body => f.api('/store/products', { method: 'POST', body }, 201);
  await mk({ name: 'Fone Bluetooth', barcode: 'FONE-1', price_cents: 8000, cost_cents: 3000, stock_qty: 4 }); // lucro 50 un.
  await mk({ name: 'Cabo USB', barcode: 'CABO-1', price_cents: 1500, cost_cents: 1300, stock_qty: 10 }); // lucro 2 un.
  await mk({ name: 'Caixa de som', barcode: 'SOM-1', price_cents: 9000, cost_cents: 9500, stock_qty: 1 }); // prejuízo
  await mk({ name: 'Sem custo', barcode: 'SC-1', price_cents: 1000, stock_qty: 2 });
  await mk({ name: 'Zerado', barcode: 'Z-1', price_cents: 5000, cost_cents: 1000, stock_qty: 0 });
  const pel = await mk({ name: 'Película', barcode: 'PEL', price_cents: 2000, cost_cents: 500, ask_variant: true });
  await f.api(`/store/products/${pel.id}/stock`, { method: 'POST', body: { add: 3, variant_name: 'A12' } });
  await f.api('/store/products', { method: 'POST', body: { name: 'Tela A12', kind: 'part', cost_cents: 8000, stock_qty: 2 } }, 201);
}

test('valor do estoque: senha própria, totais e itens de maior e menor lucro', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    await seed(f);
    const url = '/store/stock/value';
    assert.equal((await f.request(url, { method: 'POST', body: { login: 'admin', password: 'errada' } })).status, 401);
    assert.equal((await f.request(url, { method: 'POST', body: { login: 'outro', password: 'senha-de-teste-1' } })).status, 401);
    assert.equal((await f.request(url, { method: 'POST', body: { login: 'admin', password: 'senha-de-teste-1' }, token: f.foreignToken })).status, 403, 'loja sem caixa ligado');
    const d = await f.api(url, { method: 'POST', body: { login: ' Admin ', password: 'senha-de-teste-1' } });
    // Fone 4 + Cabo 10 + Som 1 + Sem custo 2 + Película A12 3 = 20 unidades (zerado e peça fora).
    assert.equal(d.products.units, 20);
    assert.equal(d.products.items, 5);
    assert.equal(d.products.cost_cents, 4 * 3000 + 10 * 1300 + 9500 + 3 * 500);
    assert.equal(d.products.sale_cents, 4 * 8000 + 10 * 1500 + 9000 + 2 * 1000 + 3 * 2000);
    assert.equal(d.products.profit_cents, 4 * 5000 + 10 * 200 - 500 + 3 * 1500);
    assert.deepEqual(d.products.without_cost.map(r => r.name), ['Sem custo']);
    assert.equal(d.products.below_cost, 1);
    assert.deepEqual(d.top.map(r => r.name), ['Fone Bluetooth', 'Película', 'Cabo USB', 'Caixa de som']);
    assert.deepEqual(d.bottom.map(r => r.name).slice(0, 2), ['Caixa de som', 'Cabo USB']);
    assert.equal(d.top[1].variant, 'A12');
    assert.equal(d.top[0].margin_pct, 62.5);
    assert.deepEqual(d.parts, { items: 1, units: 2, cost_cents: 16000, without_cost: 0 });
    assert.equal(d.most_capital[0].name, 'Cabo USB');
  } finally { await f.cleanup(); }
});

test('painel: botão Valor do estoque pede login e mostra os totais', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => process.env.SHOT_DIR ? { path: process.env.SHOT_DIR + '/' + name + '.png' } : {};
  try {
    await seed(f);
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1100 }, locale: 'pt-BR' }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="stock"]').click();
    await page.getByRole('tab', { name: 'Valor do estoque' }).click();
    await page.waitForSelector('#fsValF');
    await page.locator('#fsValF [name="login"]').fill('admin');
    await page.locator('#fsValF [name="password"]').fill('errada');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForFunction(() => /incorretos/.test(document.querySelector('#fsValErr')?.innerText || ''));
    await page.locator('#fsValF [name="login"]').fill('admin');
    await page.locator('#fsValF [name="password"]').fill('senha-de-teste-1');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForSelector('.fs-valkpis');
    const kpis = await page.locator('.fs-valkpis').innerText();
    assert.match(kpis, /20\s*unidades/);
    assert.match(kpis, /R\$\s*360,00/); // custo
    assert.match(kpis, /R\$\s*640,00/); // venda
    assert.match(kpis, /R\$\s*260,00/); // lucro
    assert.match(await page.locator('#sectionContent').innerText(), /Maior lucro[\s\S]*Fone Bluetooth[\s\S]*Menor lucro[\s\S]*Caixa de som/);
    await page.screenshot({ ...shot('valor-estoque'), fullPage: true });
    // Trocar de aba e voltar não pede a senha de novo; "Sair" pede.
    await page.getByRole('tab', { name: 'Produtos' }).click();
    await page.getByRole('tab', { name: 'Valor do estoque' }).click();
    await page.waitForSelector('.fs-valkpis');
    await page.locator('#fsValOut').click();
    await page.waitForSelector('#fsValF');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
