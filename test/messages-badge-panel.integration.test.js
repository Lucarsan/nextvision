import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Botão "Mensagens" (menu e atalho do topo) destaca e mostra quantas mensagens faltam enviar (13/11/2026).
test('mensagens: botão avisa quantas faltam enviar e some quando zera', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  try {
    const { api, db } = f;
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const sale = body => api('/store/sales', { method: 'POST', body: { total_cents: 1000, payment_method: 'pix', ...body } }, 201);
    const ana = (await sale({ new_customer: { name: 'Ana Hoje', phone: '85999990001' } })).customer.id;
    await sale({ new_customer: { name: 'Sem Fone' } }); // sem WhatsApp: não entra na conta
    const old = await sale({ new_customer: { name: 'Bia Ontem', phone: '85999990002' } });
    await db.query(`UPDATE sales SET created_at=now()-interval '1 day' WHERE id=$1`, [old.sale.id]);

    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } }); await context.addInitScript(v => sessionStorage.setItem('nv_token', v), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(f.base + '/loja.html');
    await page.waitForFunction(() => document.body.classList.contains('fp-msg-due'));
    const badge = () => page.evaluate(() => getComputedStyle(document.querySelector('.nv-menu [data-view=messages]'), '::after').content);
    assert.equal(await badge(), '"2"', 'Ana (hoje) + Bia (pendente); quem não tem WhatsApp não conta');
    assert.equal(await page.locator('.nv-menu [data-view=messages]').getAttribute('aria-label'), 'Mensagens: 2 para enviar');
    if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/mensagens-aviso.png' });

    // Enviar uma pela tela atualiza o número; dispensar a outra apaga o aviso.
    await page.locator('.nv-menu [data-view="messages"]').click();
    await page.waitForSelector(`[data-fs-send="${ana}"]`);
    await page.evaluate(() => { window.open = () => null; });
    await page.locator(`[data-fs-send="${ana}"]`).click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.nv-menu [data-view=messages]'), '::after').content === '"1"');
    page.on('dialog', d => d.accept());
    await page.locator('[data-fs-skip]').click();
    await page.waitForFunction(() => !document.body.classList.contains('fp-msg-due'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
