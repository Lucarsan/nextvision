import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Caixa: relatório à esquerda, nova venda à direita, vendedor no topo; venda de serviço com peça do estoque.
test('caixa registra serviço com peça, fornecedor e aparelho sugeridos', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 950 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    await f.addOperator(f.tenant, 'full', 'Daniel Cardeal');
    await f.api('/store/products', { method: 'POST', body: { kind: 'part', name: 'Tela', device_model: 'Galaxy A12', supplier: 'João Peças', cost_cents: 8000, price_cents: 25000, stock_qty: 2 } }, 201);

    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');

    // Layout: nova venda à direita do relatório; vendedor curto no canto superior direito do topo do caixa.
    const report = await page.locator('.fs-col-report').boundingBox(), sale = await page.locator('.fs-newsale').boundingBox();
    assert.ok(sale.x > report.x + report.width - 1, 'nova venda à direita');
    await page.waitForSelector('.fs-seller:not([hidden])');
    const bar = await page.locator('.fs-cashbar').boundingBox(), seller = await page.locator('.fs-seller').boundingBox();
    assert.ok(seller.x > bar.x + bar.width / 2 && seller.y < bar.y + 40, 'vendedor no canto superior direito');
    assert.ok(seller.width < 300, 'seletor curto');
    assert.equal(await page.locator('#fsSale #fsSeller').count(), 0, 'vendedor fora do formulário');
    await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/caixa-produto.png' : undefined });

    // Serviço: escolher a peça preenche aparelho, fornecedor, custo, preço e nome.
    await page.getByRole('button', { name: 'Serviço', exact: true }).click();
    assert.equal(await page.locator('#fsScan').isVisible(), false, 'leitor/itens de produto escondidos');
    await page.locator('#fsSvcPartQ').click(); await page.locator('#fsSvcPartQ').fill('a12');
    await page.locator('#fsSvcPartList button', { hasText: 'Tela · Galaxy A12' }).click();
    assert.equal(await page.locator('#fsSvcModel').inputValue(), 'Galaxy A12');
    assert.equal(await page.locator('#fsSvcSupplier').inputValue(), 'João Peças');
    assert.equal(await page.locator('#fsSvcCost').inputValue(), '80,00');
    assert.equal(await page.locator('#fsSvcPrice').inputValue(), '250,00');
    assert.equal(await page.locator('#fsSvcName').inputValue(), 'Troca de tela');
    assert.match(await page.locator('#fsSvcProfit').innerText(), /170,00/);
    await page.locator('#fsSvcWarranty').selectOption('90');
    await page.getByRole('button', { name: 'Não quis se identificar' }).click();
    await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/caixa-servico.png' : undefined });
    await page.getByRole('button', { name: 'Registrar serviço' }).click();
    await page.waitForSelector('.fs-tag-svc');
    assert.match(await page.locator('.fs-col-report').innerText(), /Troca de tela · Galaxy A12/);

    // Segundo serviço sem peça: fornecedor sugerido pelo que já foi usado.
    await page.getByRole('button', { name: 'Serviço', exact: true }).click();
    // Botões de serviços: lista inicial; "Editar" define o preço; o botão preenche serviço e preço.
    await page.waitForSelector('[data-fs-svc]');
    assert.match(await page.locator('#fsSvcQuick').innerText(), /Troca de bateria[\s\S]*Reparo comum/);
    await page.locator('#fsSvcManage').click();
    await page.locator('[data-svc-edit]').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#fsSvcForm [name="name"]')?.value === 'Troca de bateria');
    await page.locator('#fsSvcForm [name="price"]').fill('120,00'); await page.locator('#fsSvcForm [name="cost"]').fill('50,00');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await page.waitForSelector('text="Troca de bateria" salvo.');
    await page.locator('[data-close-dialog]').click();
    await page.locator('#fsSvcQuick button', { hasText: 'Troca de bateria' }).click();
    assert.equal(await page.locator('#fsSvcName').inputValue(), 'Troca de bateria');
    assert.equal(await page.locator('#fsSvcPrice').inputValue(), '120,00');
    assert.equal(await page.locator('#fsSvcCost').inputValue(), '50,00');
    await page.locator('#fsSvcSupplier').click(); await page.locator('#fsSvcSupplier').fill('jo');
    await page.locator('.fs-drop button', { hasText: 'João Peças' }).click();
    assert.equal(await page.locator('#fsSvcSupplier').inputValue(), 'João Peças');
    await page.locator('#fsSvcModel').fill('iPhone 11');
    await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/caixa-servico-botoes.png' : undefined });
    await page.getByRole('button', { name: 'Não quis se identificar' }).click();
    await page.getByRole('button', { name: 'Registrar serviço' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.fs-tag-svc').length === 2);

    // Estoque: aba Peças mostra a tela com 1 unidade e "repor 1".
    await page.locator('#fsProducts').click();
    await page.getByRole('tab', { name: 'Peças' }).click();
    await page.waitForSelector('#fsPartList .fs-sale');
    const parts = await page.locator('#fsPartList').innerText();
    assert.match(parts, /Tela · Galaxy A12/); assert.match(parts, /Estoque: 1/); assert.match(parts, /repor 1/);
    await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/estoque-pecas.png' : undefined });
    await page.getByRole('tab', { name: 'Fornecedores' }).click();
    await page.waitForSelector('text=Modelos de aparelho');
    assert.match(await page.locator('#fsPTab').innerText(), /iPhone 11/);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
