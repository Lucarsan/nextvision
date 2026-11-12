import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Central > Relatórios abre com o relatório do dia: funil, números e uma linha por pedido,
// mesmo quando nenhuma mensagem de resultados está programada para o dia.
test('central: relatório do dia com os links de acompanhamento', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined, fullPage: true });
  const post = (path, body) => fetch(f.base + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const proc = await f.api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Banho', 'Pronto'] } }, 201);
    const a = await f.api('/orders/quick', { method: 'POST', body: { reference: 'REX', process_id: proc.id } }, 201);
    await f.api('/orders/quick', { method: 'POST', body: { reference: 'MEG', process_id: proc.id } }, 201);
    const ta = a.tracking_url.split('/p/')[1];
    await fetch(f.base + '/api/store/link-shares', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + f.ownerToken }, body: JSON.stringify({ link: a.tracking_url, channel: 'whatsapp' }) });
    await post('/public/orders/' + ta + '/visit', { visit: crypto.randomUUID(), visitor: crypto.randomUUID(), visible: 40, live: 25, device: 'mobile' });
    await post('/public/orders/' + ta + '/visit', { visit: crypto.randomUUID(), visitor: crypto.randomUUID(), visible: 5, live: 0, device: 'desktop', staff: true });
    await f.db.query("UPDATE tenants SET results_report='off'");

    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.masterToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(f.base + '/central.html');
    await page.locator('.ct-nav-btn[data-page="Relatórios"]').click();
    await page.waitForFunction(() => /Relatório do dia/.test(document.body.innerText));
    const text = await page.locator('body').innerText();
    assert.match(text, /Link enviado ou copiado/); assert.match(text, /Cliente abriu o link/);
    assert.match(text, /REX/); assert.match(text, /MEG/); assert.match(text, /Link não enviado/);
    assert.match(text, /\+1 da equipe/); assert.match(text, /nenhuma programada/);
    await page.screenshot(shot('central-relatorio-dia'));
    // Dia anterior: sem pedidos.
    await page.locator('#rpPrev').click();
    await page.waitForFunction(() => /Nenhum pedido criado neste dia/.test(document.body.innerText));
    // Números: funil e aberturas da equipe fora da conta.
    await page.locator('.ct-nav-btn[data-page="Números"]').click();
    await page.waitForFunction(() => /Funil dos pedidos/.test(document.body.innerText));
    assert.match(await page.locator('body').innerText(), /Aberturas da equipe/);
    await page.screenshot(shot('central-numeros'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
