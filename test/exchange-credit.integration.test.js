import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Troca/devolução: peças voltam ao estoque da unidade da troca (casadas pelo código), crédito de troca separado do
// cashback, gerado pela vendedora com o PIN dela, usado na venda (até pagar tudo) e visível no painel da rede.
const unitLogin = (base, host, body) => new Promise((resolve, reject) => {
  const u = new URL(base + '/api/auth/unit');
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: host, 'Content-Type': 'application/json' } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(JSON.parse(b || '{}')));
  });
  r.on('error', reject); r.write(JSON.stringify(body)); r.end();
});

async function setup(f, slug) {
  const { api, tenant, masterToken, base, db } = f;
  const host = slug + '.example.test';
  const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug, hostname: host } }, 201);
  const sol = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Solares', slug: slug + '-solares' } }, 201);
  const units = [[tenant, 'Cascavel', 'senha-cascavel', 'Bia Souza', '4321'], [sol.id, 'Solares', 'senha-solares', 'Ana Lima', '1234']];
  const out = { net, host, sol: sol.id, kt: {}, seller: {}, prod: {} };
  for (const [id, label, pw, name, pin] of units) {
    await api(`/master/tenants/${id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: label } });
    await api('/master/tenants/' + id, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await db.query('UPDATE tenants SET cashback_enabled=true, cashback_percent=5, cashback_max_use_percent=100, cashback_valid_days=90, cashback_min_sale_cents=0 WHERE id=$1', [id]);
    await api(`/master/tenants/${id}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: pw } });
    await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name, function: 'vendedora', unit_id: id, pin } }, 201);
    out.seller[label] = { id: (await db.query('SELECT id FROM users WHERE name=$1', [name])).rows[0].id, pin };
    out.prod[label] = (await db.query("INSERT INTO products(tenant_id,name,barcode,code,price_cents,stock_qty) VALUES($1,'Brinco Gota','003622','003622',10000,5) RETURNING id", [id])).rows[0].id;
    out.kt[label] = (await unitLogin(base, host, { unit_id: id, password: pw })).token; assert.ok(out.kt[label], label);
    await api('/store/cash/open', { method: 'POST', token: out.kt[label], body: { opening_cents: 0, seller_id: out.seller[label].id, seller_pin: pin } }, 201);
  }
  return out;
}

