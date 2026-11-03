import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture, FIXTURE_ADMIN } from './helpers/store-fixture.js';

// Painel: capa contada no total (bipa → pergunta o modelo), vários modelos de uma vez, senha do admin para editar,
// película de brinde no serviço, custos e saldo líquido, reajuste em lote e histórico do cliente.
test('painel: capas no total, senha do admin, brinde, custos, preços e histórico do cliente', {
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
    page.on('dialog', d => d.accept());
    const { api } = f;
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    const capa = await api('/store/products', { method: 'POST', body: { name: 'CAPA MODELOS COMUNS', barcode: '2000000000725', price_cents: 2000, cost_cents: 600, stock_qty: 349 } }, 201);
    const pel = await api('/store/products', { method: 'POST', body: { name: 'Película 3D', barcode: '2000000000015', price_cents: 2000, cost_cents: 100, stock_qty: 504 } }, 201);
    const cli = await api('/customers', { method: 'POST', body: { name: 'Maria Souza', phone: '85999990000' } }, 201);

    await page.goto(f.base + '/loja.html');
    // 1) Estoque → Editar a capa pede a senha do admin; marca "pergunta o modelo, estoque no total".
    await page.locator('.nv-sidebar [data-view="stock"]').click();
    await page.waitForSelector('#fsProdList .fs-prod');
    await page.locator('#fsProdSearch').fill('capa'); await page.waitForFunction(() => document.querySelectorAll('#fsProdList .fs-prod').length === 1);
    await page.locator('[data-fs-edit]').first().click();
    await page.waitForSelector('#fsAdminDialog[open]');
    await page.screenshot(shot('admin-senha'));
    await page.locator('#fsAdminF [name=login]').fill(FIXTURE_ADMIN.login); await page.locator('#fsAdminF [name=password]').fill('errada');
    await page.locator('#fsAdminF button.nv-button').first().click();
    await page.waitForFunction(() => /incorret/i.test(document.querySelector('#fsAdminF [role=alert]').textContent));
    await page.locator('#fsAdminF [name=password]').fill(FIXTURE_ADMIN.password);
    await page.locator('#fsAdminF button.nv-button').first().click();
    await page.waitForSelector('#fsProd');
    await page.locator('#fsProd [name=ask_variant]').check();
    assert.equal(await page.locator('#fsProd [name=variant_stock][value=total]').isChecked(), true, 'padrão: estoque no total');
    assert.equal(await page.locator('#fsStockField').isVisible(), true, 'mostra o estoque total');
    await page.screenshot(shot('produto-modelos-total'));
    await page.locator('#fsProd button.nv-button').click();
    await page.waitForFunction(() => /Pergunta o modelo/.test(document.querySelector('#fsProdList').textContent));
    let p = (await api('/store/products?q=capa'))[0];
    assert.equal(p.ask_variant, true); assert.equal(p.variant_stock, 'total'); assert.equal(p.stock_qty, 349);
    // A película também (liberação de 15 min: não pede a senha de novo).
    await page.locator('#fsProdSearch').fill('pelicula'); await page.waitForFunction(() => /Película 3D/.test(document.querySelector('#fsProdList').textContent) && document.querySelectorAll('#fsProdList .fs-prod').length === 1);
    await page.locator('[data-fs-edit]').first().click();
    await page.waitForSelector('#fsProd'); assert.equal(await page.locator('#fsAdminDialog[open]').count(), 0);
    await page.locator('#fsProd [name=ask_variant]').check(); await page.locator('#fsProd button.nv-button').click();
    await page.waitForFunction(() => /Pergunta o modelo/.test(document.querySelector('#fsProdList').textContent));

    // 2) Vários modelos de uma vez.
    await page.locator('#fsProdSearch').fill('capa'); await page.waitForFunction(() => document.querySelectorAll('#fsProdList [data-fs-vars]').length === 1 && /CAPA/.test(document.querySelector('#fsProdList').textContent));
    await page.locator('[data-fs-vars]').first().click();
    await page.locator('#fsVarMany').click();
    await page.locator('#fsMany [name=t]').fill('Galaxy A12 = 5\niPhone 11 x3\nRedmi Note 13');
    assert.match(await page.locator('#fsManyInfo').innerText(), /3 modelo\(s\), 9 unidade\(s\).*349 para 358/);
    await page.screenshot(shot('varios-modelos'));
    await page.locator('#fsMany button.nv-button').click();
    await page.waitForFunction(() => /358/.test(document.querySelector('#panelFeedback')?.textContent || ''));
    assert.equal((await api('/store/products?q=capa'))[0].stock_qty, 358);

    // Volta para a lista de modelos: o total aparece e os modelos lançados estão lá.
    await page.waitForFunction(() => /Estoque contado no total: 358/.test(document.querySelector('#editorDialog').textContent));
    await page.keyboard.press('Escape');
    // 3) Caixa: bipar a capa pergunta o modelo; a venda tira do total.
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');
    await page.keyboard.type('2000000000725', { delay: 4 }); await page.keyboard.press('Enter');
    await page.waitForSelector('#fsVar');
    assert.match(await page.locator('#fsVarList').innerText(), /Galaxy A12/);
    await page.locator('#fsVar [name=m]').fill('Galaxy A32'); await page.locator('#fsVar button.nv-button').click();
    await page.waitForFunction(() => /Galaxy A32/.test(document.querySelector('#fsCart').textContent));
    await page.getByRole('button', { name: 'Não quis se identificar' }).click();
    await page.getByRole('button', { name: 'Registrar venda' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.fs-col-report .fs-sale').length === 1);
    assert.equal((await api('/store/products?q=capa'))[0].stock_qty, 357);
    assert.ok((await api('/store/stock/restock')).some(r => r.variant === 'Galaxy A32' && r.pending === 1));

    // 4) Serviço com película de brinde.
    await page.getByRole('button', { name: 'Serviço', exact: true }).click();
    await page.locator('#fsSvcName').fill('Troca de tela'); await page.locator('#fsSvcModel').fill('Galaxy A12');
    await page.locator('#fsSvcPrice').fill('250,00'); await page.locator('#fsSvcCost').fill('90,00');
    await page.locator('#fsSvcWarranty').selectOption('90');
    await page.locator('#fsSvcGiftQ').click();
    await page.locator('#fsSvcGiftList button', { hasText: 'Película 3D' }).click();
    await page.waitForSelector('#fsVar'); await page.locator('#fsVar [name=m]').fill('Galaxy A12'); await page.locator('#fsVar button.nv-button').click();
    await page.waitForSelector('#fsSvcGiftOff');
    assert.match(await page.locator('#fsSvcProfit').innerText(), /159,00.*brinde|brinde[\s\S]*159,00/);
    await page.locator('#fsCustomerBox input').first().fill('maria');
    await page.locator('#fsCustomerBox button', { hasText: 'Maria Souza' }).first().click();
    await page.screenshot(shot('servico-brinde'));
    await page.getByRole('button', { name: 'Registrar serviço' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.fs-col-report .fs-sale').length === 2);
    assert.equal((await api('/store/products?q=pelicula'))[0].stock_qty, 503);

    // 5) Custos e saldo líquido: capa 6,00 + tela 90,00 + película 1,00 = 97,00.
    await page.waitForFunction(() => /Custos[\s\S]*97,00/.test(document.querySelector('.fs-kpis')?.textContent || ''));
    assert.deepEqual(await page.$$eval('.fs-kpis > div > small', x => x.map(e => e.textContent.replace(/ \(.*/, ''))), ['Entradas', 'Custos', 'Dinheiro na gaveta', 'Despesas', 'Saldo do dia']);
    const cashNow = await api('/store/cash');
    assert.match(await page.locator('.fs-kpis').innerText(), new RegExp('Saldo do dia\\s*R\\$\\s?' + (cashNow.summary.net_cents / 100).toFixed(2).replace('.', ',')));
    // Relatório do caixa: custos por item e saldo líquido.
    await page.locator('#fsPrint').click();
    await page.waitForFunction(() => !!window.FPSales.lastReportHtml);
    const repHtml = await page.evaluate(() => window.FPSales.lastReportHtml);
    assert.match(repHtml, /Custos \(o que repor\)/); assert.match(repHtml, /Entradas[\s\S]*Custos[\s\S]*Dinheiro na gaveta[\s\S]*Despesas[\s\S]*Saldo do dia/); assert.doesNotMatch(repHtml, /Saídas|Saldo líquido/); assert.match(repHtml, /97,00/);
    assert.match(repHtml, /peça do serviço/); assert.match(repHtml, /brinde/);
    { const p2 = await context.newPage(); await p2.setContent(repHtml); await p2.screenshot({ ...shot('relatorio-custos'), fullPage: true }); await p2.close(); }
    assert.equal(await page.locator('#fsCosts').count(), 0, 'sem quadro de custos detalhado no painel');
    await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot(shot('caixa-custos'));

    // 6) Preços: reajuste de 10% só nas capas (prévia, aplicar, desfazer).
    await page.locator('.nv-sidebar [data-view="stock"]').click();
    await page.getByRole('tab', { name: 'Preços' }).click();
    await page.locator('#fsRep [name=pct]').fill('10');
    await page.locator('#fsRep [name=scope][value=selected]').check();
    await page.locator('#fsPkQ').fill('capa');
    await page.waitForFunction(() => document.querySelectorAll('#fsPkList .fs-pk').length === 1);
    await page.locator('#fsPkList input').check();
    await page.getByRole('button', { name: 'Ver prévia' }).click();
    await page.waitForFunction(() => /22,00/.test(document.querySelector('#fsRepOut').textContent));
    assert.equal((await api('/store/products?q=capa'))[0].price_cents, 2000);
    await page.getByRole('button', { name: 'Aplicar reajuste' }).click();
    await page.waitForFunction(() => /Aplicado/.test(document.querySelector('#fsRepOut').textContent));
    assert.equal((await api('/store/products?q=capa'))[0].price_cents, 2200);
    await page.screenshot(shot('precos'));
    await page.locator('[data-undo]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('[data-undo]').length === 0);
    assert.equal((await api('/store/products?q=capa'))[0].price_cents, 2000);

    // 7) Histórico do cliente pela aba Clientes.
    await page.locator('.nv-sidebar [data-view="customers"]').click();
    await page.locator('[data-history-customer]').first().click();
    await page.waitForSelector('#chList .ch-card');
    const hist = await page.locator('#chDialog').innerText();
    assert.match(hist, /Maria Souza/); assert.match(hist, /Troca de tela/); assert.match(hist, /Garantias valendo/); assert.match(hist, /brinde/i); assert.match(hist, /Crédito|Pix|Dinheiro|Débito/);
    await page.screenshot(shot('historico-cliente'));
    await page.locator('#chSearch').fill('bateria');
    assert.equal(await page.locator('#chList .ch-card:visible').count(), 0);
    // 8) Configurações → Relatórios: fechado até digitar a senha do admin.
    await page.keyboard.press('Escape');
    await f.api('/store/reports/settings', { method: 'PATCH', admin: true, body: { report_email: 'pai@example.test', report_daily: true, report_weekly: true, report_monthly: true } });
    const page2 = await context.newPage(); page2.on('pageerror', e => errors.push(e.message));
    await page2.goto(f.base + '/loja.html'); await page2.locator('.nv-sidebar [data-view="settings"]').click();
    await page2.locator('.fp-tabs [data-tab="Relatórios"]').click();
    await page2.waitForSelector('#reportUnlock');
    assert.doesNotMatch(await page2.locator('#sectionContent').innerText(), /pai@example\.test/);
    await page2.screenshot(shot('relatorios-bloqueado'));
    await page2.locator('#reportUnlock').click();
    await page2.locator('#fsAdminF [name=login]').fill(FIXTURE_ADMIN.login); await page2.locator('#fsAdminF [name=password]').fill(FIXTURE_ADMIN.password);
    await page2.locator('#fsAdminF button.nv-button').first().click();
    await page2.waitForSelector('#reportForm');
    assert.equal(await page2.locator('#reportForm [name=report_email]').inputValue(), 'pai@example.test');
    await page2.locator('#reportLock').click(); await page2.waitForSelector('#reportUnlock');
    assert.deepEqual(errors, []);
    void cli; void capa; void pel; void p;
  } finally { await browser?.close(); await f.cleanup(); }
});
