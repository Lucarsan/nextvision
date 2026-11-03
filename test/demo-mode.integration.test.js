import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';
import { demoVideoFor, nextDemoAction, demoWaitSeconds, LAST_STEP_SECONDS } from '../src/demo-mode.js';

test('modo demonstração: vídeo por etapa e próxima ação', () => {
  assert.equal(demoVideoFor('Banho'), '/demo/pet/banho.mp4');
  assert.equal(demoVideoFor('Secagem'), '/demo/pet/secagem.mp4');
  assert.equal(demoVideoFor('Tosa'), '/demo/pet/tosa.mp4');
  assert.equal(demoVideoFor('Finalização'), '/demo/pet/tosa.mp4');
  assert.equal(demoVideoFor('Pronto para retirada'), null);
  const now = Date.parse('2026-11-03T12:00:00Z'), ago = s => new Date(now - s * 1000).toISOString();
  const o = { status: 'queued', step_index: 0, steps_count: 4, demo_step_seconds: 40 };
  assert.equal(demoWaitSeconds(40), 32); assert.equal(demoWaitSeconds(10), 8);
  assert.equal(nextDemoAction({ ...o, last_change: ago(31) }, now), null);
  assert.equal(nextDemoAction({ ...o, last_change: ago(32) }, now), 'start');
  assert.equal(nextDemoAction({ ...o, status: 'live', last_change: ago(39) }, now), null);
  assert.equal(nextDemoAction({ ...o, status: 'live', last_change: ago(40) }, now), 'advance');
  assert.equal(nextDemoAction({ ...o, status: 'live', step_index: 3, last_change: ago(LAST_STEP_SECONDS) }, now), 'complete');
  assert.equal(nextDemoAction({ ...o, status: 'paused', last_change: ago(999) }, now), null);
  // Etapa sem vídeo (Recepção) passa em 12 s; com vídeo espera o tempo da loja.
  assert.equal(nextDemoAction({ ...o, status: 'live', step_name: 'Recepção', last_change: ago(LAST_STEP_SECONDS) }, now), 'advance');
  assert.equal(nextDemoAction({ ...o, status: 'live', step_name: 'Banho', last_change: ago(LAST_STEP_SECONDS) }, now), null);
});

// Volta o relógio do pedido para o loop do servidor agir já na próxima rodada (a cada 4 s).
const age = (db, id, seconds) => Promise.all([
  db.query("UPDATE orders SET created_at=created_at - make_interval(secs => $2) WHERE id=$1", [id, seconds]),
  db.query("UPDATE audit_events SET created_at=created_at - make_interval(secs => $2) WHERE target_type='order' AND target_id=$1", [id, seconds])
]);
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; assert.ok(Date.now() < end, 'tempo esgotado'); await new Promise(r => setTimeout(r, 300)); } };

