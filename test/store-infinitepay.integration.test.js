import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// InfinitePay de mentira: guarda os links criados e responde o /payment_check conforme o teste mandar.
async function fakeInfinitePay() {
  const links = [], checks = []; const paid = new Set();
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const ch of req) raw += ch; const body = raw ? JSON.parse(raw) : {};
    const send = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.headers['x-api-key'] !== 'inchk_teste') return send(401, { message: 'chave errada' });
    if (req.url === '/links') { links.push(body); return send(200, { url: 'https://checkout.infinitepay.io/teste/' + body.order_nsu }); }
    if (req.url === '/payment_check') {
      checks.push(body); const link = links.find(l => l.order_nsu === body.order_nsu);
      const ok = link && paid.has(body.order_nsu) && body.slug === 'slug-' + body.order_nsu && body.transaction_nsu === 'nsu-' + body.order_nsu;
      return send(200, { success: !!ok, paid: !!ok, amount: link?.items[0].price, paid_amount: link?.items[0].price, installments: 1, capture_method: 'pix' });
    }
    send(404, {});
  });
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  return { url: `http://127.0.0.1:${srv.address().port}`, links, checks, paid, close: () => new Promise(r => srv.close(r)) };
}

test('Pix pela InfinitePay: QR na hora, aviso conferido e venda registrada', { skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL', timeout: 180000 }, async () => {
  const ip = await fakeInfinitePay();
  const f = await createStoreFixture({ env: { INFINITEPAY_API_URL: ip.url, INFINITEPAY_KEY_LOJA_IP_TESTE: 'inchk_teste', PUBLIC_BASE_URL: 'https://app.exemplo.test' } });
  let browser;
  try {
    const { api, request, tenant, foreignTenant, masterToken, foreignToken, db, base } = f;
    for (const t of [tenant, foreignTenant]) await api('/master/tenants/' + t, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    // Sem a chave da loja no servidor: desligado.
    assert.equal((await api('/store/sales/config')).infinitepay, false);
    assert.equal((await request('/store/sales/pix-charges', { method: 'POST', body: { sale: { anonymous: true, total_cents: 2500 }, amount_cents: 2500 } })).status, 409);
    await db.query("UPDATE tenants SET slug='loja-ip-teste' WHERE id=$1", [tenant]);
    assert.equal((await api('/store/sales/config')).infinitepay, true);
    assert.equal((await api('/store/sales/config', { token: foreignToken })).infinitepay, false); // outra loja continua sem

    // Caixa fechado: não cobra.
    assert.equal((await request('/store/sales/pix-charges', { method: 'POST', body: { sale: { anonymous: true, total_cents: 2500 }, amount_cents: 2500 } })).status, 409);
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    // Só Pix, uma forma.
    assert.equal((await request('/store/sales/pix-charges', { method: 'POST', body: { sale: { anonymous: true, total_cents: 2500, payment_method: 'cash' }, amount_cents: 2500 } })).status, 400);

    const ch = await api('/store/sales/pix-charges', { method: 'POST', body: { sale: { new_customer: { name: 'Maria Pix', phone: '85999990000' }, total_cents: 2500, description: 'Troca de tela' }, amount_cents: 2500 } }, 201);
    assert.equal(ch.status, 'pending'); assert.match(ch.qr, /^data:image\/png;base64,/); assert.equal(ch.checkout_url, 'https://checkout.infinitepay.io/teste/' + ch.id);
    const link = ip.links.at(-1);
    assert.equal(link.order_nsu, ch.id); assert.deepEqual(link.items, [{ quantity: 1, price: 2500, description: 'Troca de tela' }]);
    const hook = new URL(link.webhook_url); assert.equal(hook.origin, 'https://app.exemplo.test');
    const callHook = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const hookPath = hook.pathname + hook.search;

    // Ainda não pago: não registra.
    assert.equal((await api('/store/sales/pix-charges/' + ch.id)).status, 'pending');
    assert.equal((await request(`/store/sales/pix-charges/${ch.id}/finish`, { method: 'POST', body: {} })).status, 409);
    // Aviso sem token certo é ignorado; aviso falso (InfinitePay diz que não pagou) não marca pago.
    assert.equal((await callHook(hook.pathname + '?t=errado', { order_nsu: ch.id, invoice_slug: 'slug-' + ch.id, transaction_nsu: 'nsu-' + ch.id })).status, 404);
    assert.equal((await callHook(hookPath, { order_nsu: ch.id, invoice_slug: 'slug-' + ch.id, transaction_nsu: 'nsu-' + ch.id, amount: 2500 })).status, 200);
    assert.equal((await api('/store/sales/pix-charges/' + ch.id)).status, 'pending');
    // Outra loja não enxerga.
    assert.equal((await request('/store/sales/pix-charges/' + ch.id, { token: foreignToken })).status, 404);

    // Pagou de verdade: a próxima consulta do painel confere e marca pago.
    ip.paid.add(ch.id);
    const st = await api('/store/sales/pix-charges/' + ch.id);
    assert.equal(st.status, 'paid'); assert.equal(st.paid_amount_cents, 2500); assert.equal(st.capture_method, 'pix');
    assert.equal((await request(`/store/sales/pix-charges/${ch.id}/finish`, { method: 'POST', body: {}, token: foreignToken })).status, 404);
    const sale = await api(`/store/sales/pix-charges/${ch.id}/finish`, { method: 'POST', body: {} }, 201);
    assert.equal(sale.sale.payment_method, 'pix'); assert.equal(sale.sale.total_cents, 2500); assert.equal(sale.customer.name, 'Maria Pix');
    assert.equal((await request(`/store/sales/pix-charges/${ch.id}/finish`, { method: 'POST', body: {} })).status, 409); // uma vez só
    assert.equal((await db.query('SELECT sale_id FROM pix_charges WHERE id=$1', [ch.id])).rows[0].sale_id, sale.sale.id);
    let cash = await api('/store/cash');
    assert.equal(cash.summary.by_method.pix.total_cents, 2500); assert.equal(cash.summary.sales_count, 1);

    // Aviso chegando direto (webhook) também marca pago, mesmo com a cobrança cancelada no painel antes.
    const ch2 = await api('/store/sales/pix-charges', { method: 'POST', body: { sale: { anonymous: true, total_cents: 1000 }, amount_cents: 1000 } }, 201);
    await api(`/store/sales/pix-charges/${ch2.id}/cancel`, { method: 'POST', body: {} });
    assert.equal((await request(`/store/sales/pix-charges/${ch2.id}/cancel`, { method: 'POST', body: {} })).status, 409);
    ip.paid.add(ch2.id);
    const h2 = new URL(ip.links.at(-1).webhook_url);
    assert.equal((await callHook(h2.pathname + h2.search, { data: { order_nsu: ch2.id, invoice_slug: 'slug-' + ch2.id, transaction_nsu: 'nsu-' + ch2.id } })).status, 200);
    let open = (await api('/store/sales/pix-charges')).charges;
    assert.equal(open.find(c => c.id === ch2.id).status, 'paid'); // aparece para registrar
    assert.ok(!open.some(c => c.id === ch.id)); // já registrada: some da lista

    // Valor pago diferente do total da venda: não registra sozinho, avisa.
    const ch3 = await api('/store/sales/pix-charges', { method: 'POST', body: { sale: { anonymous: true, total_cents: 3000 }, amount_cents: 2900 } }, 201);
    ip.paid.add(ch3.id); const h3 = new URL(ip.links.at(-1).webhook_url);
    assert.equal((await callHook(h3.pathname + h3.search, { order_nsu: ch3.id, invoice_slug: 'slug-' + ch3.id, transaction_nsu: 'nsu-' + ch3.id })).status, 200);
    assert.equal((await api('/store/sales/pix-charges/' + ch3.id)).status, 'paid');
    const e3 = await request(`/store/sales/pix-charges/${ch3.id}/finish`, { method: 'POST', body: {} });
    assert.equal(e3.status, 409); assert.match(e3.data.error, /R\$ 29,00.*R\$ 30,00/);
    cash = await api('/store/cash'); assert.equal(cash.summary.sales_count, 1);

    // Painel: botão Pix abre a janela com o QR e muda sozinha para "Pago" quando o Pix cai.
    if (process.env.BROWSER_EXECUTABLE) {
      const require = createRequire(import.meta.url);
      let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
      browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
      const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } }); await context.addInitScript(v => sessionStorage.setItem('nv_token', v), f.ownerToken);
      const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(base + '/loja.html');
      await page.locator('.nv-sidebar [data-view="cash"]').click();
      await page.waitForSelector('#fsSale');
      // Lista "Pix pela InfinitePay": a paga sem venda (ch2) tem "Registrar venda".
      await page.waitForSelector(`#fsPixOpen:not([hidden]) [data-pixo-finish="${ch2.id}"]`);
      await page.locator(`[data-pixo-finish="${ch2.id}"]`).click();
      await page.waitForFunction(() => /registrada \(Pix InfinitePay\): R\$\s?10,00/.test(document.getElementById('panelFeedback')?.textContent || ''));
      // Venda nova no Pix: abre a janela com o QR, aguarda, e muda sozinha para "Pago".
      await page.locator('#fsSale [name=total]').fill('45');
      await page.locator('#fsSale [name=method][value=pix]').check({ force: true });
      await page.getByRole('button', { name: 'Não quis se identificar' }).click();
      await page.locator('#fsSaleBtn').click();
      await page.waitForSelector('#editorDialog[open] .fs-pix-qr');
      await page.waitForFunction(() => /Aguardando pagamento/.test(document.querySelector('[data-pix-state]').textContent));
      assert.match(await page.locator('#editorDialog .fs-pix-amt').textContent(), /R\$\s?45,00/);
      if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/pix-aguardando.png' });
      const id = await page.locator('[data-pix]').getAttribute('data-pix');
      ip.paid.add(id); const hp = new URL(ip.links.find(l => l.order_nsu === id).webhook_url);
      assert.equal((await callHook(hp.pathname + hp.search, { order_nsu: id, invoice_slug: 'slug-' + id, transaction_nsu: 'nsu-' + id })).status, 200);
      await page.waitForFunction(() => /Pago — R\$\s?45,00 · venda #\d+ registrada/.test(document.querySelector('[data-pix-state]')?.textContent || ''), null, { timeout: 15000 });
      if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/pix-pago.png' });
      cash = await api('/store/cash'); assert.equal(cash.summary.by_method.pix.total_cents, 2500 + 1000 + 4500);
      assert.deepEqual(errors, []);
    }
  } finally { if (browser) await browser.close(); await f.cleanup(); await ip.close(); }
});
