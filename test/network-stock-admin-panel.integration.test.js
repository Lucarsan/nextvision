import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Painel da rede → Estoque: abas de gestão. Dono vê "Valor do estoque"; supervisor não.
test('painel da rede: abas do estoque (cadastro, entrada, etiquetas, preços, valor)', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => process.env.SHOT_DIR ? { path: process.env.SHOT_DIR + '/' + name + '.png', fullPage: true } : {};
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const { api, request, tenant, masterToken, base } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'aud-pan', hostname: 'aud-pan.example.test' } }, 201);
    const dep = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Depósito', slug: 'aud-pan-dep' } }, 201);
    for (const [id, label] of [[tenant, 'Maracanaú'], [dep.id, 'Depósito']]) {
      await api(`/master/tenants/${id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: label } });
      await api('/master/tenants/' + id, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    }
    await api(`/master/tenants/${dep.id}/depot`, { method: 'PATCH', token: masterToken, body: { depot: true } });
    const people = `/master/networks/${net.id}/people`;
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'g@aud-pan.test', function: 'dono', password: 'senha-do-gabriel-123' } }, 201);
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Dani', email: 'd@aud-pan.test', function: 'supervisor', unit_ids: [tenant], password: 'senha-da-dani-1234', pin: '5555' } }, 201);
    const login = async (email, password) => (await request('/auth/login', { method: 'POST', token: null, body: { email, password } })).data.token;
    const dono = await login('g@aud-pan.test', 'senha-do-gabriel-123'), sup = await login('d@aud-pan.test', 'senha-da-dani-1234');

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addInitScript(v => sessionStorage.setItem('nv_token', v), dono);
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/rede.html#estoque');
    await page.waitForSelector('#nsTabs button[data-t="value"]');
    assert.deepEqual(await page.$$eval('#nsTabs button', b => b.map(x => x.textContent)),
      ['Estoque por unidade', 'Produtos', 'Entrada rápida', 'Etiquetas', 'Gerar códigos', 'Reposição', 'Histórico', 'Preços', 'Valor do estoque']);

    // Produtos: cadastra uma peça com 3 chegando no depósito.
    await page.click('#nsTabs button[data-t="prod"]');
    await page.waitForSelector('#npSave');
    await page.fill('#npCode', '3622'); await page.fill('#npName', 'ANEL SOLITARIO'); await page.fill('#npFam', 'ANEIS');
    await page.fill('#npPrice', '89,90'); await page.fill('#npCost', '30,00');
    await page.selectOption('#npUnit', dep.id); await page.fill('#npQty', '3'); await page.selectOption('#npLab', 'each');
    await page.click('#npSave');
    await page.waitForFunction(() => /cadastrada nas 2 unidades/.test(document.getElementById('npMsg').textContent));
    await page.waitForSelector('#prRows tr[data-k="3622"]');
    await page.screenshot(shot('rede-estoque-produtos'));

    // Entrada rápida em Maracanaú: bipa o código duas vezes.
    await page.click('#nsTabs button[data-t="entry"]');
    await page.waitForSelector('#enScan');
    await page.selectOption('#enUnit', tenant);
    for (let i = 0; i < 2; i++) { await page.fill('#enScan', '3622'); await page.press('#enScan', 'Enter'); await page.waitForFunction(n => document.querySelector('.enQ')?.value === String(n), i + 1); }
    await page.click('#enGo');
    await page.waitForFunction(() => /Entrada feita: 2 peça/.test(document.getElementById('enMsg').textContent));
    assert.equal((await f.db.query('SELECT stock_qty FROM products WHERE tenant_id=$1 AND code=$2', [tenant, '3622'])).rows[0].stock_qty, 2);

    // Etiquetas do depósito: 3 na fila (uma por unidade da entrada).
    await page.click('#nsTabs button[data-t="labels"]');
    await page.selectOption('#lbUnit', dep.id);
    await page.waitForSelector('#lbRows tr[data-k="3622"]');
    assert.equal(await page.inputValue('#lbRows .lbQ'), '3');

    // Preços: muda o preço da peça; vale nas duas unidades.
    await page.click('#nsTabs button[data-t="prices"]');
    await page.waitForSelector('#ppRows tr[data-k="3622"] .ppIn');
    await page.fill('#ppRows tr[data-k="3622"] .ppIn', '99,90'); await page.click('#ppRows tr[data-k="3622"] .ppSave');
    await page.waitForFunction(() => /Preço salvo em 2/.test(document.getElementById('ppMsg').textContent));
    assert.equal((await f.db.query("SELECT count(*)::int n FROM products WHERE code='3622' AND price_cents=9990")).rows[0].n, 2);

    // Valor do estoque: depósito com 3 a R$ 30 de custo.
    await page.click('#nsTabs button[data-t="value"]');
    await page.waitForSelector('#vlFoot tr');
    assert.match(await page.textContent('#vlRows'), /Depósito.*R\$\s90,00/s);
    await page.screenshot(shot('rede-estoque-valor'));

    // Histórico mostra as entradas.
    await page.click('#nsTabs button[data-t="log"]');
    await page.waitForFunction(() => document.querySelectorAll('#lgRows tr').length >= 2 && /Entrada/.test(document.getElementById('lgRows').textContent));
    assert.deepEqual(errors, []);

    // Supervisor: sem "Valor do estoque".
    const sctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await sctx.addInitScript(v => sessionStorage.setItem('nv_token', v), sup);
    const sp = await sctx.newPage(); sp.on('pageerror', e => errors.push(e.message));
    await sp.goto(base + '/rede.html#estoque');
    await sp.waitForFunction(() => document.querySelectorAll('#nsTabs button').length === 8);
    assert.equal(await sp.$('#nsTabs button[data-t="value"]'), null);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
