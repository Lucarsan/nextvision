import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Ao criar o pedido, a janela de envio abre sozinha. Sem envio, o pedido fica "Link não enviado"
// (no card e em Próximas ações) até a loja enviar ou registrar um motivo. Ao iniciar sem link, o painel lembra.
// No QR fixo da loja, o celular que já abriu um link vê os próprios pedidos.
test('envio do link na criação, aviso de link não enviado e área do cliente no QR', {
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
    const opened = []; await context.route('https://wa.me/**', route => { opened.push(route.request().url()); route.fulfill({ status: 200, body: 'ok' }); });
    const slug = 'envio-' + f.tenant.slice(0, 8);
    await f.db.query("UPDATE tenants SET slug=$1, whatsapp='558532130953' WHERE id=$2", [slug, f.tenant]);
    await f.db.query('INSERT INTO tenant_slugs(slug,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [slug, f.tenant]);
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { niche: 'pet' } });
    const proc = await f.api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Banho', 'Secagem'] } }, 201);
    const ana = await f.api('/customers', { method: 'POST', body: { name: 'Ana Lima', phone: '85996660000' } }, 201);

    // Pedido criado pela API (como pelo caixa) e o painel aberto: aviso em Próximas ações e no card.
    const o1 = await f.api('/orders', { method: 'POST', body: { customer_id: ana.id, process_id: proc.id, details: { pet_name: 'Bob' } } }, 201);
    // Pedido antigo (de antes do recurso) não aparece como pendente.
    const old = await f.api('/orders', { method: 'POST', body: { customer_id: ana.id, process_id: proc.id, details: { pet_name: 'Velho' } } }, 201);
    await f.db.query('UPDATE orders SET link_due=false WHERE id=$1', [old.id]);
    await page.goto(f.base + '/loja.html');
    await page.waitForSelector('#ordersList [data-order-id] .fp-link-pending');
    assert.equal(await page.locator('#ordersList .fp-link-pending').count(), 1, 'só o pedido novo');
    assert.match(await page.locator('.fp-action-link').innerText(), /1 pedido sem link/);
    await page.screenshot(shot('link-nao-enviado'));

    // "Envio depois": continua pendente.
    await page.locator('.fp-action-link [data-share-order]').click();
    await page.waitForSelector('#shareDialog[open]');
    assert.match(await page.locator('#shareDialog').innerText(), /Enviar o acompanhamento para Ana/);
    await page.screenshot(shot('janela-envio'));
    await page.locator('#shareDialog summary').click();
    await page.locator('[data-share-skip="later"]').click();
    await page.waitForFunction(() => !document.querySelector('#shareDialog[open]'));
    await page.waitForFunction(() => /Link não enviado/.test(document.querySelector('#panelFeedback')?.innerText || ''));
    assert.equal(await page.locator('#ordersList .fp-link-pending').count(), 1, 'depois: segue pendente');

    // Iniciar sem link: o painel lembra; enviar pelo WhatsApp tira o aviso.
    await page.locator('#ordersList [data-order-id]', { hasText: 'Bob' }).getByRole('button', { name: 'Iniciar atendimento' }).click();
    await page.waitForSelector('#shareDialog[open]');
    assert.match(await page.locator('#shareDialog .fp-share-intro').innerText(), /atendimento começou/);
    const [popup] = await Promise.all([context.waitForEvent('page'), page.locator('[data-share-send]').click()]);
    await popup.close();
    await page.waitForFunction(() => !document.querySelector('.fp-link-pending'));
    assert.ok(opened.some(u => u.startsWith('https://wa.me/5585996660000?text=')), 'abriu o WhatsApp do cliente');
    for (let i = 0; i < 30 && !(await f.db.query("SELECT 1 FROM link_events WHERE order_id=$1 AND kind='link_sent'", [o1.id])).rowCount; i++) await page.waitForTimeout(200);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM link_events WHERE order_id=$1 AND kind='link_sent'", [o1.id])).rows[0].n, 1, 'envio registrado');
    await page.reload(); await page.waitForSelector('#ordersList [data-order-id]');
    assert.equal(await page.locator('.fp-link-pending').count(), 0, 'depois de recarregar continua sem aviso');

    // Pedido rápido: a janela abre na hora; "Enviei de outro jeito" resolve.
    await page.fill('#reference', 'R-77'); await page.locator('#createQuick').click();
    await page.waitForSelector('#shareDialog[open]');
    assert.match(await page.locator('#shareDialog').innerText(), /Escolher o contato no WhatsApp/);
    await page.locator('#shareDialog summary').click(); await page.locator('[data-share-skip="other_way"]').click();
    await page.waitForFunction(() => !document.querySelector('#shareDialog[open]'));
    await page.waitForFunction(() => !document.querySelector('.fp-link-pending'));

    // QR fixo: o celular da Ana (que abriu o link) vê os pedidos dela.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const m = await phone.newPage(); m.on('pageerror', e => errors.push(e.message));
    await m.goto(f.base + '/' + slug + '/oi');
    await m.waitForFunction(() => document.getElementById('storeName').textContent === 'Loja de teste');
    await m.waitForTimeout(500);
    assert.equal(await m.locator('#mineCard').isVisible(), false, 'aparelho novo não vê pedidos');
    await m.goto(o1.tracking_url.replace(/^https?:\/\/[^/]+/, f.base));
    await m.waitForTimeout(1500);
    await m.goto(f.base + '/' + slug + '/oi');
    await m.waitForSelector('#mineCard:not([hidden]) .order');
    assert.match(await m.locator('#mineTitle').innerText(), /Olá, Ana! Seus pedidos/);
    assert.match(await m.locator('#mineList').innerText(), /Bob/);
    assert.equal(await m.locator('#formCard h1').innerText(), 'Falar com a loja');
    await m.screenshot(shot('qr-area-do-cliente'));
    await m.locator('.order').first().click();
    await m.waitForURL(/\/p\//);
    await phone.close();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
