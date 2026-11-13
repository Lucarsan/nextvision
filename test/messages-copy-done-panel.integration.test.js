import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Mensagens: "Copiar" (para colar no WhatsApp aberto à mão, quando o PC está lento) e "Já enviei" (marca sem abrir o WhatsApp) (13/11/2026).
test('mensagens: copiar a mensagem e marcar "Já enviei" sem abrir o WhatsApp', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  try {
    const { api, db } = f;
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const sale = body => api('/store/sales', { method: 'POST', body: { total_cents: 1000, payment_method: 'pix', ...body } }, 201);
    const ana = (await sale({ new_customer: { name: 'Ana Hoje', phone: '85999990001' } })).customer.id;
    const oldSale = await sale({ new_customer: { name: 'Bia Ontem', phone: '85999990002' } });
    const bia = oldSale.customer.id;
    await db.query(`UPDATE sales SET created_at=now()-interval '1 day' WHERE id=$1`, [oldSale.sale.id]);

    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(v => sessionStorage.setItem('nv_token', v), f.ownerToken);
    await context.addInitScript(() => {
      window.__copied = []; window.__opened = 0;
      window.open = () => { window.__opened++; return null; };
      // Simula a área de transferência (API moderna e o plano B).
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__copied.push(t); } } });
      document.execCommand = cmd => { if (cmd === 'copy') { window.__copied.push(document.activeElement?.value ?? ''); return true; } return false; };
    });
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-menu [data-view="messages"]').click();
    await page.waitForSelector(`[data-fs-copy="${ana}"]`);

    // Copiar: leva o texto da mensagem e não registra envio.
    await page.locator(`[data-fs-copy="${bia}"]`).click();
    await page.waitForFunction(() => window.__copied.length === 1);
    const copied = await page.evaluate(() => window.__copied[0]);
    assert.match(copied, /Bia/, 'mensagem copiada é a da cliente');
    assert.equal(await page.locator('#panelFeedback').textContent(), 'Mensagem copiada. Cole no WhatsApp do cliente e depois clique em "Já enviei".');
    assert.equal((await db.query(`SELECT count(*)::int n FROM customer_messages`)).rows[0].n, 0, 'copiar não marca como enviado');
    if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/mensagens-copiar.png' });

    // Já enviei: marca sem abrir o WhatsApp; a pendente sai da lista e o botão some.
    await page.locator(`[data-fs-done="${bia}"]`).click();
    await page.waitForFunction(id => !document.querySelector(`[data-fs-done="${id}"]`), bia);
    await page.locator(`[data-fs-done="${ana}"]`).click();
    await page.waitForFunction(id => !document.querySelector(`[data-fs-done="${id}"]`) && document.querySelector(`[data-fs-row="${id}"]`)?.classList.contains('sent'), ana);
    assert.equal(await page.evaluate(() => window.__opened), 0, '"Já enviei" não abre o WhatsApp');
    const sent = (await db.query(`SELECT customer_id::text, kind FROM customer_messages ORDER BY created_at`)).rows;
    assert.deepEqual(sent, [{ customer_id: bia, kind: 'status' }, { customer_id: ana, kind: 'status' }]);
    await page.waitForFunction(() => !document.body.classList.contains('fp-msg-due'));
    assert.ok(await page.locator(`[data-fs-copy="${ana}"]`).isVisible(), 'continua dando para copiar depois de enviado');
    assert.ok(await page.locator(`[data-fs-send="${ana}"]`).isVisible(), 'botão Reenviar mantido');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
