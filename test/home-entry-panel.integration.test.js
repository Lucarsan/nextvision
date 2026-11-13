import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Página de entrada: acesso à esquerda, celular com a demonstração real e números públicos.
// A demonstração dentro do celular não conta visita; a loja de demonstração não entra nos números.
test('página de entrada com demonstração no celular e números ao vivo', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  const post = (path, body) => fetch(f.base + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const proc = await f.api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Banho', 'Pronto'] } }, 201);
    const real = await f.api('/orders/quick', { method: 'POST', body: { reference: 'R1', process_id: proc.id } }, 201);
    await fetch(f.base + '/api/store/link-shares', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + f.ownerToken }, body: JSON.stringify({ link: real.tracking_url, channel: 'whatsapp' }) });
    await post('/public/orders/' + real.tracking_url.split('/p/')[1] + '/visit', { visit: crypto.randomUUID(), visitor: crypto.randomUUID(), visible: 30, live: 0, device: 'mobile' });
    // Pedido da demonstração (loja em modo demonstração) com o código usado na página.
    await f.db.query('UPDATE tenants SET demo_mode = true WHERE id = $1', [f.foreignTenant]);
    const demoProc = (await f.db.query("INSERT INTO processes(id, tenant_id, name, steps) VALUES($1, $2, 'Demo', '[\"Banho\",\"Pronto\"]'::jsonb) RETURNING id", [crypto.randomUUID(), f.foreignTenant])).rows[0].id;
    const demo = (await f.db.query(`INSERT INTO orders(id, tenant_id, process_id, status, step_index, share_code, public_token_hash, process_snapshot)
      VALUES($1, $2, $3, 'live', 0, '62fce6047564204fa4db22e8', $4, '{"name":"Demo","steps":["Banho","Pronto"]}'::jsonb) RETURNING id`,
      [crypto.randomUUID(), f.foreignTenant, demoProc, crypto.randomBytes(32).toString('hex')])).rows[0].id;
    await post('/public/orders/62fce6047564204fa4db22e8/visit', { visit: crypto.randomUUID(), visitor: crypto.randomUUID(), visible: 30, live: 0, device: 'mobile' });
    await f.api('/master/analytics/settings', { method: 'PATCH', token: f.masterToken, body: { public_stats_enabled: true } });
    const pub = await (await fetch(f.base + '/api/public/stats')).json();
    assert.equal(pub.opens, 1, 'abertura da demonstração fora'); assert.equal(pub.links, 1);

    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
    const before = (await f.db.query('SELECT count(*)::int n FROM link_visits WHERE order_id = $1', [demo])).rows[0].n;
    await page.goto(f.base + '/');
    await page.waitForFunction(() => !document.getElementById('facts').hidden);
    assert.equal(await page.locator('#fOpens').innerText(), '1');
    assert.match(await page.locator('#factsNote').innerText(), /atualizado às/);
    const frame = page.frameLocator('#demoFrame');
    await frame.locator('body').waitFor();
    await page.waitForTimeout(1500);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM link_visits WHERE order_id = $1', [demo])).rows[0].n, before, 'celular de demonstração não conta visita');
    await page.screenshot(shot('home-entrada'));
    // Página inicial: conjunto completo (foto do kit + celular) e o botão Entrar no topo.
    assert.equal(await page.locator('h1').innerText(), 'Instale no seu petshop.');
    assert.equal(await page.locator('.hb-kitlist .st-steps li').count(), 4);
    assert.ok(await page.locator('img.hb-kit').evaluate(i => i.complete && i.naturalWidth > 0), 'foto do kit carrega');
    assert.equal(await page.locator('#enterBtn').getAttribute('href'), '/entrar');
    // Login fica em /entrar; o endereço antigo /#entrar leva para lá.
    await page.goto('about:blank'); await page.goto(f.base + '/#entrar'); await page.waitForURL(/\/entrar$/);
    await page.locator('#email').fill('ninguem@example.test'); await page.locator('#password').fill('errada');
    await page.locator('#loginBtn').click();
    await page.waitForFunction(() => document.getElementById('loginError').textContent.length > 0);
    await page.screenshot(shot('entrar'));
    await page.goto(f.base + '/');
    await page.setViewportSize({ width: 1915, height: 1000 });
    await page.screenshot(shot('home-entrada-larga'));
    // Menu da entrada leva às páginas do site (endereços sem .html), e cada página marca onde está.
    await page.setViewportSize({ width: 1440, height: 1000 });
    const pages = { '/o-que-e': 'O que é o Ficou Pronto?', '/segmentos': 'Segmentos', '/privacidade': 'Privacidade', '/lojas': 'Lojas', '/planos': 'Planos', '/fale-conosco': 'Contato' };
    assert.deepEqual(await page.locator('.st-head .st-nav a').evaluateAll(as => as.map(a => a.getAttribute('href'))), Object.keys(pages));
    await page.locator('.st-head .st-nav a', { hasText: 'Planos' }).click();
    await page.waitForURL(/\/planos$/);
    for (const [path, label] of Object.entries(pages)) {
      await page.goto(f.base + path);
      assert.equal(await page.locator('.st-nav a[aria-current=page]').innerText(), label, path);
      assert.ok((await page.locator('h1').innerText()).length > 10, path);
      await page.screenshot({ ...shot('pagina' + path.replace('/', '-')), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 391), 'sem rolagem lateral em ' + path);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.screenshot(shot('pagina-contato'));
    // Endereço antigo leva para a página nova.
    await page.goto(f.base + '/como-funciona'); assert.match(page.url(), /\/o-que-e$/);
    assert.equal(await page.locator('.st-area').count(), 8);
    assert.equal(await page.locator('.st-area img').count(), 9);
    for (const img of await page.locator('.st-area img').all()) { await img.scrollIntoViewIfNeeded(); assert.ok(await img.evaluate(i => i.complete && i.naturalWidth > 0), await img.getAttribute('src')); }
    await page.screenshot({ ...shot('pagina-o-que-e-completa'), fullPage: true });
    await page.goto(f.base + '/');
    // Celular estreito: acesso primeiro, sem rolagem lateral.
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390 + 1), 'sem rolagem lateral no celular');
    await page.screenshot(shot('home-entrada-celular'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
