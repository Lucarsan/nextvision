import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Painéis da rede: a central monta a rede pela aba "Redes" e o dono da rede vê o faturamento por unidade em /rede.html.
test('central monta a rede e o dono da rede vê o painel', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => process.env.SHOT_DIR ? { path: process.env.SHOT_DIR + '/' + name + '.png', fullPage: true } : {};
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const { api, tenant, masterToken, base } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });

    // Central: cria a rede e liga a loja de teste pela aba Redes.
    const central = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await central.addInitScript(v => sessionStorage.setItem('nv_token', v), masterToken);
    const cp = await central.newPage(); const errors = []; cp.on('pageerror', e => errors.push(e.message));
    await cp.goto(base + '/central.html');
    await cp.getByRole('button', { name: 'Redes' }).click();
    await cp.fill('#netName', 'Audace Joias'); await cp.fill('#netSlug', 'audace'); await cp.fill('#netHost', 'audace.ficoupronto.com');
    await cp.click('#netCreate');
    await cp.waitForSelector('#unAddBtn');
    await cp.selectOption('#unAdd', tenant); await cp.click('#unAddBtn');
    await cp.waitForSelector('.unLabel');
    await cp.fill('.unLabel', 'Maracanaú'); await cp.fill('.unCnpj', '11.222.333/0001-81'); await cp.click('.unSave');
    await cp.waitForFunction(() => document.getElementById('feedback').textContent.includes('Unidade salva')).catch(async e => { console.error('FEEDBACK', await cp.textContent('#feedback'), await cp.inputValue('.unCnpj')); throw e; });
    await cp.fill('#nuName', 'Gabriel Mota'); await cp.fill('#nuEmail', 'gabriel@audace.test'); await cp.fill('#nuPass', 'senha-forte-da-rede-123'); await cp.click('#nuCreate');
    await cp.waitForFunction(() => document.body.textContent.includes('gabriel@audace.test')).catch(async e => { console.error('GAB', await cp.textContent('#feedback'), await cp.evaluate(() => [...document.querySelectorAll('#nuName,#nuEmail,#nuPass')].map(i => i.id + '=' + i.value).join('|'))); throw e; });
    await cp.screenshot(shot('central-redes'));
    assert.deepEqual(errors, []);
    const net = (await api('/master/networks', { token: masterToken }))[0];
    assert.equal(net.units_count, 1);

    // Vendas na unidade.
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 18990, payment_method: 'credit' } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 7990, payments: [{ method: 'cash', amount_cents: 2990 }, { method: 'pix', amount_cents: 5000 }] } }, 201);

    // Dono da rede: login pela tela de entrada e painel.
    const rede = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const rp = await rede.newPage(); rp.on('pageerror', e => errors.push(e.message));
    await rp.goto(base + '/entrar');
    await rp.fill('#email', 'gabriel@audace.test'); await rp.fill('#password', 'senha-forte-da-rede-123'); await rp.click('#loginBtn');
    await rp.waitForURL(/\/rede\.html$/);
    await rp.waitForFunction(() => document.getElementById('rows').textContent.includes('Maracanaú')).catch(async e => { console.error('ROWS', await rp.textContent('body')); throw e; });
    assert.equal(await rp.textContent('#netName'), 'Audace Joias');
    const kpis = await rp.textContent('#kpis');
    assert.match(kpis, /R\$\s?269,80/); assert.match(kpis, /Vendas\s*2/);
    assert.match(await rp.textContent('#rows'), /R\$\s?189,90/);
    await rp.screenshot(shot('painel-rede'));
    await rp.setViewportSize({ width: 390, height: 844 }); await rp.screenshot(shot('painel-rede-celular'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