test('troca: peça volta ao estoque, crédito separado do cashback, venda paga com crédito e painel da rede', { skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL' }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, db, masterToken } = f;
    const s = await setup(f, 'audace-tr');
    const K = s.kt.Cascavel, KS = s.kt.Solares, bia = s.seller.Cascavel, ana = s.seller.Solares;
    // Venda em Cascavel: 2 brincos (R$ 200) com 10% de desconto → R$ 180; cliente ganha cashback de 5% (R$ 9).
    const v1 = await api('/store/sales', { method: 'POST', token: K, body: { items: [{ product_id: s.prod.Cascavel, quantity: 2 }], discount_cents: 2000, payment_method: 'cash', new_customer: { name: 'Maria Souza', phone: '(85) 98888-1234' }, seller_id: bia.id, seller_pin: bia.pin } }, 201);
    assert.equal(v1.sale.total_cents, 18000); assert.equal(v1.sale.cashback_earned_cents, 900);
    const code = v1.sale.receipt_code, custId = v1.sale.customer_id;
    // Troca feita em Solares (outra unidade): atendimento + crédito com o PIN da vendedora, 1 brinco volta.
    let w = await api('/store/warranty/' + code, { token: KS });
    assert.equal(w.items.length, 1); assert.equal(w.items[0].quantity, 2); assert.equal(w.items[0].returned, 0);
    await api(`/store/warranty/${code}/claims`, { method: 'POST', token: KS, body: { kind: 'troca', note: 'Não gostou', seller_id: ana.id, seller_pin: ana.pin } }, 201);
    w = await api('/store/warranty/' + code, { token: KS });
    const claim = w.claims[0].id;
    assert.equal((await request(`/store/warranty/claims/${claim}/credit`, { method: 'POST', token: KS, body: { amount_cents: 9000, items: [{ sale_item_id: w.items[0].id, quantity: 1 }], seller_id: ana.id, seller_pin: '0000' } })).status, 401);
    assert.equal((await request(`/store/warranty/claims/${claim}/credit`, { method: 'POST', token: KS, body: { amount_cents: 9000, items: [{ sale_item_id: w.items[0].id, quantity: 3 }], seller_id: ana.id, seller_pin: ana.pin } })).status, 400, 'não volta mais do que vendeu');
    const cr = await api(`/store/warranty/claims/${claim}/credit`, { method: 'POST', token: KS, body: { amount_cents: 9000, items: [{ sale_item_id: w.items[0].id, quantity: 1 }], seller_id: ana.id, seller_pin: ana.pin } }, 201);
    assert.equal(cr.returned_pieces, 1);
    const stock = async id => (await db.query('SELECT stock_qty FROM products WHERE id=$1', [id])).rows[0].stock_qty;
    assert.equal(await stock(s.prod.Solares), 6, 'voltou para o estoque de Solares'); assert.equal(await stock(s.prod.Cascavel), 3);
    const mv = (await db.query("SELECT kind, quantity, stock_before, stock_after, note, created_by FROM stock_movements WHERE product_id=$1 AND kind='return'", [s.prod.Solares])).rows[0];
    assert.deepEqual([mv.quantity, mv.stock_before, mv.stock_after, mv.created_by], [1, 5, 6, ana.id]); assert.match(mv.note, /Troca · venda nº 1/);
    assert.equal((await api('/store/warranty/' + code, { token: KS })).items[0].returned, 1);
    // Saldos separados: cashback R$ 9, crédito de troca R$ 90.
    const c1 = await api('/store/sales/customers/' + custId, { token: K });
    assert.equal(c1.cashback.balance_cents, 900); assert.equal(c1.cashback.credit_cents, 9000);
    // Cashback não usa o crédito; crédito usa sem limite por compra.
    assert.equal((await request('/store/sales', { method: 'POST', token: K, body: { items: [{ product_id: s.prod.Cascavel, quantity: 1 }], payment_method: 'cash', customer_id: custId, cashback_use_cents: 1000, seller_id: bia.id, seller_pin: bia.pin } })).status, 400);
    const v2 = await api('/store/sales', { method: 'POST', token: K, body: { items: [{ product_id: s.prod.Cascavel, quantity: 1 }], payment_method: 'pix', customer_id: custId, credit_use_cents: 9000, seller_id: bia.id, seller_pin: bia.pin } }, 201);
    assert.equal(v2.sale.total_cents, 1000); assert.equal(v2.sale.credit_used_cents, 9000);
    assert.equal(v2.cashback.credit_cents ?? (await api('/store/sales/customers/' + custId, { token: K })).cashback.credit_cents, 0);
    // Devolução com crédito que paga a venda inteira (total zero).
    await api(`/store/warranty/${code}/claims`, { method: 'POST', token: K, body: { kind: 'devolucao', note: 'Devolveu o outro', seller_id: bia.id, seller_pin: bia.pin } }, 201);
    const w2 = await api('/store/warranty/' + code, { token: K });
    const claim2 = w2.claims.find(c => c.kind === 'devolucao').id;
    await api(`/store/warranty/claims/${claim2}/credit`, { method: 'POST', token: K, body: { amount_cents: 9000, items: [{ sale_item_id: w2.items[0].id, quantity: 1 }], seller_id: bia.id, seller_pin: bia.pin } }, 201);
    assert.equal(await stock(s.prod.Cascavel), 3, 'vendeu 1 (v2) e voltou 1');
    const v3 = await api('/store/sales', { method: 'POST', token: K, body: { items: [{ product_id: s.prod.Cascavel, quantity: 1, unit_price_cents: 8000 }], payment_method: 'other', customer_id: custId, credit_use_cents: 8000, seller_id: bia.id, seller_pin: bia.pin } }, 201);
    assert.equal(v3.sale.total_cents, 0); assert.equal(v3.sale.payment_method, 'other'); assert.equal(v3.sale.cashback_earned_cents || 0, 0);
    // Cancelar devolve o crédito usado.
    const cx = await api(`/store/sales/${v3.sale.id}/cancel`, { method: 'POST', token: K, body: { reason: 'Teste de troca', seller_pin: bia.pin } });
    assert.equal(cx.credit_returned_cents, 8000);
    assert.equal((await api('/store/sales/customers/' + custId, { token: K })).cashback.credit_cents, 9000);
    // Painel da rede (dono): trocas e créditos do período.
    await api(`/master/networks/${s.net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Gabriel Mota', function: 'dono', email: 'gabriel@' + s.host, password: 'senha-do-gabriel-1' } }, 201);
    const gt = (await request('/auth/login', { method: 'POST', token: null, body: { email: 'gabriel@' + s.host, password: 'senha-do-gabriel-1' } })).data.token;
    const ov = await api('/network/overview', { token: gt });
    assert.equal(ov.alerts.exchanges.length, 2);
    const t1 = ov.alerts.exchanges.find(e => e.unit === 'Solares');
    assert.deepEqual([t1.kind, t1.credit_cents, t1.pieces, t1.by_name, t1.customer], ['troca', 9000, 1, 'Ana Lima', 'Maria']);
  } finally { await f.cleanup(); }
});

test('tela do quiosque: gerar crédito de troca com a peça voltando e usar na venda', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const { api, db, base } = f;
    const s = await setup(f, 'audace-trp');
    const K = s.kt.Cascavel, bia = s.seller.Cascavel;
    const v1 = await api('/store/sales', { method: 'POST', token: K, body: { items: [{ product_id: s.prod.Cascavel, quantity: 1 }], payment_method: 'cash', new_customer: { name: 'Maria Souza', phone: '(85) 98888-1234' }, seller_id: bia.id, seller_pin: bia.pin } }, 201);
    await api(`/store/warranty/${v1.sale.receipt_code}/claims`, { method: 'POST', token: K, body: { kind: 'troca', note: 'Não gostou', seller_id: bia.id, seller_pin: bia.pin } }, 201);
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await context.addInitScript(v => localStorage.setItem('fp_kiosk_token', v), K);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(base + '/caixa');
    await page.waitForSelector('[data-view="warranty"]');
    await page.click('[data-view="warranty"]');
    await page.fill('#wCode', v1.sale.receipt_code); await page.press('#wCode', 'Enter');
    await page.waitForSelector('.wCredit');
    await page.click('.wCredit');
    await page.waitForSelector('#wCred [data-ri]');
    assert.equal(await page.inputValue('#wcVal'), '100,00');
    await page.screenshot(shot('troca-gerar-credito'));
    await page.locator('#wcWho [data-w]').first().click();
    await page.waitForSelector('#pinDlg[open]');
    for (const k of bia.pin) await page.click(`#keys [data-k="${k}"]`);
    await page.waitForFunction(() => /Crédito de troca de R\$\s*100,00 gerado e 1 peça voltou ao estoque/.test(document.getElementById('wMsg').textContent));
    assert.equal((await db.query('SELECT stock_qty FROM products WHERE id=$1', [s.prod.Cascavel])).rows[0].stock_qty, 5);
    // Nova venda paga toda com o crédito.
    await page.click('[data-view="cash"]');
    await page.fill('#scan', '003622'); await page.press('#scan', 'Enter');
    await page.waitForFunction(() => !/Nenhuma/.test(document.getElementById('itemsInfo').textContent));
    await page.fill('#custQ', 'Maria');
    await page.waitForSelector('#custResults [data-c], #custResults button, #custResults li');
    await page.locator('#custResults [data-c], #custResults button, #custResults li').first().click();
    await page.waitForSelector('#crBox:not([hidden])');
    assert.match(await page.textContent('#crVal'), /100,00/);
    await page.check('#crUse');
    await page.waitForFunction(() => /Pago com crédito de troca/.test(document.getElementById('totalLabel').textContent));
    await page.locator('#sellers [data-s]').first().click();
    for (const k of bia.pin) await page.click(`#keys [data-k="${k}"]`);
    await page.waitForFunction(() => !document.getElementById('pinDlg').open);
    await page.screenshot(shot('venda-com-credito-troca'));
    await page.click('#finish');
    await page.waitForFunction(() => /registrada/.test(document.getElementById('doneBox').textContent), null, { timeout: 15000 });
    const last = (await db.query('SELECT total_cents, credit_used_cents, payment_method FROM sales WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1', [f.tenant])).rows[0];
    assert.deepEqual(last, { total_cents: 0, credit_used_cents: 10000, payment_method: 'other' });
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await f.cleanup(); }
});