test('loja demo: pedido anda sozinho, mostra o vídeo da etapa e termina com foto final', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); const { api, db, base } = f; let browser;
  try {
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { niche: 'pet', demo_mode: true, demo_step_seconds: 10, sales_enabled: true } });
    // Pet shop recebe serviços de pet no caixa (não os de celular).
    const svc = (await api('/store/sales/service-items')).map(i => i.name);
    assert.ok(svc.includes('Banho porte P') && svc.includes('Tosa higiênica')); assert.ok(!svc.includes('Troca de tela'));
    // Loja comum (sem demo) não anda sozinha.
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho e tosa', steps: ['Banho', 'Secagem', 'Tosa', 'Pronto para retirada'] } }, 201);
    const cli = await api('/customers', { method: 'POST', body: { name: 'Ana Lima', phone: '85988887777' } }, 201);
    const order = await api('/orders', { method: 'POST', body: { customer_id: cli.id, process_id: proc.id, details: { item_type: 'pet', pet_name: 'Thor' } } }, 201);
    const foreignProc = await api('/processes', { method: 'POST', token: f.foreignToken, body: { name: 'Reparo', steps: ['Bancada'] } }, 201);
    const foreign = await api('/orders/quick', { method: 'POST', token: f.foreignToken, body: { reference: 'X1', process_id: foreignProc.id } }, 201);
    const settings = await api('/store/settings');
    assert.equal(settings.demo_mode, true); assert.equal(settings.demo_step_seconds, 10);

    const pub = () => fetch(base + '/api/public/orders/' + order.share_code).then(r => r.json());
    let p = await pub(); assert.equal(p.status, 'queued'); assert.equal(p.demo_mode, true);
    // Na fila: vídeo da área de espera e a fila andando (2 na frente logo no começo).
    assert.equal(p.demo_video, '/demo/pet/espera.mp4'); assert.equal(p.queue_position, 3); assert.equal(p.last_change, undefined);

    await age(db, order.id, 30); await age(db, foreign.id, 30);
    p = await waitFor(async () => { const x = await pub(); return x.status === 'live' && x; });
    assert.equal(p.step_index, 0); assert.equal(p.demo_video, '/demo/pet/banho.mp4');
    const video = await fetch(base + p.demo_video, { headers: { Range: 'bytes=0-99' } });
    assert.equal(video.status, 206, 'o vídeo responde a Range (iPhone)'); assert.equal(video.headers.get('content-type'), 'video/mp4');

    // Navegador no celular: o vídeo de exemplo toca no lugar da câmera.
    if (process.env.BROWSER_EXECUTABLE) {
      const require = createRequire(import.meta.url);
      let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
      browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
      const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(base + '/p/' + order.share_code);
      await page.waitForSelector('video.nv-demo-player');
      assert.match(await page.locator('video.nv-demo-player').getAttribute('src'), /banho\.mp4$/);
      assert.match(await page.locator('h1').textContent(), /Thor está em banho/);
      if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/demo-banho.png' });
      // Avança para Secagem; a página percebe sozinha (atualiza a cada 4 s na demo).
      await age(db, order.id, 30);
      await page.waitForFunction(() => /secagem\.mp4$/.test(document.querySelector('video.nv-demo-player')?.getAttribute('src') || ''), null, { timeout: 20000 });
      assert.deepEqual(errors, []);
    } else {
      await age(db, order.id, 30);
      await waitFor(async () => (await pub()).step_index === 1);
    }
    // Pausado não anda.
    await api('/orders/' + order.id + '/transition', { method: 'POST', body: { action: 'pause' } });
    await age(db, order.id, 60); await new Promise(r => setTimeout(r, 6000));
    assert.equal((await pub()).status, 'paused');
    await api('/orders/' + order.id + '/transition', { method: 'POST', body: { action: 'resume' } });
    // Secagem → Tosa → Pronto → concluído, com foto final.
    for (let i = 0; i < 3; i++) { const before = await pub(); await age(db, order.id, 30); await waitFor(async () => { const x = await pub(); return (x.step_index !== before.step_index || x.status !== before.status) && x; }); }
    p = await pub();
    assert.equal(p.status, 'completed'); assert.equal(p.final_photos.length, 1); assert.equal(p.demo_video, undefined);
    const photo = await fetch(base + '/api/public/orders/' + order.share_code + '/photos/' + p.final_photos[0]);
    assert.equal(photo.status, 200); assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    const audit = (await db.query("SELECT action FROM audit_events WHERE target_id=$1 AND action LIKE 'demo_%' ORDER BY id", [order.id])).rows.map(r => r.action);
    assert.deepEqual(audit, ['demo_start', 'demo_advance', 'demo_advance', 'demo_advance', 'demo_complete']);
    // A outra loja (sem demo) ficou na fila.
    assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [foreign.id])).rows[0].status, 'queued');
  } finally { await browser?.close(); await f.cleanup(); }
});

