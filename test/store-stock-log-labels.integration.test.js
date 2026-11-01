import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

// Toda mudança de estoque entra no histórico, com saldo antes e depois e quem fez.
test('histórico do estoque registra cada mudança; fila de etiquetas', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, foreignToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    const cabo = await api('/store/products', { method: 'POST', body: { name: 'Cabo USB-C', barcode: 'CABO-1', price_cents: 2500, cost_cents: 900, stock_qty: 5 } }, 201);
    await api(`/store/products/${cabo.id}/stock`, { method: 'POST', body: { add: 3, unit_cost_cents: 850 } });
    await api(`/store/products/${cabo.id}/stock`, { method: 'POST', body: { add: -2 } });
    await api('/store/products/' + cabo.id, { method: 'PATCH', body: { stock_qty: 10 } });
    await api('/store/products/' + cabo.id, { method: 'PATCH', body: { name: 'Cabo USB-C 1m' } }); // sem mudar estoque: não entra no log
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const sale = (await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ product_id: cabo.id, quantity: 2 }] } }, 201)).sale;
    await api(`/store/sales/${sale.id}/cancel`, { method: 'POST', body: { reason: 'cliente desistiu' } });
    await api('/store/products/' + cabo.id, { method: 'DELETE' });
    await api(`/store/products/${cabo.id}/restore`, { method: 'POST', body: {} });

    const log = (await api('/store/stock/log?product_id=' + cabo.id)).rows.reverse();
    assert.deepEqual(log.map(m => [m.kind, m.quantity, m.stock_before, m.stock_after]), [
      ['entry', 5, null, 5], ['entry', 3, 5, 8], ['adjust', -2, 8, 6], ['edit', 4, 6, 10],
      ['sale', -2, 10, 8], ['cancel', 2, 8, 10], ['delete', 0, 10, 10], ['restore', -10, 10, 0]
    ]);
    assert.equal(log[1].unit_cost_cents, 850);
    assert.equal(log[4].sale_number, sale.sale_number);
    assert.match(log[5].note, /cliente desistiu/);
    assert.match(log[6].note, /excluído com 10/);
    assert.ok(log.every(m => m.who && m.name === 'Cabo USB-C 1m'));
    // Filtros: tipo e texto; paginação.
    assert.deepEqual((await api('/store/stock/log?kind=sale')).rows.map(m => m.quantity), [-2]);
    assert.equal((await api('/store/stock/log?q=cabo usb')).rows.length, 8);
    const page1 = await api('/store/stock/log?limit=3');
    assert.equal(page1.rows.length, 3); assert.equal(page1.more, true);
    const page2 = await api('/store/stock/log?limit=3&before=' + encodeURIComponent(page1.rows[2].created_at));
    assert.equal(page2.rows[0].kind, log[4].kind);
    assert.equal((await request('/store/stock/log?kind=xpto')).status, 400);
    assert.equal((await request('/store/stock/log', { token: foreignToken })).status, 403, 'outra loja sem caixa ligado');

    // Modelos (película): entrada e exclusão de modelo também entram.
    const pel = await api('/store/products', { method: 'POST', body: { name: 'Película', barcode: 'PEL-G', price_cents: 1500, ask_variant: true } }, 201);
    const r = await api(`/store/products/${pel.id}/stock`, { method: 'POST', body: { add: 10, variant_name: 'Galaxy A12' } });
    await api(`/store/products/${pel.id}/variants/${r.variant.id}`, { method: 'DELETE' });
    assert.deepEqual((await api('/store/stock/log?product_id=' + pel.id)).rows.reverse().map(m => [m.kind, m.variant, m.stock_before, m.stock_after]),
      [['entry', 'Galaxy A12', 0, 10], ['delete', 'Galaxy A12', 10, 10]]);

    // Fila de etiquetas: soma, define, lista e sai ao marcar como impressa. Produto sem código não entra.
    const capa = await api('/store/products', { method: 'POST', body: { name: 'Capinha', barcode: 'CAPA-1', price_cents: 3000 } }, 201);
    const semCodigo = await api('/store/products', { method: 'POST', body: { name: 'Avulso', price_cents: 100 } }, 201);
    await api('/store/labels', { method: 'POST', body: { product_id: capa.id, add: 1 } });
    assert.equal((await api('/store/labels', { method: 'POST', body: { product_id: capa.id, add: 2 } })).labels_pending, 3);
    await api('/store/labels', { method: 'POST', body: { product_id: cabo.id, qty: 1 } });
    assert.deepEqual((await api('/store/labels')).map(p => [p.name, p.labels_pending]), [['Capinha', 3], ['Cabo USB-C 1m', 1]]);
    assert.equal((await request('/store/labels', { method: 'POST', body: { product_id: semCodigo.id, add: 1 } })).status, 404);
    assert.equal((await request('/store/labels', { method: 'POST', body: { product_id: capa.id } })).status, 400);
    assert.equal((await api('/store/labels/printed', { method: 'POST', body: { product_ids: [capa.id] } })).cleared, 1);
    assert.deepEqual((await api('/store/labels')).map(p => p.name), ['Cabo USB-C 1m']);
    await api('/store/labels', { method: 'POST', body: { product_id: cabo.id, qty: 0 } });
    assert.deepEqual(await api('/store/labels'), []);
  } finally { await f.cleanup(); }
});

