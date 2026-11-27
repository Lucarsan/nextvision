import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Venda de outro dia (boletas do período sem sistema): data passada, fora do caixa de hoje, baixa no estoque,
// sem pinpad/cashback/mensagens/NFC-e; aparece para a supervisão no painel da rede.
const unitLogin = (base, host, body) => new Promise((resolve, reject) => {
  const u = new URL(base + '/api/auth/unit');
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: host, 'Content-Type': 'application/json' } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(b || '{}') }));
  });
  r.on('error', reject); r.write(JSON.stringify(body)); r.end();
});
const ymd = days => new Date(Date.now() - 3 * 3600000 - days * 86400000).toISOString().slice(0, 10);

async function setup(f, slug) {
  const { api, tenant, masterToken, base, db } = f;
  const host = slug + '.example.test';
  const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug, hostname: host } }, 201);
  await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Cascavel' } });
  await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
  await db.query('UPDATE tenants SET cashback_enabled=true, cashback_percent=5 WHERE id=$1', [tenant]).catch(() => {});
  await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-cascavel' } });
  await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Bia Souza', function: 'vendedora', unit_id: tenant, pin: '4321' } }, 201);
  await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Dani Lima', function: 'supervisor', unit_ids: [tenant], email: 'dani@' + slug + '.test', password: 'senha-da-dani-1' } }, 201).catch(() => null);
  const prod = (await db.query("INSERT INTO products(tenant_id,name,barcode,code,price_cents,stock_qty) VALUES($1,'Brinco Gota','003622','003622',10000,5) RETURNING id", [tenant])).rows[0].id;
  const kt = (await unitLogin(base, host, { unit_id: tenant, password: 'senha-cascavel' })).data.token; assert.ok(kt);
  const bia = (await db.query("SELECT id FROM users WHERE name='Bia Souza'")).rows[0].id;
  return { host, net, prod, kt, bia };
}

test('venda de outro dia: data passada, fora do caixa, baixa estoque, sem cashback e visível na rede', { skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL' }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, db, masterToken } = f;
    const { prod, kt, bia, net, host } = await setup(f, 'audace-bk');
    const body = extra => ({ items: [{ product_id: prod, quantity: 2 }], anonymous: true, payment_method: 'credit', installments: 2, seller_id: bia, seller_pin: '4321', ...extra });
    // Sem caixa aberto, a venda de outro dia entra mesmo assim.
    assert.equal((await request('/store/sales', { method: 'POST', token: kt, body: body() })).status, 409);
    const d10 = ymd(17);
    const r = await api('/store/sales', { method: 'POST', token: kt, body: body({ sold_on: d10, discount_cents: 5000 }) }, 201);
    const row = (await db.query("SELECT session_id, to_char(created_at AT TIME ZONE 'America/Fortaleza','YYYY-MM-DD') d, backdated_at, backdated_by, installments, total_cents, cashback_earned_cents FROM sales WHERE id=$1", [r.sale.id])).rows[0];
    assert.equal(row.session_id, null); assert.equal(row.d, d10); assert.ok(row.backdated_at); assert.equal(row.backdated_by, bia); assert.equal(row.installments, 2); assert.equal(row.total_cents, 15000);
    assert.equal((await db.query('SELECT stock_qty FROM products WHERE id=$1', [prod])).rows[0].stock_qty, 3);
    // Regras: hoje, futuro, mais de 60 dias, pinpad, maquininha avulsa e cashback não valem.
    for (const [extra, why] of [[{ sold_on: ymd(0) }, 'hoje'], [{ sold_on: ymd(-1) }, 'futuro'], [{ sold_on: ymd(61) }, '61 dias'], [{ sold_on: d10, offline_payment: true }, 'avulsa'], [{ sold_on: d10, cashback_use_cents: 100 }, 'cashback']])
      assert.equal((await request('/store/sales', { method: 'POST', token: kt, body: body(extra) })).status, 400, why);
    // Com cliente: não gera cashback nem mensagem de obrigado.
    const withC = await api('/store/sales', { method: 'POST', token: kt, body: { ...body({ sold_on: ymd(1) }), anonymous: undefined, new_customer: { name: 'Maria Souza', phone: '(85) 98888-1234' } } }, 201);
    assert.equal(withC.sale.cashback_earned_cents || 0, 0);
    const msgs = await api('/store/kiosk/messages', { token: kt });
    assert.equal(msgs.items.some(m => m.sale_id === withC.sale.id), false, 'sem mensagem de obrigado');
    // Caixa de hoje: abre e não vê as vendas de outro dia.
    await api('/store/cash/open', { method: 'POST', token: kt, body: { opening_cents: 0, seller_id: bia, seller_pin: '4321' } }, 201);
    const today = await api('/store/kiosk/cash-today', { token: kt });
    assert.equal(today.sales.length, 0); assert.equal(today.expected_cash_cents, 0);
    const list = await api('/store/sales/backdated', { token: kt });
    assert.deepEqual(list.items.map(x => x.sold_on).sort(), [d10, ymd(1)].sort());
    assert.equal(list.items.find(x => x.id === r.sale.id).pieces, 2);
    // Impressão e cancelamento (devolve ao estoque).
    assert.equal((await api(`/store/sales/${r.sale.id}/print`, { token: kt })).installments, 2);
    assert.equal((await request(`/store/sales/${r.sale.id}/cancel`, { method: 'POST', token: kt, body: { reason: 'Lançada em dobro', seller_pin: '4321' } })).status, 200);
    assert.equal((await db.query('SELECT stock_qty FROM products WHERE id=$1', [prod])).rows[0].stock_qty, 3, 'volta 2 (a venda com cliente baixou outras 2)');
    // Painel da rede: dono vê os lançamentos.
    const owner = (await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Gabriel Mota', function: 'dono', email: 'gabriel@' + host, password: 'senha-do-gabriel-1' } }, 201));
    const g = await unitLogin(f.base, host, { email: 'gabriel@' + host, password: 'senha-do-gabriel-1' }).catch(() => null);
    const gt = g?.data?.token || (await request('/auth/login', { method: 'POST', token: null, body: { email: 'gabriel@' + host, password: 'senha-do-gabriel-1' } })).data.token;
    assert.ok(owner && gt);
    const ov = await api(`/network/overview?from=${ymd(30)}&to=${ymd(0)}`, { token: gt });
    assert.equal(ov.alerts.backdated.length, 2);
    assert.ok(ov.alerts.backdated.some(b => b.canceled && b.seller === 'Bia Souza'));
    // NFC-e nunca sai para venda de outro dia.
    assert.match(JSON.stringify(await api(`/master/sales/${withC.sale.id}/nfce-preview`, { token: masterToken }).catch(e => ({ e: String(e) }))), /outro dia|problems|Unidade sem/);
    void tenant;
  } finally { await f.cleanup(); }
});

