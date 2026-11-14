import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Avaliações do Google (14/11/2026): mensagem copiada leva o link medido; o cliente abre, é contado e vai para o Google;
// a central vê no Relatório do dia e marca quem avaliou.
test('avaliações: link medido na mensagem copiada, redirecionamento e relatório da central', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  try {
    const { api, db } = f;
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    await api('/store/sales/config', { method: 'PATCH', body: { google_review_url: 'https://g.page/r/teste/review' } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const ana = (await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Ana Avalia', phone: '85999990001' }, total_cents: 1000, payment_method: 'pix' } }, 201)).customer;

    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });

    // Loja: copiar a mensagem e "Já enviei".
    const store = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await store.addInitScript(v => sessionStorage.setItem('nv_token', v), f.ownerToken);
    await store.addInitScript(() => {
      window.__copied = []; window.open = () => null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__copied.push(t); } } });
      document.execCommand = cmd => { if (cmd === 'copy') { window.__copied.push(document.activeElement?.value ?? ''); return true; } return false; };
    });
    const page = await store.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-menu [data-view="messages"]').click();
    await page.waitForSelector(`[data-fs-copy="${ana.id}"]`);
    await page.locator(`[data-fs-copy="${ana.id}"]`).click();
    await page.waitForFunction(() => window.__copied.length === 1);
    const text = await page.evaluate(() => window.__copied[0]);
    const link = f.base + '/a/' + ana.review_code;
    assert.ok(text.includes(link), 'mensagem leva o link medido: ' + text);
    assert.ok(!text.includes('g.page'), 'o link do Google não vai direto');
    await page.locator(`[data-fs-done="${ana.id}"]`).click();
    await page.waitForFunction(id => !document.querySelector(`[data-fs-done="${id}"]`), ana.id);
    assert.equal((await db.query('SELECT review_link FROM customer_messages WHERE customer_id=$1', [ana.id])).rows[0].review_link, true);
    // O navegador da loja (equipe) abrindo o link não conta.
    await page.route('https://g.page/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Google</title>' }));
    await page.goto(link); await page.waitForURL('https://g.page/r/teste/review');
    assert.deepEqual(errors, []);

    // Celular da cliente: abre o link, é contado e cai na página de avaliação do Google.
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true });
    const p2 = await phone.newPage(); const errors2 = []; p2.on('pageerror', e => errors2.push(e.message));
    await p2.route('https://g.page/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Google</title>' }));
    await p2.goto(link); await p2.waitForURL('https://g.page/r/teste/review');
    assert.deepEqual(errors2, []);
    const clicks = (await db.query('SELECT staff, source FROM review_clicks ORDER BY id')).rows;
    assert.deepEqual(clicks, [{ staff: true, source: 'message' }, { staff: false, source: 'message' }]);

    // Central: Relatório do dia mostra a seção, a cliente e o "Avaliou".
    const central = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await central.addInitScript(v => sessionStorage.setItem('nv_token', v), f.masterToken);
    const c = await central.newPage(); const errors3 = []; c.on('pageerror', e => errors3.push(e.message));
    await c.goto(f.base + '/central.html');
    await c.locator('.ct-nav-btn[data-page="Relatórios"]').click();
    await c.waitForFunction(() => /Avaliações no Google/.test(document.body.innerText));
    const body = await c.locator('body').innerText();
    assert.match(body, /Mensagens com link de avaliação\s*1/); assert.match(body, /Abriram o link de avaliação\s*1/); assert.match(body, /Ana Avalia/);
    await c.locator(`[data-review-confirm="${ana.id}"]`).check();
    await c.waitForFunction(() => /Avaliações confirmadas\s*1/.test(document.body.innerText));
    assert.ok((await db.query('SELECT review_confirmed_at FROM customers WHERE id=$1', [ana.id])).rows[0].review_confirmed_at);
    if (process.env.SHOT_DIR) await c.locator('section:has-text("Avaliações no Google")').first().screenshot({ path: process.env.SHOT_DIR + '/central-avaliacoes.png' });
    await c.locator('.ct-nav-btn[data-page="Números"]').click();
    await c.waitForFunction(() => /Avaliações no Google/.test(document.body.innerText) && /Funil dos pedidos/.test(document.body.innerText));
    assert.deepEqual(errors3, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
