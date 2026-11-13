import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Página /lojas: "Encontre nossos parceiros por: Mapa · Nicho".
// Só lojas marcadas pela central aparecem; a de demonstração e as não marcadas ficam fora.
test('lojas parceiras: mapa com marcadores e lista por nicho', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined, fullPage: true });
  try {
    await f.db.query("UPDATE tenants SET niche='pet', address='Rua A, 10 - Messejana', city='Fortaleza', state='CE', whatsapp='5585999990000' WHERE id=$1", [f.tenant]);
    await f.db.query("UPDATE tenants SET niche='electronics', city='Fortaleza', state='CE' WHERE id=$1", [f.foreignTenant]);
    assert.deepEqual(await (await fetch(f.base + '/api/public/partners')).json(), [], 'nenhuma loja marcada');
    await f.api('/master/tenants/' + f.tenant + '/partner', { method: 'PATCH', token: f.masterToken, body: { partner_listed: true, partner_description: 'Banho e tosa.', partner_lat: -3.8385, partner_lng: -38.5012 } });
    await f.api('/master/tenants/' + f.foreignTenant + '/partner', { method: 'PATCH', token: f.masterToken, body: { partner_listed: true, partner_description: 'Reparo de celulares.' } });
    assert.equal((await f.request('/master/tenants/' + f.tenant + '/partner', { method: 'PATCH', token: f.ownerToken, body: { partner_listed: false } })).status, 403);
    let list = await (await fetch(f.base + '/api/public/partners')).json();
    assert.equal(list.length, 2);
    const pet = list.find(p => p.niche === 'pet');
    assert.equal(pet.niche_label, 'Pet shop · banho e tosa'); assert.equal(pet.lat, -3.8385); assert.equal(pet.whatsapp, '5585999990000');
    assert.deepEqual(Object.keys(pet).sort(), ['address', 'city', 'description', 'lat', 'lng', 'logo', 'name', 'niche', 'niche_label', 'state', 'whatsapp']);

    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(f.base + '/lojas');
    await page.waitForSelector('.leaflet-container');
    assert.match(await page.locator('.pt-by').innerText(), /Encontre nossos parceiros por:\s*Mapa\s*Nicho/);
    assert.equal(await page.locator('.pt-pin').count(), 1, 'um marcador (a outra loja não tem posição)');
    assert.match(await page.locator('#ptNoPin').innerText(), /Outra loja/);
    assert.equal(await page.locator('.leaflet-control-zoom-in').count(), 1, 'tem zoom');
    await page.locator('.pt-pin').click();
    await page.waitForSelector('.leaflet-popup-content');
    assert.match(await page.locator('.leaflet-popup-content').innerText(), /Loja de teste/);
    await page.screenshot(shot('lojas-mapa'));
    await page.locator('.pt-tab[data-view=niche]').click();
    assert.equal(await page.locator('.pt-card').count(), 2);
    await page.locator('.pt-chip', { hasText: 'Assistência técnica' }).click();
    assert.equal(await page.locator('.pt-card').count(), 1);
    assert.match(await page.locator('.pt-card').innerText(), /Reparo de celulares/);
    await page.locator('.pt-chip', { hasText: 'Todos' }).click();
    await page.screenshot(shot('lojas-nicho'));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 391), 'sem rolagem lateral no celular');
    assert.deepEqual(errors, []);
    // Tirar da página faz a loja sumir da lista pública.
    await f.api('/master/tenants/' + f.foreignTenant + '/partner', { method: 'PATCH', token: f.masterToken, body: { partner_listed: false } });
    list = await (await fetch(f.base + '/api/public/partners')).json();
    assert.equal(list.length, 1);
  } finally { await browser?.close(); await f.cleanup(); }
});
