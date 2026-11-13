import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Caixa: guardar a venda para pagar depois (com o pedido ao vivo aberto junto) e receber pela lista "A receber".
test('caixa guarda venda a receber com pedido ao vivo e recebe depois', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'pet' } });
    await f.api('/processes', { method: 'POST', body: { name: 'Banho e tosa', steps: ['Recebido', 'Banho', 'Pronto'] } }, 201);
    const cli = await f.api('/customers', { method: 'POST', body: { name: 'Afonso Filho', phone: '85997106788' } }, 201);
    await f.api('/customers/' + cli.id + '/pets', { method: 'POST', body: { name: 'Dom', species: 'Cão', breed: 'Yorkshire Terrier', size: 'Médio' } }, 201);
    await f.api('/store/sales/service-items', { method: 'POST', body: { name: 'Banho de cheiro', price_cents: 4300, price_rules: { size: [{ name: 'Médio', cents: 700 }] } } }, 201);

    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');
    assert.equal(await page.locator('#fsPending').isVisible(), false, 'sem nada a receber, a lista não aparece');

    await page.locator('#fsSearch').fill('afonso');
    await page.locator('[data-fs-pick]').first().click();
    await page.getByRole('button', { name: 'Serviço', exact: true }).click();
    await page.waitForSelector('#fsSvcQuick:has-text("preços para Dom")');
    await page.locator('[data-fs-svc]', { hasText: 'Banho de cheiro' }).click();
    await page.waitForSelector('[data-fs-svc-price="0"]');
    await page.locator('#fsLiveOn').check();
    await page.screenshot(shot('a-receber-venda'));
    await page.getByRole('button', { name: /Pagar depois/ }).click();
    await page.waitForSelector('#fsPending:not([hidden]) [data-pend-pay]');
    // O pedido ao vivo aberto junto já oferece o envio do link; fechar sem enviar.
    await page.waitForSelector('#shareDialog[open]');
    assert.match(await page.locator('#shareDialog').innerText(), /Enviar o acompanhamento para Afonso/);
    await page.locator('#shareDialog [data-share-close]').click();
    await page.waitForFunction(() => !document.querySelector('#shareDialog[open]'));
    assert.match(await page.locator('#fsLast').innerText(), /A receber" #1[\s\S]*R\$\s*50,00[\s\S]*Pedido \d+ aberto/);
    assert.match(await page.locator('#fsLast input').inputValue(), /^http/);
    assert.match(await page.locator('#fsPending').innerText(), /A receber\s*1[\s\S]*#1[\s\S]*Afonso Filho[\s\S]*Dom[\s\S]*Banho de cheiro[\s\S]*pedido \d+\s*na fila[\s\S]*R\$\s*50,00/);
    assert.equal(await page.locator('[data-fs-svc-price]').count(), 0, 'formulário limpo');
    const order = (await f.db.query('SELECT details FROM orders WHERE tenant_id=$1', [f.tenant])).rows;
    assert.equal(order.length, 1); assert.equal(order[0].details.pet_name, 'Dom'); assert.equal(order[0].details.service, 'Banho de cheiro');
    // A escolha do pedido ao vivo fica lembrada para a próxima venda.
    assert.equal(await page.locator('#fsLiveOn').isChecked(), true);
    await page.screenshot(shot('a-receber-lista'));

    // Tirar um item pelo ×: guarda outra venda com dois serviços e tira o segundo.
    await f.api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, items: [{ service: 'Banho', unit_price_cents: 4000 }, { service: 'Tosa higiênica', unit_price_cents: 2500 }] } }, 201);
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.waitForSelector('[data-pend-rm]');
    page.once('dialog', d => d.accept());
    await page.locator('.fs-pend-item', { hasText: 'Tosa higiênica' }).locator('button').click();
    await page.waitForFunction(() => { const n = document.querySelector('#fsPending'); return n && !n.innerText.includes('Tosa higiênica'); });
    assert.match(await page.locator('#fsPending').innerText(), /#2[\s\S]*R\$\s*40,00/);
    await f.api(`/store/sales/pending/${(await f.api('/store/sales/pending')).find(x => x.number === 2).id}/cancel`, { method: 'POST', body: { reason: 'Teste' } });
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.waitForFunction(() => { const n = document.querySelector('#fsPending [data-pend-pay]')?.closest('#fsPending'); return n && !n.innerText.includes('#2'); });
    // Receber em dinheiro, com troco.
    await page.locator('[data-pend-pay]').first().click();
    const dlg = page.locator('#editorDialog');
    await dlg.locator('[name="method"][value="cash"]').check({ force: true });
    await dlg.locator('[name="received"]').fill('100');
    assert.match(await dlg.locator('[data-pay-change]').innerText(), /Troco:\s*R\$\s*50,00/);
    await dlg.locator('[name="print"]').uncheck();
    await page.screenshot(shot('a-receber-receber'));
    await dlg.getByRole('button', { name: 'Confirmar recebimento' }).click();
    await page.waitForSelector('#fsPending[hidden]', { state: 'attached' });
    assert.match(await page.locator('.fs-col-report').innerText(), /Afonso Filho[\s\S]*R\$\s*50,00/);
    const sale = (await f.db.query("SELECT payment_method,total_cents,order_id FROM sales WHERE tenant_id=$1", [f.tenant])).rows;
    assert.equal(sale.length, 1); assert.equal(sale[0].payment_method, 'cash'); assert.equal(sale[0].total_cents, 5000); assert.ok(sale[0].order_id);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
