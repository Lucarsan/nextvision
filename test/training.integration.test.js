import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';
import { presignR2, mergeSeen, percentOf, chapterStats } from '../src/training.js';

// Vídeos de treinamento: vendedora assiste no quiosque com o PIN, dono e supervisor no painel da rede,
// e o relatório mostra quem viu até o final e quais partes. Pular a barra não conta.
const R2 = { R2_ACCOUNT_ID: 'acc123', R2_ACCESS_KEY_ID: 'AK', R2_SECRET_ACCESS_KEY: 'SK', R2_BUCKET: 'treinamentos' };
const unitLogin = (base, body) => new Promise((resolve, reject) => {
  const u = new URL(base + '/api/auth/unit');
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: 'aud-tr.example.test', 'Content-Type': 'application/json' } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(JSON.parse(b || '{}')));
  });
  r.on('error', reject); r.write(JSON.stringify(body)); r.end();
});

test('link assinado do R2 confere com o exemplo oficial da AWS (assinatura v4)', () => {
  const u = presignR2('test.txt', { expires: 86400, now: new Date('2013-05-24T00:00:00Z'), cfg: { key: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', bucket: 'examplebucket', host: 'examplebucket.s3.amazonaws.com', region: 'us-east-1', virtual: true } });
  assert.match(u, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  const r2 = presignR2('audace/Consultoras paineis.mp4', { cfg: { account: 'acc', key: 'k', secret: 's', bucket: 'b' } });
  assert.match(r2, /^https:\/\/acc\.r2\.cloudflarestorage\.com\/b\/audace\/Consultoras%20paineis\.mp4\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=k%2F\d{8}%2Fauto%2Fs3%2Faws4_request/);
});

test('trechos assistidos e partes', () => {
  const m = mergeSeen('000000', [0, 1, 1, 9, -1], 6);
  assert.deepEqual(m, { seen: '110000', added: 2 });
  assert.equal(percentOf('111110', 6), 83);
  assert.deepEqual(chapterStats([{ t: 15, title: 'Venda' }, { t: 0, title: 'Abertura' }], '111000', 30).map(c => [c.title, c.percent]), [['Abertura', 100], ['Venda', 0]]);
});

test('treinamento: quiosque com PIN, painel da rede e relatório de quem viu', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture({ env: R2 }); let browser;
  const shot = name => process.env.SHOT_DIR ? { path: process.env.SHOT_DIR + '/' + name + '.png', fullPage: true } : {};
  try {
    const { api, request, tenant, foreignTenant, masterToken, base } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'aud-tr', hostname: 'aud-tr.example.test' } }, 201);
    for (const [id, label] of [[tenant, 'Grand Shopping'], [foreignTenant, 'Sobral']]) {
      await api(`/master/tenants/${id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: label } });
      await api('/master/tenants/' + id, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    }
    const people = `/master/networks/${net.id}/people`;
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Gabriel', email: 'g@aud-tr.test', function: 'dono', password: 'senha-do-gabriel-123' } }, 201);
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Volney', email: 'v@aud-tr.test', function: 'supervisor', unit_ids: [foreignTenant], password: 'senha-do-volney-123' } }, 201);
    const ana = await api(people, { method: 'POST', token: masterToken, body: { name: 'Ana', function: 'vendedora', unit_id: tenant, pin: '1111' } }, 201);
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Bia', function: 'vendedora', unit_id: foreignTenant, pin: '2222' } }, 201);
    const login = async (email, password) => (await request('/auth/login', { method: 'POST', token: null, body: { email, password } })).data.token;
    const gabriel = await login('g@aud-tr.test', 'senha-do-gabriel-123'), volney = await login('v@aud-tr.test', 'senha-do-volney-123');
    await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-grand' } });
    const kt = (await unitLogin(base, { unit_id: tenant, password: 'senha-grand' })).token; assert.ok(kt);

    // Central cadastra o vídeo (30 s, duas partes).
    const vid = await api(`/master/networks/${net.id}/training`, { method: 'POST', token: masterToken, body: { title: 'Consultoras: painéis do sistema', object_key: 'audace/consultoras-v1.mp4', duration_s: 30, chapters: [{ t: 0, title: 'Abertura' }, { t: 15, title: 'Venda' }] } }, 201);
    const list = await api(`/master/networks/${net.id}/training`, { token: masterToken });
    assert.equal(list.r2, true); assert.equal(list.videos.length, 1);
    // Outra rede não vê.
    const other = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Outra', slug: 'outra-tr', hostname: 'outra-tr.example.test' } }, 201);
    assert.equal((await api(`/master/networks/${other.id}/training`, { token: masterToken })).videos.length, 0);

    // Quiosque: PIN errado não abre; PIN certo devolve link assinado do R2.
    assert.equal((await request(`/store/kiosk/training/${vid.id}/start`, { method: 'POST', token: kt, body: { seller_id: ana.id, pin: '9999' } })).status, 401);
    const st = await api(`/store/kiosk/training/${vid.id}/start`, { method: 'POST', token: kt, body: { seller_id: ana.id, pin: '1111' } });
    assert.match(st.src, /^https:\/\/acc123\.r2\.cloudflarestorage\.com\/treinamentos\/audace\/consultoras-v1\.mp4\?/);
    // Mandar o vídeo todo de uma vez (pular/forjar) não passa: só o que o tempo permite.
    const fake = await api('/training/progress', { method: 'POST', token: kt, body: { token: st.token, buckets: [0, 1, 2, 3, 4, 5], position: 30 } });
    assert.equal(fake.accepted, 3); assert.equal(fake.refused, 3); assert.equal(fake.completed_at, null);
    await f.db.query('UPDATE training_views SET seen = repeat(\'0\', 6), percent = 0, position = 0');
    // Outra vendedora (de outra unidade) não abre por este quiosque.
    const bia = (await f.db.query("SELECT id FROM users WHERE name = 'Bia'")).rows[0].id;
    assert.equal((await request(`/store/kiosk/training/${vid.id}/start`, { method: 'POST', token: kt, body: { seller_id: bia, pin: '2222' } })).status, 401);

    // Navegador: o vídeo vem do R2 (aqui, interceptado com um mp4 de teste).
    const mp4 = '/home/claude/fixtures/t30.mp4';
    if (!existsSync(mp4)) throw Error('Gere o vídeo de teste: ffmpeg -f lavfi -i testsrc -t 30 ' + mp4);
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const body = readFileSync(mp4);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.route(/r2\.cloudflarestorage\.com/, r => r.fulfill({ status: 200, contentType: 'video/mp4', body }));
    await ctx.addInitScript(v => localStorage.setItem('fp_kiosk_token', v), kt);
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
    await page.goto(base + '/caixa');
    await page.click('[data-view="training"]');
    await page.waitForSelector('#trBox .chip');
    assert.match(await page.textContent('#trBox'), /◐ Ana · 0%/);
    await page.click(`#trBox .chip[data-s="${ana.id}"]`);
    await page.fill('dialog.trd input', '1111'); await page.click('dialog.trd .pin button');
    await page.waitForSelector('dialog.trd video');
    await page.evaluate(() => { const v = document.querySelector('dialog.trd video'); v.muted = true; v.playbackRate = 2; v.play(); });
    await page.waitForFunction(() => /Treinamento concluído/.test(document.querySelector('dialog.trd .st')?.textContent || ''), null, { timeout: 60000 });
    await page.screenshot(shot('quiosque-treinamento-player'));
    await page.click('dialog.trd [data-x]');
    await page.waitForFunction(() => /✓ Ana/.test(document.getElementById('trBox').textContent));
    await page.screenshot(shot('quiosque-treinamento'));

    // Gabriel (dono): vê todas as unidades e as partes que a Ana viu.
    const rep = await api('/network/training/report', { token: gabriel });
    const anaRep = rep.people.find(p => p.name === 'Ana');
    assert.ok(anaRep.views[vid.id].completed_at); assert.deepEqual(anaRep.views[vid.id].chapters.map(c => c.percent), [100, 100]);
    assert.deepEqual(rep.people.map(p => p.name).sort(), ['Ana', 'Bia', 'Gabriel', 'Volney']);
    // Volney (supervisor de Sobral): só a Bia.
    const vrep = await api('/network/training/report', { token: volney });
    assert.deepEqual(vrep.people.map(p => p.name), ['Bia']); assert.deepEqual(vrep.units.map(u => u.label), ['Sobral']);

    // Painel da rede (Gabriel): Treinamento com "Quem já assistiu".
    const g = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await g.route(/r2\.cloudflarestorage\.com/, r => r.fulfill({ status: 200, contentType: 'video/mp4', body }));
    await g.addInitScript(v => sessionStorage.setItem('nv_token', v), gabriel);
    const gp = await g.newPage(); gp.on('pageerror', e => errors.push(e.message));
    await gp.goto(base + '/rede.html#treinamento');
    await gp.waitForSelector('#trBox tr.person');
    assert.match(await gp.textContent('#trBox'), /Viu até o final/);
    assert.match(await gp.textContent('#trBox'), /Não assistiu/);
    await gp.click(`#trBox tr.person[data-p="${ana.id}"]`);
    assert.match(await gp.textContent(`#trBox tr[data-d="${ana.id}"]`), /Abertura 100%[\s\S]*Venda 100%/);
    await gp.selectOption('#trBox [data-f="state"]', 'none');
    assert.doesNotMatch(await gp.textContent('#trBox tbody'), /Ana/);
    await gp.screenshot(shot('rede-treinamento'));

    // Central: vídeo regravado → todos voltam a "não assistiu".
    await api(`/master/training/${vid.id}`, { method: 'PATCH', token: masterToken, body: { new_version: true } });
    const rep2 = await api('/network/training/report', { token: gabriel });
    assert.equal(rep2.people.find(p => p.name === 'Ana').views[vid.id], null);
    // Passe antigo não grava na versão nova.
    assert.equal((await request('/training/progress', { method: 'POST', token: kt, body: { token: st.token, buckets: [0], position: 1 } })).status, 409);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
