import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Central → Dispositivos → "Arquivos à distância": a central lista a pasta, traz e envia arquivos;
// o PC (simulado aqui pela API do agente) responde e o painel mostra sozinho, sem F5.
test('central: arquivos à distância no painel de dispositivos', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined, fullPage: true });
  try {
    const code = await f.api('/master/tenants/' + f.tenant + '/activation-codes', { method: 'POST', token: f.masterToken }, 201);
    const dev = await f.api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: 'PC do caixa' } }, 201);
    const tk = dev.device_token;
    await f.api('/connect/heartbeat', { method: 'POST', token: tk, body: { agent_version: '0.6.0', mode: 'management', components: { service: { state: 'ok' } } } });
    const next = async () => { const r = await fetch(f.base + '/api/connect/remote/next', { headers: { Authorization: 'Bearer ' + tk } }); return r.status === 204 ? null : r.json(); };
    const answer = async () => { for (let i = 0; i < 50; i++) { const j = await next(); if (j) return j; await new Promise(r => setTimeout(r, 200)); } throw Error('sem pedido'); };

    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
    await ctx.addInitScript(v => sessionStorage.setItem('nv_token', v), f.masterToken);
    const cp = await ctx.newPage(); const errors = []; cp.on('pageerror', e => errors.push(e.message));
    await cp.goto(f.base + '/central.html');
    await cp.getByRole('button', { name: 'Dispositivos' }).click();
    await cp.selectOption('#deviceTenant', f.tenant);
    await cp.waitForSelector('#rfList');
    assert.match(await cp.textContent('#mediaPanel'), /só gestão/);

    // Listar: o PC responde e a pasta aparece com pastas e arquivos clicáveis.
    await cp.fill('#rfPath', 'C:\\Loja');
    await cp.click('#rfList');
    const list = await answer(); assert.equal(list.path, 'C:\\Loja');
    await f.api('/connect/remote/jobs/' + list.id + '/result', { method: 'POST', token: tk, body: { ok: true, entries: [{ name: 'notas', type: 'dir', modified: new Date().toISOString() }, { name: 'caixa.xlsx', type: 'file', size: 20480, modified: new Date().toISOString() }] } });
    await cp.waitForSelector('[data-rf-get]', { timeout: 10000 });
    assert.match(await cp.textContent('#rfListing'), /caixa\.xlsx/);
    await cp.screenshot(shot('central-arquivos-lista'));

    // Trazer: clica em "Trazer"; o PC envia; aparece "Baixar" e o download chega.
    await cp.click('[data-rf-get]');
    const pull = await answer(); assert.equal(pull.path, 'C:\\Loja\\caixa.xlsx');
    await fetch(f.base + pull.upload_url, { method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('planilha') });
    await cp.waitForSelector('[data-rf-dl]', { timeout: 10000 });
    const [download] = await Promise.all([cp.waitForEvent('download'), cp.click('[data-rf-dl]')]);
    assert.equal(download.suggestedFilename(), 'caixa.xlsx');

    // Enviar: escolhe o arquivo, envia, o PC baixa o mesmo conteúdo.
    await cp.click('summary:has-text("Enviar arquivo para o PC")');
    await cp.setInputFiles('#rfFile', { name: 'tabela de preços.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 teste') });
    await cp.fill('#rfDest', 'C:\\Users\\Public\\Desktop');
    await cp.click('#rfSend');
    const push = await answer();
    assert.equal(push.file_name, 'tabela de preços.pdf'); assert.equal(push.path, 'C:\\Users\\Public\\Desktop');
    assert.equal(await (await fetch(f.base + push.url, { headers: { Authorization: 'Bearer ' + tk } })).text(), '%PDF-1.4 teste');
    await f.api('/connect/remote/jobs/' + push.id + '/result', { method: 'POST', token: tk, body: { ok: true, saved_path: 'C:\\Users\\Public\\Desktop\\tabela de preços.pdf' } });
    await cp.waitForFunction(() => document.getElementById('rfJobs').textContent.includes('salvo em C:\\Users\\Public\\Desktop\\tabela de preços.pdf'), null, { timeout: 10000 });
    await cp.screenshot(shot('central-arquivos-pedidos'));
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await f.cleanup(); }
});
