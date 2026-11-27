import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Inventário no quiosque (Estoque → Contagem): contagem guardada no servidor (soma de qualquer computador),
// quantidade por bipagem, lista das não contadas e, ao aplicar, desconto do que foi vendido depois de bipado.
const unitLogin = (base, host, body) => new Promise((resolve, reject) => {
  const u = new URL(base + '/api/auth/unit');
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: host, 'Content-Type': 'application/json' } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(JSON.parse(b || '{}')));
  });
  r.on('error', reject); r.write(JSON.stringify(body)); r.end();
});

async function setup(f, slug) {
  const { api, tenant, masterToken, base } = f;
  const host = slug + '.example.test';
  const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug, hostname: host } }, 201);
  await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Cascavel' } });
  await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
  await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-cascavel' } });
  const bia = await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Bia Souza', function: 'vendedora', unit_id: tenant, pin: '4321' } }, 201);
  const add = (code, name) => f.db.query("INSERT INTO products(tenant_id,name,barcode,code,price_cents,stock_qty) VALUES($1,$2,$3,$3,5000,0) RETURNING id", [tenant, name, code]).then(r => r.rows[0].id);
  const ids = { gota: await add('003622', 'Brinco Gota'), alianca: await add('1511', 'Aliança Aço'), colar: await add('777', 'Colar Elos'), pulseira: await add('0796', 'Pulseira Riviera') };
  const kt = (await unitLogin(base, host, { unit_id: tenant, password: 'senha-cascavel' })).token; assert.ok(kt);
  return { kt, bia: bia.id || bia.user?.id || bia.person?.id, ids };
}

test('inventário: rascunho no servidor, não contadas e venda durante a contagem', { skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL' }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant } = f;
    const { kt, ids } = await setup(f, 'audace-inv');
    const sellerId = (await f.db.query("SELECT id FROM users WHERE name='Bia Souza'")).rows[0].id;
    const draft = () => api('/store/stock/count/draft', { token: kt });
    const put = body => api('/store/stock/count/draft', { method: 'POST', token: kt, body });

    assert.deepEqual(await draft(), { items: [], total: 4, counted: 0, units: 0 });
    // Dois computadores bipando a mesma peça somam; "10 iguais" entra de uma vez.
    await put({ product_id: ids.gota, add: 1 }); await put({ product_id: ids.gota, add: 1 });
    await put({ product_id: ids.alianca, add: 10 });
    let d = await draft();
    assert.equal(d.counted, 2); assert.equal(d.units, 12);
    assert.equal(d.items.find(x => x.id === ids.gota).qty, 2);
    // "−" até zerar tira a peça da contagem; digitar 0 confirma que não tem.
    assert.equal((await put({ product_id: ids.alianca, set: 9 })).qty, 9);
    await put({ product_id: ids.colar, add: 1 });
    assert.equal((await put({ product_id: ids.colar, add: -1 })).removed, true);
    await put({ product_id: ids.colar, set: 0 });
    // Não contadas: só a pulseira; busca pelo código.
    let m = await api('/store/stock/count/missing', { token: kt });
    assert.deepEqual(m.items.map(x => x.name), ['Pulseira Riviera']); assert.equal(m.total, 1);
    assert.equal((await api('/store/stock/count/missing?q=0796', { token: kt })).total, 1);
    assert.equal((await api('/store/stock/count/missing?q=xyz', { token: kt })).total, 0);
    // Peça de outra loja e requisição inválida.
    const foreign = (await f.db.query("INSERT INTO products(tenant_id,name,barcode,price_cents) VALUES($1,'Peça de outra loja','9',100) RETURNING id", [f.foreignTenant])).rows[0].id;
    assert.equal((await request('/store/stock/count/draft', { method: 'POST', token: kt, body: { product_id: foreign, add: 1 } })).status, 404);
    assert.equal((await request('/store/stock/count/draft', { method: 'POST', token: kt, body: { product_id: ids.gota, add: 1, set: 2 } })).status, 400);

    // Venda de 1 brinco depois de bipado (estoque no sistema ainda 0 → fica -1).
    await new Promise(r => setTimeout(r, 20));
    await f.db.query("UPDATE products SET stock_qty = stock_qty - 1 WHERE id = $1", [ids.gota]);
    await f.db.query("INSERT INTO stock_movements(tenant_id,product_id,kind,quantity,stock_before,stock_after) VALUES($1,$2,'sale',-1,0,-1)", [tenant, ids.gota]);

    // Aplicar exige PIN de quem contou.
    assert.equal((await request('/store/stock/count', { method: 'POST', token: kt, body: { from_draft: true, seller_id: sellerId, seller_pin: '0000' } })).status, 401);
    const r = await api('/store/stock/count', { method: 'POST', token: kt, body: { from_draft: true, seller_id: sellerId, seller_pin: '4321' } });
    assert.equal(r.counted, 3); assert.equal(r.adjusted, 1); assert.equal(r.zeroed, 0);
    const st = Object.fromEntries((await f.db.query('SELECT id, stock_qty FROM products WHERE tenant_id = $1', [tenant])).rows.map(x => [x.id, x.stock_qty]));
    assert.equal(st[ids.gota], 1); assert.equal(st[ids.alianca], 9); assert.equal(st[ids.colar], 0); assert.equal(st[ids.pulseira], 0);
    const mv = (await f.db.query("SELECT stock_before, stock_after, created_by FROM stock_movements WHERE product_id = $1 AND kind = 'count'", [ids.gota])).rows[0];
    assert.deepEqual([mv.stock_before, mv.stock_after, mv.created_by], [-1, 1, sellerId]);
    // Rascunho limpo; aplicar de novo sem nada contado = 400.
    assert.equal((await draft()).counted, 0);
    assert.equal((await request('/store/stock/count', { method: 'POST', token: kt, body: { from_draft: true, seller_id: sellerId, seller_pin: '4321' } })).status, 400);
    // Recomeçar apaga o rascunho sem mexer no estoque.
    await put({ product_id: ids.pulseira, add: 2 });
    assert.equal((await api('/store/stock/count/draft', { method: 'DELETE', token: kt })).removed, 1);
    assert.equal((await f.db.query('SELECT stock_qty FROM products WHERE id = $1', [ids.pulseira])).rows[0].stock_qty, 0);
  } finally { await f.cleanup(); }
});

