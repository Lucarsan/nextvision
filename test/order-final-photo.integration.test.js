import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Foto final: a loja fotografa o resultado (ex.: o pet depois do banho) e o cliente vê em destaque no link.
// Fotos de entrada (até 6) e finais (até 3) têm limites separados; a final pode ser salva pelo cliente.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]).toString('base64');
const photo = kind => ({ mime_type: 'image/jpeg', base64: JPEG, ...(kind ? { kind } : {}) });

test('foto final: API, limites, link do cliente e download', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 90000
}, async () => {
  const f = await createStoreFixture(); const { api, request, base } = f;
  try {
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { niche: 'pet' } });
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Recepção', 'Banho', 'Pronto para retirada'] } }, 201);
    const cli = await api('/customers', { method: 'POST', body: { name: 'Ana Lima', phone: '85988887777' } }, 201);
    const order = await api('/orders', { method: 'POST', body: { customer_id: cli.id, process_id: proc.id, details: { item_type: 'pet', pet_name: 'Thor', breed: 'Shih-tzu' } } }, 201);

    // Sem "kind" continua sendo foto de entrada (compatível com o painel antigo).
    const a1 = await api('/orders/' + order.id + '/photos', { method: 'POST', body: photo() }, 201);
    assert.equal(a1.kind, 'arrival');
    const fin = await api('/orders/' + order.id + '/photos', { method: 'POST', body: photo('final') }, 201);
    assert.equal(fin.kind, 'final');
    assert.equal((await request('/orders/' + order.id + '/photos', { method: 'POST', body: photo('outro') })).status, 400);
    await api('/orders/' + order.id + '/photos', { method: 'POST', body: photo('final') }, 201);
    await api('/orders/' + order.id + '/photos', { method: 'POST', body: photo('final') }, 201);
    const over = await request('/orders/' + order.id + '/photos', { method: 'POST', body: photo('final') });
    assert.equal(over.status, 409); assert.match(over.data.error, /3 fotos finais/);
    // O limite das finais não consome o das de entrada.
    for (let i = 0; i < 5; i++) await api('/orders/' + order.id + '/photos', { method: 'POST', body: photo() }, 201);
    assert.equal((await request('/orders/' + order.id + '/photos', { method: 'POST', body: photo() })).status, 409);
    // Outra loja não anexa foto.
    assert.equal((await request('/orders/' + order.id + '/photos', { method: 'POST', body: photo('final'), token: f.foreignToken })).status, 404);

    // Painel: listas separadas.
    const listed = (await api('/orders')).find(o => o.id === order.id);
    assert.equal(listed.photos.length, 6); assert.equal(listed.final_photos.length, 3);
    assert.equal(listed.final_photos[0], fin.id);

    // Link do cliente: nome do pet e as duas listas.
    const pub = await (await fetch(base + '/api/public/orders/' + order.share_code)).json();
    assert.equal(pub.item_name, 'Thor');
    assert.equal(pub.photos.length, 6); assert.deepEqual(pub.final_photos, listed.final_photos);
    // Ver e salvar a foto.
    const view = await fetch(base + '/api/public/orders/' + order.share_code + '/photos/' + fin.id);
    assert.equal(view.status, 200); assert.equal(view.headers.get('content-type'), 'image/jpeg'); assert.equal(view.headers.get('content-disposition'), null);
    const save = await fetch(base + '/api/public/orders/' + order.share_code + '/photos/' + fin.id + '?download=1');
    assert.equal(save.status, 200); assert.match(save.headers.get('content-disposition'), /attachment; filename="foto-[0-9a-f]{8}\.jpg"/);
    // Apagar a final libera vaga.
    assert.equal((await fetch(base + '/api/orders/' + order.id + '/photos/' + fin.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + f.ownerToken } })).status, 204);
    await api('/orders/' + order.id + '/photos', { method: 'POST', body: photo('final') }, 201);
  } finally { await f.cleanup(); }
});

test('foto final no painel e no link do cliente (navegador)', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); const { api, base } = f; let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { niche: 'pet' } });
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Banho', 'Pronto para retirada'] } }, 201);
    const cli = await api('/customers', { method: 'POST', body: { name: 'Ana Lima', phone: '85988887777' } }, 201);
    const order = await api('/orders', { method: 'POST', body: { customer_id: cli.id, process_id: proc.id, details: { item_type: 'pet', pet_name: 'Thor' } } }, 201);
    await api('/orders/' + order.id + '/transition', { method: 'POST', body: { action: 'start', expected_step_index: 0, expected_status: 'queued' } });
    await api('/orders/' + order.id + '/transition', { method: 'POST', body: { action: 'advance', expected_step_index: 0, expected_status: 'live' } });

    // Painel: na última etapa aparece "Tirar foto final"; ao escolher a foto, vira "Foto final ✓".
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/loja.html');
    const label = page.locator('label.fp-final-photo').first();
    await label.waitFor();
    assert.match(await label.textContent(), /Tirar foto final/);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAZElEQVR4nO3PUQkAIBTAwBfHiEY0liH8OITBAtzm7PV1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY8dgGJouDxWSHk+wAAAABJRU5ErkJggg==', 'base64');
    await label.locator('input[type=file]').setInputFiles({ name: 'thor.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => /Foto final ✓/.test(document.querySelector('label.fp-final-photo')?.textContent || ''), null, { timeout: 15000 });
    await page.screenshot(shot('painel-foto-final'));
    const listed = (await api('/orders')).find(o => o.id === order.id);
    assert.equal(listed.final_photos.length, 1);
    await page.locator('[data-finish-id][data-notify="0"]').first().click();
    await page.waitForFunction(() => /finalizado/i.test(document.body.textContent));
    assert.deepEqual(errors, []);

    // Cliente no celular: pedido concluído mostra "Thor ficou assim" com a foto e "Salvar foto".
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const cp = await phone.newPage(); const cerrors = []; cp.on('pageerror', e => cerrors.push(e.message));
    await cp.goto(base + '/p/' + order.share_code);
    await cp.waitForSelector('.media.photo img');
    assert.match(await cp.locator('.media.photo .shade strong').textContent(), /Thor ficou pronto!/);
    assert.match(await cp.locator('.actions a[download]').getAttribute('href'), /\?download=1$/);
    assert.ok(await cp.locator('.media.photo img').evaluate(img => img.complete && img.naturalWidth > 0), 'a foto carrega');
    // A foto final vem antes do quadro de etapas, no topo.
    assert.ok(await cp.evaluate(() => document.querySelector('#content > .hero')?.nextElementSibling?.querySelector('.segs') !== null));
    await cp.screenshot({ ...shot('cliente-foto-final'), fullPage: true });
    assert.deepEqual(cerrors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
