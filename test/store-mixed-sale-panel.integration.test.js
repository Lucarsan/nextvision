import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Caixa: produtos cadastrados e serviços na MESMA venda, em qualquer ordem, com peça do estoque, desconto e troco.
test('caixa: produtos e serviços juntos na mesma venda', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    const { api } = f;
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    const capa = await api('/store/products', { method: 'POST', body: { name: 'Capa A12', barcode: '7890000000011', price_cents: 3000, cost_cents: 800, stock_qty: 10 } }, 201);
    const pel = await api('/store/products', { method: 'POST', body: { name: 'Película 3D', barcode: '7890000000028', price_cents: 2000, cost_cents: 100, stock_qty: 20 } }, 201);
    const tela = await api('/store/products', { method: 'POST', body: { kind: 'part', name: 'Tela', device_model: 'Galaxy A12', supplier: 'João Peças', cost_cents: 8000, price_cents: 25000, stock_qty: 3 } }, 201);

    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');

    // 1) Começa pelo serviço: troca de tela com a peça do estoque; põe na venda.
    await page.getByRole('button', { name: 'Serviço', exact: true }).click();
    await page.locator('#fsSvcPartQ').click(); await page.locator('#fsSvcPartQ').fill('a12');
    await page.locator('#fsSvcPartList button', { hasText: 'Tela · Galaxy A12' }).click();
    assert.equal(await page.locator('#fsSvcPrice').inputValue(), '250,00');
    await page.locator('#fsSvcAdd').click();
    await page.waitForFunction(() => /Itens desta venda[\s\S]*Troca de tela[\s\S]*250,00[\s\S]*Total da venda[\s\S]*250,00/.test(document.getElementById('fsMix').textContent));
    assert.equal(await page.locator('#fsSvcName').inputValue(), '', 'formulário limpo para o próximo serviço');

    // 2) Segundo serviço fica "em edição" (entra ao registrar).
    await page.locator('#fsSvcName').fill('Troca de bateria'); await page.locator('#fsSvcPrice').fill('120');
    await page.waitForFunction(() => /Troca de bateria[\s\S]*em edição[\s\S]*Total da venda[\s\S]*370,00/.test(document.getElementById('fsMix').textContent));
    assert.equal(await page.locator('#fsSaleBtn').textContent(), 'Registrar serviços');

    // 3) Bipa produtos: passa para "Produto" e soma na mesma venda (2 capas + 1 película).
    await page.locator('#fsScan').focus().catch(() => {});
    await page.getByRole('button', { name: 'Produto', exact: true }).click();
    for (const code of [capa.barcode, capa.barcode, pel.barcode]) { await page.locator('#fsScan').fill(code); await page.locator('#fsScan').press('Enter'); await page.waitForTimeout(250); }
    await page.waitForFunction(() => document.querySelectorAll('#fsCart .fs-item').length === 2);
    // Desconto de R$ 10,00 sobre os produtos: produtos 80 − 10 = 70; total 70 + 250 + 120 = 440.
    await page.locator('#fsDiscount').fill('10'); await page.locator('#fsDiscount').press('Enter');
    await page.waitForFunction(() => /Produtos e itens[\s\S]*70,00[\s\S]*Total da venda[\s\S]*440,00/.test(document.getElementById('fsMix').textContent));
    assert.equal(await page.locator('#fsSaleBtn').textContent(), 'Registrar venda');

    // 4) Volta ao serviço: o que estava em edição continua; paga em dinheiro com troco.
    await page.getByRole('button', { name: 'Serviço', exact: true }).click();
    assert.equal(await page.locator('#fsSvcName').inputValue(), 'Troca de bateria', 'serviço em edição continua');
    await page.getByRole('button', { name: 'Não quis se identificar' }).click();
    await page.locator('#fsSale [name=method][value=cash]').check({ force: true });
    await page.locator('#fsSale [name=received]').fill('500');
    await page.waitForFunction(() => /Troco:\s*R\$\s?60,00/.test(document.getElementById('fsChangeOut').textContent));
    await page.screenshot(shot('venda-mista'));
    await page.locator('#fsSaleBtn').click();
    await page.waitForFunction(() => /registrada: R\$\s?440,00/.test(document.getElementById('panelFeedback')?.textContent || ''));

    // 5) Conferência no servidor: itens, valores, custos e estoque.
    const cash = await api('/store/cash');
    const sale = cash.sales[0];
    assert.equal(sale.total_cents, 44000);
    const names = sale.items.map(i => `${i.quantity}x ${i.name}${i.service ? ' [s]' : ''}${i.gift ? ' [b]' : ''}`).sort();
    assert.deepEqual(names, ['1x Película 3D', '1x Troca de bateria [s]', '1x Troca de tela [s]', '2x Capa A12'].sort());
    assert.equal(sale.items.reduce((a, i) => a + i.total_cents, 0), 44000, 'soma dos itens = total');
    assert.equal(cash.summary.costs_cents, 2 * 800 + 100 + 8000, 'custos: capas, película e peça da tela');
    assert.equal((await api('/store/products?q=capa'))[0].stock_qty, 8);
    assert.equal((await f.db.query('SELECT stock_qty FROM products WHERE id=$1', [tela.id])).rows[0].stock_qty, 2, 'peça baixou 1');
    // Formulário zerado para a próxima venda.
    assert.equal(await page.locator('#fsCart .fs-item').count(), 0);
    assert.equal((await page.locator('#fsMix').textContent()).trim(), '');

    // 6) Só serviço continua funcionando como antes (um toque).
    await page.getByRole('button', { name: 'Serviço', exact: true }).click();
    await page.locator('#fsSvcName').fill('Reparo comum'); await page.locator('#fsSvcPrice').fill('50');
    await page.getByRole('button', { name: 'Não quis se identificar' }).click();
    await page.getByRole('button', { name: 'Registrar serviço' }).click();
    await page.waitForFunction(() => /Serviço #2 registrado: R\$\s?50,00/.test(document.getElementById('panelFeedback')?.textContent || ''));

    // 7) Serviço começado e incompleto não deixa registrar a venda dos produtos sem avisar.
    await page.getByRole('button', { name: 'Produto', exact: true }).click();
    await page.locator('#fsScan').fill(capa.barcode); await page.locator('#fsScan').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#fsCart .fs-item').length === 1);
    await page.getByRole('button', { name: 'Serviço', exact: true }).click();
    await page.locator('#fsSvcName').fill('Troca de conector');
    await page.getByRole('button', { name: 'Não quis se identificar' }).click();
    await page.locator('#fsSaleBtn').click();
    await page.waitForFunction(() => /Serviço em edição: Informe o preço/.test(document.getElementById('fsSaleStatus').textContent));
    assert.equal((await api('/store/cash')).sales.length, 2, 'não registrou');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
