import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Painel: menu "Links úteis" abaixo de Visão geral, atalhos no topo, abas Links / Dívidas / Recibos.
test('painel: links úteis, atalhos do topo, dívidas e recibo', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    await context.route(/google\.com\/s2\/favicons/, r => r.abort());
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    const { api } = f;
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    await api('/store/tools/links', { method: 'POST', body: { name: 'Fornecedor de telas', url: 'fornecedor.com.br', categories: ['Fornecedores'] } }, 201);
    await api('/store/tools/links', { method: 'POST', body: { name: 'Consulta IMEI', url: 'imei.info', categories: ['Consultas'], keywords: 'roubado bloqueio' } }, 201);

    await page.goto(f.base + '/loja.html');
    // Menu: "Links úteis" logo abaixo de "Visão geral".
    await page.waitForSelector('.nv-menu [data-view="links"]');
    assert.deepEqual(await page.$$eval('.nv-menu button', b => b.slice(0, 3).map(x => x.textContent.trim())), ['Visão geral', 'Links úteis', 'Processos']);
    // Atalhos no topo: Caixa, Links úteis, Mensagens e "+ Atalho".
    await page.waitForSelector('#ftQuick .ft-qadd');
    assert.deepEqual(await page.$$eval('#ftQuick .ft-qbtn', b => b.map(x => x.lastElementChild.textContent.trim())), ['Caixa', 'Links úteis', 'Mensagens', 'Atalho']);
    await page.screenshot(shot('tools-1-topo'));

    await page.locator('#ftQuick [data-view="links"]').click();
    await page.waitForSelector('#ftLinkList .ft-link');
    assert.equal(await page.locator('.nv-top h1').textContent(), 'Links úteis');
    assert.equal(await page.locator('#ftQuick [data-view="links"]').getAttribute('class'), 'ft-qbtn active');
    // Busca por palavra-chave.
    await page.locator('#ftLinkQ').fill('roubado');
    await page.waitForFunction(() => document.querySelectorAll('#ftLinkList .ft-link').length === 1);
    await page.locator('#ftLinkQ').fill('');
    // Novo link pelo formulário; nome sugerido pelo endereço.
    await page.locator('[data-ft-link-new]').click();
    await page.locator('#ftLinkF [name=url]').fill('sefaz.ce.gov.br');
    assert.equal(await page.locator('#ftLinkF [name=name]').getAttribute('placeholder'), 'Sefaz');
    await page.locator('#ftLinkF [name=name]').fill('Sefaz CE');
    await page.locator('#ftLinkF [data-ft-addcat="Consultas"]').click();
    await page.locator('#ftLinkF button.nv-button:not([type=button])').click();
    await page.waitForFunction(() => document.querySelectorAll('#ftLinkList .ft-link').length === 3);
    // Repetido: confirma (aceito) e salva de novo.
    await page.locator('[data-ft-link-new]').click();
    await page.locator('#ftLinkF [name=url]').fill('https://www.imei.info/'); await page.locator('#ftLinkF [name=name]').fill('IMEI 2');
    await page.locator('#ftLinkF button.nv-button:not([type=button])').click();
    await page.waitForFunction(() => document.querySelectorAll('#ftLinkList .ft-link').length === 4);
    assert.ok((await api('/store/tools/links')).some(l => l.name === 'IMEI 2'), 'nome sugerido é trocado pelo digitado');
    // Fixar: vai para o começo.
    const sefaz = (await api('/store/tools/links')).find(l => l.name === 'Sefaz CE');
    assert.deepEqual(sefaz.categories, ['Consultas']); assert.equal(sefaz.url, 'https://sefaz.ce.gov.br/');
    await page.locator(`[data-ft-pin="${sefaz.id}"]`).click();
    await page.waitForFunction(id => document.querySelector('#ftLinkList .ft-link')?.dataset.id === id, sefaz.id);
    // Filtro por categoria.
    await page.locator('[data-ft-cat="Consultas"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#ftLinkList .ft-link').length === 2);
    await page.screenshot(shot('tools-2-links'));
    await page.locator('[data-ft-cat=""]').click();
    // Clique conta acesso (abre em outra aba).
    const [popup] = await Promise.all([context.waitForEvent('page'), page.locator(`[data-ft-open-link="${sefaz.id}"]`).click()]);
    await popup.close().catch(() => {});
    await page.waitForFunction(async () => true);
    for (let i = 0; i < 30 && (await api('/store/tools/links')).find(l => l.id === sefaz.id).clicks !== 1; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal((await api('/store/tools/links')).find(l => l.id === sefaz.id).clicks, 1);

    // Atalhos: acrescentar Estoque e o link da Sefaz.
    await page.locator('#ftQuick .ft-qadd').click();
    await page.locator('#ftQuickPick').selectOption('view:stock'); await page.locator('#ftQuickAdd').click();
    await page.locator('#ftQuickPick').selectOption('link:' + sefaz.id); await page.locator('#ftQuickAdd').click();
    await page.locator('#ftQuickPick').selectOption('url'); await page.locator('#ftQuickF [name=label]').fill('Banco'); await page.locator('#ftQuickF [name=url]').fill('banco.com.br'); await page.locator('#ftQuickAdd').click();
    await page.screenshot(shot('tools-3-atalhos-editar'));
    await page.locator('#ftQuickF button.nv-button:not([type=button])').click();
    await page.waitForFunction(() => document.querySelectorAll('#ftQuick .ft-qbtn').length === 7);
    assert.deepEqual(await page.$$eval('#ftQuick .ft-qbtn', b => b.map(x => x.lastElementChild.textContent.trim())), ['Caixa', 'Links úteis', 'Mensagens', 'Estoque', 'Sefaz CE', 'Banco', 'Atalho']);
    await page.screenshot(shot('tools-4-topo-novo'));
    // Atalho de tela troca a tela.
    await page.locator('#ftQuick [data-view="stock"]').click();
    await page.waitForFunction(() => document.querySelector('.nv-top h1').textContent === 'Estoque');
    await page.locator('#ftQuick [data-view="links"]').click();
    await page.waitForSelector('#ftLinkList .ft-link');

    // Dívidas.
    await page.locator('[data-ft-tab="debts"]').click();
    await page.locator('[data-ft-debt-new]').click();
    await page.locator('#ftDebtorF [name=name]').fill('Maria Souza'); await page.locator('#ftDebtorF [name=phone]').fill('85999990000');
    await page.locator('#ftDebtorF button.nv-button:not([type=button])').click();
    await page.waitForSelector('#ftItems tr[data-item]');
    const row = page.locator('#ftItems tr[data-item]').first();
    await row.locator('[data-k=who]').fill('Maria'); await row.locator('[data-k=description]').fill('Película 3D');
    await row.locator('[data-k=amount_cents]').fill('45,90'); await row.locator('[data-k=paid_cents]').fill('10'); await row.locator('[data-k=paid_cents]').press('Tab');
    await page.waitForFunction(() => /35,90/.test(document.querySelector('#ftFoot').textContent));
    await page.locator('#ftAddItem').click();
    await page.waitForFunction(() => document.querySelectorAll('#ftItems tr[data-item]').length === 2);
    const r2 = page.locator('#ftItems tr[data-item]').nth(1);
    await r2.locator('[data-k=description]').fill('Capa'); await r2.locator('[data-k=amount_cents]').fill('30'); await r2.locator('[data-k=amount_cents]').press('Tab');
    await page.waitForFunction(() => /65,90/.test(document.querySelector('#ftFoot').textContent));
    assert.match(await page.locator('#ftDebtWa').getAttribute('href'), /^https:\/\/wa\.me\/5585999990000\?text=.*Saldo%20devedor/);
    await page.screenshot(shot('tools-5-divida'));
    await page.locator('#ftDialog [data-ft-close]').first().click();
    await page.waitForFunction(() => /R\$\s?65,90/.test(document.querySelector('#ftDebtList').textContent) && /Pessoas devendo\s*1/.test(document.querySelector('#ftDebtKpis').textContent));
    const debts = await api('/store/tools/debts');
    assert.equal(debts[0].balance_cents, 6590); assert.equal(debts[0].items[0].who, 'Maria');
    await page.screenshot(shot('tools-6-dividas'));

    // Recibo: valor por extenso e emissor salvo para a loja.
    await page.locator('[data-ft-tab="receipts"]').click();
    await page.locator('#ftRc [name=value]').pressSequentially('123456');
    await page.locator('#ftRc [name=payer]').fill('Maria Souza');
    await page.locator('#ftRc [name=ref]').fill('troca de tela');
    await page.locator('#ftRc [name=city]').fill('Fortaleza');
    await page.locator('#ftRc [name=form][value=Pix]').check();
    assert.equal(await page.locator('#ftRc [name=value]').inputValue(), '1.234,56');
    const prev = await page.locator('#ftRcPrev').textContent();
    assert.match(prev, /mil duzentos e trinta e quatro reais e cinquenta e seis centavos/);
    assert.match(prev, /Forma de pagamento: Pix/); assert.match(prev, /Fortaleza, \d+ de/);
    await page.waitForFunction(() => /Salvo/.test(document.getElementById('ftIssuerSaved').textContent));
    assert.equal((await api('/store/tools/settings')).receipt_issuer.city, 'Fortaleza');
    await page.screenshot(shot('tools-7-recibo'), { fullPage: true });

    // Celular: atalhos rolam numa linha; "Links úteis" fica em "Mais".
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-ft-tab="links"]').click();
    await page.waitForSelector('#ftLinkList .ft-link');
    await page.screenshot(shot('tools-8-celular'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'sem rolagem lateral');
    await page.locator('.nv-phone-nav [data-view="more"]').click();
    await page.waitForSelector('#sectionContent [data-view="links"]');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