test('tela do quiosque: lançar venda de outro dia e ver na lista', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const { tenant, base, db } = f;
    const { kt } = await setup(f, 'audace-bkp');
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(v => localStorage.setItem('fp_kiosk_token', v), kt);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(base + '/caixa');
    await page.waitForSelector('#closedBox:not([hidden])');
    await page.fill('#openCash', '0'); await page.click('#openBtn');
    await page.locator('#openWho [data-w]').first().click();
    await page.waitForSelector('#pinDlg[open]');
    for (const k of '4321') await page.click(`#keys [data-k="${k}"]`);
    await page.waitForSelector('#topClose:not([hidden])');
    await page.fill('#scan', '003622'); await page.press('#scan', 'Enter');
    await page.waitForFunction(() => !/Nenhuma/.test(document.getElementById('itemsInfo').textContent));
    await page.locator('#sellers [data-s]').first().click();
    for (const k of '4321') await page.click(`#keys [data-k="${k}"]`);
    await page.waitForFunction(() => !document.getElementById('pinDlg').open);
    await page.click('#pay [data-m="pix"]');
    await page.check('#backOn');
    assert.equal(await page.isDisabled('#finish'), true, 'sem data não lança');
    const d = ymd(17);
    await page.fill('#backDate', d); await page.dispatchEvent('#backDate', 'change');
    await page.waitForFunction(() => /Lançar venda do dia/.test(document.getElementById('finish').textContent));
    assert.match(await page.textContent('#backWarn'), /fora do caixa de hoje/);
    await page.screenshot(shot('venda-outro-dia'));
    await page.click('#finish');
    await page.waitForFunction(() => /lançada no dia/.test(document.getElementById('doneBox').textContent));
    const s = (await db.query("SELECT session_id, to_char(created_at AT TIME ZONE 'America/Fortaleza','YYYY-MM-DD') d, payment_method FROM sales WHERE tenant_id=$1", [tenant])).rows;
    assert.deepEqual(s, [{ session_id: null, d, payment_method: 'pix' }]);
    await page.click('[data-view="sales"]');
    await page.waitForSelector('#backCard:not([hidden]) #tBack tr');
    assert.match(await page.textContent('#tBack'), new RegExp(d.split('-').reverse().join('/')));
    assert.equal(await page.locator('#tSales [data-cx]').count(), 0, 'não entra nas vendas de hoje');
    await page.screenshot(shot('vendas-outro-dia-lista'));
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await f.cleanup(); }
});
