import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

const hostPost = (base, path, host, body) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: host, 'Content-Type': 'application/json' } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(JSON.parse(b || '{}')));
  });
  r.on('error', reject); r.write(JSON.stringify(body)); r.end();
});

// Caixa do quiosque com o pinpad simulado: cartão aprovado, recusado, sem resposta (pendência) e Pix.
test('caixa: cobrança no pinpad (simulador) antes de gravar a venda', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 240000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const { api, tenant, masterToken, base, db } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace', hostname: 'audace.example.test' } }, 201);
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Grand Shopping' } });
    await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-grand' } });
    const ana = await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Ana Paula', function: 'vendedora', unit_id: tenant, pin: '1234' } }, 201);
    await api(`/master/tenants/${tenant}/tef`, { method: 'PATCH', token: masterToken, body: { mode: 'simulator' } });
    const kt = (await hostPost(base, '/api/auth/unit', 'audace.example.test', { unit_id: tenant, password: 'senha-grand' })).token;
    await api('/store/cash/open', { method: 'POST', token: kt, body: { opening_cents: 0, seller_id: ana.id, seller_pin: '1234' } }, 201);
    await db.query(`INSERT INTO products(tenant_id, name, barcode, price_cents, stock_qty) VALUES
      ($1,'Corrente Aço Elo P','003622',4900,9), ($1,'Brinco recusa','000051',1051,9), ($1,'Anel sem resposta','000053',1053,9), ($1,'Pulseira Pix','000077',2000,9)`, [tenant]);

    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await context.addInitScript(v => localStorage.setItem('fp_kiosk_token', v), kt);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept(d.type() === 'prompt' ? 'Não passou no app da Stone' : undefined); });
    await page.goto(base + '/caixa.html');
    await page.waitForFunction(() => /SIMULADOR/.test(document.getElementById('st1').textContent));
    await page.waitForSelector('#cashBox:not([hidden])');

    const sell = async (code, payLabel) => {
      await page.locator('#scan').fill(code); await page.locator('#scan').press('Enter');
      await page.waitForFunction(c => document.getElementById('items').textContent.includes(c), code);
      if (payLabel) await page.locator('#pay button', { hasText: payLabel }).click();
      await page.locator('#sellers button', { hasText: 'Ana' }).click();
      for (const k of '1234') await page.keyboard.press(k);
      await page.waitForSelector('#pinOk:not([hidden])');
      await page.locator('#finish').click(); await page.locator('#rvOk').click();
    };

    // 1) Crédito aprovado: grava a venda com a cobrança do pinpad.
    assert.equal(await page.locator('#instRow').isVisible(), true, 'parcelas aparecem no crédito');
    await sell('003622');
    await page.waitForSelector('#doneBox:not([hidden])', { timeout: 20000 });
    assert.match(await page.locator('#doneBox').textContent(), /Venda nº \d+ registrada · R\$ 49,00/);
    await page.screenshot(shot('tef-aprovado'));
    let rows = (await db.query('SELECT t.status,t.method,t.amount_cents,t.sale_id IS NOT NULL has_sale,t.terminal_serial FROM tef_transactions t WHERE t.tenant_id=$1 ORDER BY created_at', [tenant])).rows;
    assert.deepEqual(rows, [{ status: 'approved', method: 'credit', amount_cents: 4900, has_sale: true, terminal_serial: 'SIM-PPC930' }]);
    await page.locator('#newSale').click();

    // 2) Recusado: mensagem e nenhuma venda nova.
    await sell('000051');
    await page.waitForFunction(() => /recusado/i.test(document.getElementById('saleMsg').textContent), null, { timeout: 20000 });
    assert.equal((await db.query('SELECT count(*)::int n FROM sales WHERE tenant_id=$1', [tenant])).rows[0].n, 1);
    // Troca o item para o "sem resposta": avisa para conferir antes de cobrar de novo.
    await page.locator('[data-del="0"]').click();
    await page.locator('#scan').fill('000053'); await page.locator('#scan').press('Enter');
    await page.waitForFunction(() => document.getElementById('items').textContent.includes('000053'));
    await page.locator('#finish').click(); await page.locator('#rvOk').click();
    await page.waitForFunction(() => /não respondeu/.test(document.getElementById('saleMsg').textContent), null, { timeout: 20000 });
    await page.screenshot(shot('tef-sem-resposta'));

    // 3) Pix: QR na tela, pagamento confirmado, venda gravada com Pix dinâmico.
    await page.locator('[data-del="0"]').click();
    await page.locator('#scan').fill('000077'); await page.locator('#scan').press('Enter');
    await page.waitForFunction(() => document.getElementById('items').textContent.includes('000077'));
    await page.locator('#pay button', { hasText: 'Pix' }).click();
    assert.equal(await page.locator('#instRow').isVisible(), false);
    await page.locator('#finish').click(); await page.locator('#rvOk').click();
    await page.waitForFunction(() => /Pix: R\$ 20,00/.test(document.getElementById('tefBox').textContent), null, { timeout: 20000 });
    await page.screenshot(shot('tef-pix-qr'));
    await page.waitForSelector('#doneBox:not([hidden])', { timeout: 20000 });
    rows = (await db.query("SELECT status,e2e_id FROM tef_transactions WHERE tenant_id=$1 AND method='pix'", [tenant])).rows;
    assert.equal(rows[0].status, 'approved'); assert.match(rows[0].e2e_id, /^E00000000SIM/);

    // 4) Pendências do pinpad: a cobrança sem resposta aparece e é resolvida depois de conferida.
    await db.query("UPDATE tef_transactions SET created_at=now()-interval '5 minutes' WHERE tenant_id=$1", [tenant]);
    await page.reload();
    await page.waitForSelector('#tefPend:not([hidden])');
    assert.match(await page.locator('#tefPend').textContent(), /R\$ 10,53 · Débito|R\$ 10,53 · Crédito/);
    assert.match(await page.locator('#tefPend').textContent(), /sem resposta do pinpad/);
    await page.screenshot(shot('tef-pendencias'));
    await page.locator('#tefPend [data-rs]').click();
    await page.waitForSelector('#tefPend', { state: 'hidden' });
    assert.equal((await db.query("SELECT resolved_note FROM tef_transactions WHERE tenant_id=$1 AND amount_cents=1053", [tenant])).rows[0].resolved_note, 'Não passou no app da Stone');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
