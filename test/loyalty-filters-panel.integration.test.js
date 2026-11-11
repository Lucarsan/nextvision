import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Painel: Configurações > Fidelidade com dias que não contam e serviços que contam (filtrar "banho" e marcar).
test('painel configura filtros da fidelidade', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => process.env.SHOT_DIR ? { path: process.env.SHOT_DIR + '/' + name + '.png', fullPage: true } : {};
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const made = {};
    for (const name of ['BANHO MEDICINAL', 'Hidratação X', 'Tosa na Tesoura']) made[name] = (await f.api('/store/sales/service-items', { method: 'POST', body: { name } }, 201)).id;

    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="settings"]').click();
    await page.getByRole('tab', { name: 'Fidelidade' }).click();
    const form = page.locator('#loyaltyForm');
    await form.locator('[data-lf-count]:text("(todos contam)")').waitFor();
    await form.locator('[name=enabled]').check();
    await form.locator('[name=reward]').fill('1 hidratação');
    await form.locator('[name=lf_off][value="3"]').check();
    await form.locator('[data-lf-search]').fill('banho');
    const shown = await form.locator('.lf-svc:visible').evaluateAll(rows => rows.map(r => ({ id: r.querySelector('input').value, name: r.textContent.trim() })));
    assert.ok(shown.length >= 2 && shown.every(r => /banho/i.test(r.name)), 'só banhos aparecem');
    assert.ok(!shown.some(r => /hidrata|tosa na/i.test(r.name)));
    await form.getByRole('button', { name: 'Marcar os filtrados' }).click();
    await form.locator(`[data-lf-count]:text("(${shown.length} marcados)")`).waitFor();
    await page.screenshot(shot('fidelidade-filtros'));
    await form.getByRole('button', { name: 'Salvar fidelidade' }).click();
    await page.waitForSelector('#loyaltyStatus:text("Fidelidade atualizada")');
    const cfg = await f.api('/store/loyalty');
    assert.equal(cfg.loyalty_enabled, true); assert.deepEqual(cfg.loyalty_off_weekdays, [3]);
    assert.deepEqual([...cfg.loyalty_service_ids].sort(), shown.map(r => r.id).sort());
    assert.ok(cfg.loyalty_service_ids.includes(made['BANHO MEDICINAL']) && !cfg.loyalty_service_ids.includes(made['Hidratação X']));

    // Recarregar mantém as marcações.
    await page.reload();
    await page.locator('.nv-sidebar [data-view="settings"]').click();
    await page.getByRole('tab', { name: 'Fidelidade' }).click();
    await form.locator(`[data-lf-count]:text("(${shown.length} marcados)")`).waitFor();
    assert.equal(await form.locator('[name=lf_off][value="3"]').isChecked(), true);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