test('inventário na tela do quiosque: bipar com quantidade, não contadas e aplicar com PIN', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const { tenant, base } = f;
    const { kt, ids } = await setup(f, 'audace-invp');
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(v => localStorage.setItem('fp_kiosk_token', v), kt);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(base + '/caixa');
    await page.waitForSelector('[data-view="stock"]');
    await page.click('[data-view="stock"]');
    await page.click('#stTabs [data-t="count"]');
    await page.waitForFunction(() => /4 peças cadastradas/.test(document.getElementById('ctInfo').textContent));

    // 1 brinco, depois 10 alianças de uma vez (quantidade + bipar uma).
    await page.fill('#ctScan', '003622'); await page.press('#ctScan', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#ctItems tr').length === 1);
    await page.fill('#ctQty', '10'); await page.fill('#ctScan', '1511'); await page.press('#ctScan', 'Enter');
    await page.waitForFunction(() => /Contadas 2 de 4 peças · 11 unidades · faltam 2/.test(document.getElementById('ctInfo').textContent));
    assert.equal(await page.inputValue('#ctQty'), '1');
    // Código sem cadastro vai para a lista da supervisora.
    await page.fill('#ctScan', '55555'); await page.press('#ctScan', 'Enter');
    await page.waitForSelector('#ctUnknown:not([hidden])'); assert.match(await page.textContent('#ctUnknown'), /55555/);
    // Corrigir a quantidade digitando na linha.
    await page.fill('#ctItems input[data-set="' + ids.alianca + '"]', '8'); await page.press('#ctItems input[data-set="' + ids.alianca + '"]', 'Enter');
    await page.waitForFunction(() => /9 unidades/.test(document.getElementById('ctInfo').textContent));
    await page.screenshot(shot('inventario-contadas'));

    // Não contadas: digita a quantidade do colar e 0 na pulseira.
    await page.click('#ctTabs [data-v="miss"]');
    await page.waitForFunction(() => document.querySelectorAll('#ctMissRows [data-miss]').length === 2);
    await page.screenshot(shot('inventario-nao-contadas'));
    await page.fill('#ctMissRows [data-miss="' + ids.colar + '"]', '3'); await page.press('#ctMissRows [data-miss="' + ids.colar + '"]', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#ctMissRows [data-miss]').length === 1);
    await page.fill('#ctMissRows [data-miss="' + ids.pulseira + '"]', '0'); await page.press('#ctMissRows [data-miss="' + ids.pulseira + '"]', 'Enter');
    await page.waitForFunction(() => /todas contadas/.test(document.getElementById('ctInfo').textContent));
    assert.equal(await page.getAttribute('#ctBar', 'style'), 'width: 100%;');

    // Aplicar: quem contou + PIN.
    await page.locator('#ctWho [data-w]').first().click();
    await page.waitForSelector('#pinDlg[open]');
    for (const k of '4321') await page.click(`#keys [data-k="${k}"]`);
    await page.waitForFunction(() => /Contagem aplicada: 4 peças/.test(document.getElementById('ctMsg').textContent));
    await page.screenshot(shot('inventario-aplicada'));
    const st = Object.fromEntries((await f.db.query('SELECT id, stock_qty FROM products WHERE tenant_id = $1', [tenant])).rows.map(x => [x.id, x.stock_qty]));
    assert.deepEqual([st[ids.gota], st[ids.alianca], st[ids.colar], st[ids.pulseira]], [1, 8, 3, 0]);
    await page.waitForFunction(() => /Nenhuma peça contada/.test(document.getElementById('ctInfo').textContent));
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await f.cleanup(); }
});
