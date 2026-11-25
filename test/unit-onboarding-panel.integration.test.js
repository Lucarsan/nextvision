import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Painel da rede → Implantação (dono marca item da rede) e Central → Redes → Implantação das unidades.
test('implantação no painel da rede e na central', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => process.env.SHOT_DIR ? { path: process.env.SHOT_DIR + '/' + name + '.png', fullPage: true } : {};
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const { api, request, tenant, foreignTenant, masterToken, base } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'aud-obp', hostname: 'aud-obp.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Grand Shopping' } });
    await api(`/master/tenants/${foreignTenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Sobral' } });
    const people = `/master/networks/${net.id}/people`;
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'g@aud-obp.test', function: 'dono', password: 'senha-do-gabriel-123' } }, 201);
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Ana', function: 'vendedora', unit_id: tenant, pin: '1111' } }, 201);
    const dono = (await request('/auth/login', { method: 'POST', token: null, body: { email: 'g@aud-obp.test', password: 'senha-do-gabriel-123' } })).data.token;

    // Painel da rede
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addInitScript(v => sessionStorage.setItem('nv_token', v), dono);
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'TM-T20 imprimindo' : undefined));
    await page.goto(base + '/rede.html');
    await page.click('#nav a[data-page="implantacao"]');
    await page.waitForSelector('#obBox table');
    assert.deepEqual(await page.$$eval('#obBox tbody tr td:first-child b', b => b.map(x => x.textContent)), ['Grand Shopping', 'Sobral']);
    assert.match(await page.textContent('#obBox thead'), /Com a Audace/);
    await page.click('#obBox a[data-go="' + tenant + '"]');
    const printer = `#obBox details[data-u="${tenant}"] .it[data-k="printer"]`;
    // Item nosso: a rede não tem botão.
    assert.equal(await page.$$eval(`#obBox details[data-u="${tenant}"] .it[data-k="reader"] button`, b => b.length), 0);
    await page.click(printer + ' button[data-a="done"]');
    await page.waitForFunction(s => /Gabriel em/.test(document.querySelector(s)?.textContent || ''), printer);
    assert.match(await page.textContent(printer), /TM-T20 imprimindo/);
    await page.screenshot(shot('rede-implantacao'));

    // Central
    const c = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await c.addInitScript(v => sessionStorage.setItem('nv_token', v), masterToken);
    const cp = await c.newPage(); cp.on('pageerror', e => errors.push(e.message));
    cp.on('dialog', d => d.accept(d.type() === 'prompt' ? 'falta a planilha de clientes' : undefined));
    await cp.goto(base + '/central.html');
    await cp.waitForFunction(() => typeof window.networksPage === 'function');
    await cp.evaluate(() => window.networksPage());
    await cp.waitForSelector('#onbCard table');
    const cust = `#onbCard details[data-u="${tenant}"] .it[data-k="customers"]`;
    await cp.click(`#onbCard a[data-go="${tenant}"]`);
    await cp.click(cust + ' button[data-a="waiting"]');
    await cp.waitForFunction(s => /Aguardando a rede/.test(document.querySelector(s)?.textContent || ''), cust);
    assert.match(await cp.textContent(`#onbCard details[data-u="${tenant}"] .foot`), /Sem cadastro de cobrança/);
    await cp.screenshot(shot('central-implantacao'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