test('link de apresentação /demo/<loja>: cria o pedido-vitrine e recomeça do zero', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); const { api, db, base } = f; let browser;
  try {
    const slug = (await db.query('SELECT slug FROM tenants WHERE id=$1', [f.tenant])).rows[0].slug.replace(/_/g, '-');
    await db.query('UPDATE tenants SET slug=$2 WHERE id=$1', [f.tenant, slug]);
    await db.query('INSERT INTO tenant_slugs(slug,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [slug, f.tenant]);
    await api('/processes', { method: 'POST', body: { name: 'Só tosa', steps: ['Tosa', 'Pronto para retirada'] } }, 201);
    await api('/processes', { method: 'POST', body: { name: 'Banho e tosa', steps: ['Recepção', 'Banho', 'Secagem', 'Tosa', 'Pronto para retirada'] } }, 201);
    // Loja sem demo: 404.
    assert.equal((await fetch(base + '/demo/' + slug, { redirect: 'manual' })).status, 404);
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { niche: 'pet', demo_mode: true, demo_step_seconds: 10 } });
    const go = await fetch(base + '/demo/' + slug, { redirect: 'manual' });
    assert.equal(go.status, 302);
    const code = go.headers.get('location').split('/p/')[1];
    let p = await (await fetch(base + '/api/public/orders/' + code)).json();
    assert.equal(p.demo_showcase, true); assert.equal(p.item_name, 'Thor'); assert.equal(p.process, 'Banho e tosa'); assert.equal(p.status, 'queued');
    // Leva até o fim e confere que recomeça do zero, no mesmo link, sem foto final.
    const id = (await db.query('SELECT id FROM orders WHERE share_code=$1', [code])).rows[0].id;
    await db.query("UPDATE orders SET status='completed',step_index=4,started_at=now(),completed_at=now() WHERE id=$1", [id]);
    await db.query("INSERT INTO order_photos(tenant_id,order_id,mime_type,image_data,kind) VALUES($1,$2,'image/jpeg','\\xffd8ffd9','final')", [f.tenant, id]);
    assert.equal((await fetch(base + '/api/public/orders/' + code + '/demo-restart', { method: 'POST' })).status, 204);
    p = await (await fetch(base + '/api/public/orders/' + code)).json();
    assert.equal(p.status, 'queued'); assert.equal(p.step_index, 0); assert.deepEqual(p.final_photos, []);
    // Abrir o link de novo usa o mesmo pedido (não cria outro).
    const again = await fetch(base + '/demo/' + slug, { redirect: 'manual' });
    assert.equal(again.headers.get('location').split('/p/')[1], code);
    assert.equal((await db.query("SELECT count(*)::int n FROM orders WHERE external_reference='DEMO'")).rows[0].n, 1);
    // Pedido comum da loja demo não pode ser recomeçado pelo link público.
    const cli = await api('/customers', { method: 'POST', body: { name: 'Ana' } }, 201);
    const procs = await api('/processes');
    const normal = await api('/orders', { method: 'POST', body: { customer_id: cli.id, process_id: procs[0].id } }, 201);
    assert.equal((await fetch(base + '/api/public/orders/' + normal.share_code + '/demo-restart', { method: 'POST' })).status, 404);
    // Navegador: o botão vira "Recomeçar do início" e volta o pedido para a fila.
    if (process.env.BROWSER_EXECUTABLE) {
      const require = createRequire(import.meta.url);
      let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
      browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
      await db.query("UPDATE orders SET status='completed',step_index=4,started_at=now(),completed_at=now() WHERE id=$1", [id]);
      const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(base + '/p/' + code);
      await page.waitForFunction(() => /Recomeçar do início/.test(document.getElementById('refresh').textContent));
      assert.match(await page.locator('h1').textContent(), /ficou pronto/);
      await page.locator('#refresh').click();
      await page.waitForFunction(() => /na fila/.test(document.querySelector('h1')?.textContent || ''));
      assert.deepEqual(errors, []);
    }
  } finally { await browser?.close(); await f.cleanup(); }
});
