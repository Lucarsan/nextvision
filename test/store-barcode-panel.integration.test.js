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
    await f.api('/store/products', { method: 'POST', body: { name: 'Película 3D', barcode: '7891234567895', price_cents: 1500, cost_cents: 150 } }, 201);
    const scan = async code => { await page.keyboard.type(code, { delay: 4 }); await page.keyboard.press('Enter'); };

    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('50,00');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');

    // Olho: valores do caixa começam escondidos; mostrar/esconder fica salvo no navegador.
    const kpiColor = () => page.locator('.fs-kpis b').first().evaluate(el => getComputedStyle(el).color);
    assert.equal(await kpiColor(), 'rgba(0, 0, 0, 0)', 'valores escondidos por padrão');
    await page.getByRole('button', { name: 'Mostrar valores' }).click();
    assert.notEqual(await kpiColor(), 'rgba(0, 0, 0, 0)');
    await page.locator('.nv-sidebar [data-view="messages"]').click();
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.waitForSelector('#fsSale');
    assert.notEqual(await kpiColor(), 'rgba(0, 0, 0, 0)', 'a escolha continua ao voltar para o caixa');
    await page.getByRole('button', { name: 'Esconder valores' }).click();
    assert.equal(await kpiColor(), 'rgba(0, 0, 0, 0)');

    // Leitura sem clicar em nada: o produto entra na venda; bipar de novo soma a quantidade.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await scan('7891234567895');
    await page.waitForSelector('.fs-item');
    assert.match(await page.locator('#fsCart').innerText(), /Película 3D/);
    // Custo camuflado ao lado do código de barras, em azul: 1,50 → 000X1.5. Sem botão de ver custo.
    assert.equal(await page.locator('.fs-costcode').first().innerText(), '000X1.5');
    assert.equal(await page.locator('.fs-costcode').first().evaluate(el => getComputedStyle(el).color), 'rgb(29, 78, 216)');
    assert.equal(await page.getByRole('button', { name: /Ver custo/ }).count(), 0);
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

    // Comprovante: ícone de recibo na venda da lista (troco desta sessão aparece).
    await page.getByRole('button', { name: 'Imprimir comprovante da venda 1' }).click();
    await page.waitForFunction(() => /Venda nº 1/.test(window.FPSales.lastReceiptHtml || ''));
    const receipt = await page.evaluate(() => window.FPSales.lastReceiptHtml);
    assert.doesNotMatch(receipt, /000X/, 'código de custo não vai no comprovante');
    assert.match(receipt, /Película 3D/); assert.match(receipt, /3 x R\$\s?15,00/); assert.match(receipt, /Troco/); assert.match(receipt, /Não é documento fiscal/);
    if (process.env.FP_SHOT) { const p2 = await context.newPage(); await p2.setViewportSize({ width: 302, height: 700 }); await p2.setContent(receipt); await p2.screenshot({ path: process.env.FP_SHOT, fullPage: true }); await p2.close(); }
    assert.deepEqual(cash.sales[0].items.map(i => [i.name, i.quantity]), [['Película 3D', 3], ['Cabo USB-C', 2]]);

    // Digitação humana (lenta) não é tratada como leitura.
    await page.locator('#fsSearch').click();
    await page.keyboard.type('maria', { delay: 120 });
    assert.equal(await page.locator('#fsSearch').inputValue(), 'maria');

    // Itens frequentes e produtos do leitor juntos na mesma venda, nas duas ordens.
    await f.api('/store/sales/quick-items', { method: 'POST', body: { label: 'Conserto rápido', price_cents: 4000 } }, 201);
    await f.api('/store/sales/quick-items', { method: 'POST', body: { label: 'Xerox', price_cents: 50 } }, 201);
    await page.reload();
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    // 1) Item frequente primeiro, depois o leitor.
    await page.locator('[data-fs-quick]', { hasText: 'Conserto rápido' }).click();
    assert.equal(await page.locator('#fsSale [name="total"]').inputValue(), '40,00');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await scan('7891234567895');
    await page.waitForSelector('.fs-item');
    assert.equal(await page.locator('#fsSale [name="total"]').inputValue(), '55,00', 'produto (15) + item (40)');
    assert.match(await page.locator('#fsTotalLabel').innerText(), /produtos \+ itens/);
    assert.match(await page.locator("#fsSaleQ").innerText(), /Itens frequentes[\s\S]*40,00/); assert.match(await page.locator("#fsSaleTotals").innerText(), /Total da venda[\s\S]*55,00/);
    // 2) Mais itens depois do leitor: botões continuam disponíveis; quantidade do item frequente.
    assert.ok(await page.locator('[data-fs-quick]').count() >= 2, 'botões frequentes continuam com produtos na venda');
    await page.locator('[data-fs-quick]', { hasText: 'Xerox' }).click();
    await page.locator('[data-cart-id] .fs-qn').last().fill('10');
    await page.waitForFunction(() => document.querySelector('#fsSale [name="total"]').value === '60,00');
    // Desconto vale para a venda toda.
    await page.locator('#fsDiscount').fill('10%'); await page.locator('#fsDiscount').press('Enter');
    await page.waitForFunction(() => document.querySelector('#fsSale [name="total"]').value === '54,00');
    await page.locator('.fs-newsale').screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/venda-misturada.png' : undefined });
    await page.getByRole('button', { name: 'Não quis se identificar' }).click();
    await page.getByRole('button', { name: 'Registrar venda' }).click();
    await page.waitForFunction(() => /Venda #\d+ registrada: R\$\s*54,00/.test(document.getElementById('panelFeedback')?.textContent || ''));
    const mixed = (await f.api('/store/cash')).sales[0];
    assert.equal(mixed.total_cents, 5400);
    assert.deepEqual(mixed.items.map(i => [i.name, i.quantity]).sort(), [['Conserto rápido', 1], ['Película 3D', 1], ['Xerox', 10]]);
    assert.equal(mixed.items.reduce((a, i) => a + i.total_cents, 0), 5400, 'desconto distribuído entre todos os itens');
    assert.match(mixed.description, /Película 3D/); assert.match(mixed.description, /Xerox/);
    // Tudo limpo depois de registrar.
    assert.equal(await page.locator('.fs-item').count(), 0); assert.equal(await page.locator('[data-cart-id]').count(), 0);
    assert.equal(await page.locator('#fsSale [name="total"]').inputValue(), '');
    // 3) Leitor primeiro, depois item frequente; tirar o produto mantém o item.
    await scan('7891234567895'); await page.waitForSelector('.fs-item');
    await page.locator('[data-fs-quick]', { hasText: 'Conserto rápido' }).click();
    await page.waitForFunction(() => document.querySelector('#fsSale [name="total"]').value === '55,00');
    await page.locator('[data-fs-del]').first().click();
    await page.waitForFunction(() => document.querySelector('#fsSale [name="total"]').value === '40,00');
    assert.equal(await page.locator('[data-cart-id]').count(), 1);
    await page.locator('#fsQuickClear').click();
    await page.waitForFunction(() => document.querySelector('#fsSale [name="total"]').value === '' && !document.querySelector('#fsSale [name="total"]').readOnly);
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await f.cleanup(); }
});