// Painel: Estoque no menu (sem abrir o caixa), entrada com "1 etiqueta só" na fila, folha com vários produtos e histórico.
test('painel: Estoque no menu, fila de etiquetas e histórico', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => process.env.SHOT_DIR ? { path: process.env.SHOT_DIR + '/' + name + '.png' } : {};
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 950 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    const capa = await f.api('/store/products', { method: 'POST', body: { name: 'Capinha A12', barcode: 'CAPA-A12', price_cents: 3000, stock_qty: 4 } }, 201);

    await page.goto(f.base + '/loja.html');
    // Menu: Estoque logo abaixo de Caixa, e abre sem caixa aberto.
    await page.waitForSelector('.nv-sidebar [data-view="stock"]');
    const menu = await page.locator('.nv-sidebar .nv-menu button').evaluateAll(bs => bs.map(b => b.dataset.view));
    assert.equal(menu[menu.indexOf('cash') + 1], 'stock');
    await page.locator('.nv-sidebar [data-view="stock"]').click();
    await page.waitForSelector('#fsStockPage #fsProdList .fs-prod');
    assert.equal(await page.locator('.nv-top h1').innerText(), 'Estoque');
    assert.equal(await page.locator('#editorDialog').evaluate(d => d.open), false, 'é página, não janela');
    await page.screenshot(shot('estoque-pagina'));

    // Entrada em lote de produto novo: 12 unidades, "1 etiqueta só" + fila.
    await page.getByRole('tab', { name: 'Entrada rápida' }).click();
    await page.locator('#fsEnScan').pressSequentially('7896666666660\n', { delay: 5 });
    await page.waitForSelector('#fsEnNew');
    await page.locator('#fsEnNew [name="name"]').fill('Fone P2 Kaidi');
    await page.locator('#fsEnNew [name="n"]').fill('12');
    await page.locator('#fsEnNew [name="price"]').fill('25,00');
    await page.locator('#fsEnNew [name="lab_how"][value="one"]').check();
    await page.locator('#fsEnNew [name="lab_queue"]').check();
    await page.screenshot(shot('estoque-entrada-etiqueta'));
    await page.getByRole('button', { name: 'Cadastrar e somar ao estoque' }).click();
    await page.waitForFunction(() => document.querySelector('#fsEnLog')?.innerText.includes('12 unidade'));
    assert.deepEqual((await f.api('/store/labels')).map(p => [p.name, p.labels_pending]), [['Fone P2 Kaidi', 1]]);

    // Aba Etiquetas: adiciona outro produto pelo leitor, ajusta a quantidade e imprime os dois na mesma folha.
    await page.getByRole('tab', { name: 'Etiquetas' }).click();
    await page.waitForSelector('#fsLbList [data-lb]');
    await page.locator('#fsLbQ').pressSequentially('CAPA-A12\n', { delay: 5 });
    await page.waitForFunction(() => document.querySelectorAll('#fsLbList [data-lb]').length === 2);
    await page.locator(`[data-lb="${capa.id}"] [data-lb-q="1"]`).click();
    await page.waitForFunction(() => document.querySelector('#fsLbFoot')?.innerText.includes('3 etiqueta(s) de 2 produto(s)'));
    await page.screenshot(shot('estoque-etiquetas'));
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#fsLbPrint').click()]);
    await popup.waitForLoadState();
    assert.equal(await popup.locator('.lb').count(), 3, 'uma folha com as 3 etiquetas');
    assert.deepEqual(await popup.locator('.lb .nm').allInnerTexts(), ['Fone P2 Kaidi', 'Capinha A12', 'Capinha A12']);
    await popup.locator('#skip').fill('4');
    assert.equal(await popup.locator('.skip').count(), 4, 'pula posições já usadas da folha');
    await popup.screenshot(shot('estoque-folha'));
    await popup.close();
    await page.locator('#fsLbClear').click();
    await page.waitForFunction(() => document.querySelector('#fsLbList')?.innerText.includes('A fila está vazia'));
    assert.deepEqual(await f.api('/store/labels'), []);

    // Histórico: a entrada aparece com saldo antes/depois e quem fez; "Histórico" de um produto filtra.
    await page.getByRole('tab', { name: 'Histórico' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#fsLogBody tr').length >= 2);
    const text = await page.locator('#fsLogBody').innerText();
    assert.match(text, /Fone P2 Kaidi[\s\S]*Entrada[\s\S]*\+12[\s\S]*— → 12/);
    await page.screenshot(shot('estoque-historico'));
    await page.getByRole('tab', { name: 'Produtos' }).click();
    await page.locator(`[data-fs-hist="${capa.id}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('#fsLogBody tr').length === 1);
    assert.match(await page.locator('#fsLogBody').innerText(), /Capinha A12/);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
