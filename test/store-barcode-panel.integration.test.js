import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Simula o leitor USB (modo teclado): digita o código muito rápido e aperta Enter.
test('caixa reconhece produto lido pelo leitor de código de barras', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext(); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    await f.api('/store/products', { method: 'POST', body: { name: 'Película 3D', barcode: '7891234567895', price_cents: 1500 } }, 201);
    const scan = async code => { await page.keyboard.type(code, { delay: 4 }); await page.keyboard.press('Enter'); };

    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('50,00');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');

    // Olho: valores do caixa começam escondidos; mostrar/esconder fica salvo no navegador.
    const kpiColor = () => page.locator('.fs-kpis b').first().evaluate(el => getComputedStyle(el).color);
    assert.equal(await kpiColor(), 'rgba(0, 0, 0, 0)', 'valores escondidos por padrão');
    await page.getByRole('button', { name: '👁 Mostrar valores' }).click();
    assert.notEqual(await kpiColor(), 'rgba(0, 0, 0, 0)');
    await page.locator('.nv-sidebar [data-view="messages"]').click();
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.waitForSelector('#fsSale');
    assert.notEqual(await kpiColor(), 'rgba(0, 0, 0, 0)', 'a escolha continua ao voltar para o caixa');
    await page.getByRole('button', { name: '🙈 Esconder valores' }).click();
    assert.equal(await kpiColor(), 'rgba(0, 0, 0, 0)');

    // Leitura sem clicar em nada: o produto entra na venda; bipar de novo soma a quantidade.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await scan('7891234567895');
    await page.waitForSelector('.fs-item');
    assert.match(await page.locator('#fsCart').innerText(), /Película 3D/);
    await scan('7891234567895');
    await page.waitForFunction(() => document.querySelector('.fs-qty b')?.textContent === '2');
    assert.equal(await page.locator('#fsSale [name="total"]').inputValue(), '30,00');
    assert.equal(await page.locator('#fsSale [name="total"]').getAttribute('readonly'), '');

    // Leitura com o cursor no campo de busca de cliente: o código não fica no campo.
    await page.locator('#fsSearch').click();
    await scan('7891234567895');
    await page.waitForFunction(() => document.querySelector('.fs-qty b')?.textContent === '3');
    assert.equal(await page.locator('#fsSearch').inputValue(), '');

    // Código desconhecido: abre o cadastro com o código; ao salvar, entra na venda.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await scan('7890000000017');
    const dialog = page.locator('#fsProd');
    await dialog.waitFor();
    assert.equal(await dialog.locator('[name="barcode"]').inputValue(), '7890000000017');
    await dialog.locator('[name="name"]').fill('Cabo USB-C');
    await dialog.locator('[name="price"]').fill('25,00');
    await page.getByRole('button', { name: 'Cadastrar e pôr na venda' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.fs-item').length === 2);
    assert.equal(await page.locator('#fsSale [name="total"]').inputValue(), '70,00');

    // Busca por nome digitada à mão também funciona.
    await page.locator('#fsScan').fill('cabo');
    await page.waitForSelector('[data-fs-prod]');
    await page.locator('[data-fs-prod]').first().click();
    await page.waitForFunction(() => [...document.querySelectorAll('.fs-qty b')].map(b => b.textContent).join() === '3,2');

    // Finaliza em dinheiro com troco; o total vem do servidor.
    await page.getByRole('button', { name: 'Não quis se identificar' }).click();
    await page.locator('.fs-methods label', { hasText: 'Dinheiro' }).click();
    await page.locator('#fsSale [name="received"]').fill('100,00');
    assert.match(await page.locator('#fsChangeOut').innerText(), /Troco: R\$\s?5,00/);
    await page.getByRole('button', { name: 'Registrar venda' }).click();
    await page.waitForFunction(() => /Venda #1/.test(document.querySelector('#fsLast')?.textContent || ''));
    assert.equal(await page.locator('.fs-item').count(), 0, 'carrinho esvazia depois da venda');
    const cash = await f.api('/store/cash');
    assert.equal(cash.sales[0].total_cents, 9500);

    // Comprovante: ícone 🧾 na venda da lista (troco desta sessão aparece).
    await page.getByRole('button', { name: 'Imprimir comprovante da venda 1' }).click();
    await page.waitForFunction(() => /Venda nº 1/.test(window.FPSales.lastReceiptHtml || ''));
    const receipt = await page.evaluate(() => window.FPSales.lastReceiptHtml);
    assert.match(receipt, /Película 3D/); assert.match(receipt, /3 x R\$\s?15,00/); assert.match(receipt, /Troco/); assert.match(receipt, /Não é documento fiscal/);
    if (process.env.FP_SHOT) { const p2 = await context.newPage(); await p2.setViewportSize({ width: 302, height: 700 }); await p2.setContent(receipt); await p2.screenshot({ path: process.env.FP_SHOT, fullPage: true }); await p2.close(); }
    assert.deepEqual(cash.sales[0].items.map(i => [i.name, i.quantity]), [['Película 3D', 3], ['Cabo USB-C', 2]]);

    // Digitação humana (lenta) não é tratada como leitura.
    await page.locator('#fsSearch').click();
    await page.keyboard.type('maria', { delay: 120 });
    assert.equal(await page.locator('#fsSearch').inputValue(), 'maria');

    // Itens frequentes (valor digitado) e produtos do leitor não se misturam na mesma venda.
    await f.api('/store/sales/quick-items', { method: 'POST', body: { label: 'Conserto rápido', price_cents: 4000 } }, 201);
    await page.reload();
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('[data-fs-quick]').first().click();
    assert.equal(await page.locator('#fsSale [name="total"]').inputValue(), '40,00');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await scan('7891234567895');
    await page.waitForFunction(() => /itens frequentes/.test(document.getElementById('panelFeedback')?.textContent || ''));
    assert.equal(await page.locator('.fs-item').count(), 0);
    assert.equal(await page.locator('#fsSale [name="total"]').inputValue(), '40,00', 'valor digitado não muda');
    await page.locator('#fsQuickClear').click();
    await scan('7891234567895');
    await page.waitForSelector('.fs-item');
    await page.waitForFunction(() => /soma dos produtos/.test(document.getElementById('fsQuick')?.textContent || ''));
    assert.equal(await page.locator('[data-fs-quick]').count(), 0, 'botões frequentes somem com produtos na venda');
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await f.cleanup(); }
});
