import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Quiosque (/caixa): cadastro completo da cliente na venda, aba Clientes com histórico,
// "Fechar caixa" no topo com o PIN de quem fecha e, no estoque, a unidade aberta na primeira coluna.
const unitLogin = (base, body) => new Promise((resolve, reject) => {
  const u = new URL(base + '/api/auth/unit');
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: 'audace-p.example.test', 'Content-Type': 'application/json' } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(JSON.parse(b || '{}')));
  });
  r.on('error', reject); r.write(JSON.stringify(body)); r.end();
});

test('quiosque: cadastro completo, aba Clientes, Fechar caixa no topo e unidade primeiro no estoque', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const { api, tenant, masterToken, base } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace-p', hostname: 'audace-p.example.test' } }, 201);
    const aquiraz = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Aquiraz', slug: 'audace-aquiraz-p' } }, 201);
    for (const [id, label] of [[aquiraz.id, 'Aquiraz · Briza'], [tenant, 'Cascavel']]) {
      await api(`/master/tenants/${id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: label } });
      await api('/master/tenants/' + id, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    }
    await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-cascavel' } });
    await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Bia Souza', function: 'vendedora', unit_id: tenant, pin: '4321' } }, 201);
    for (const t of [tenant, aquiraz.id]) await f.db.query("INSERT INTO products(tenant_id,name,barcode,code,price_cents,stock_qty) VALUES($1,'Brinco Gota','003622','003622',5000,$2)", [t, t === tenant ? 3 : 7]);
    const kt = (await unitLogin(base, { unit_id: tenant, password: 'senha-cascavel' })).token; assert.ok(kt);

    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(v => localStorage.setItem('fp_kiosk_token', v), kt);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(base + '/caixa');
    // Abrir o caixa: escolhe quem abre e digita o PIN.
    await page.waitForSelector('#closedBox:not([hidden])');
    await page.fill('#openCash', '0'); await page.click('#openBtn');
    await page.locator('#openWho [data-w]').first().click();
    await page.waitForSelector('#pinDlg[open]');
    await page.screenshot(shot('kiosk-open-pin'));
    for (const k of '4321') await page.click(`#keys [data-k="${k}"]`);
    await page.waitForSelector('#topClose:not([hidden])');
    assert.equal((await f.db.query("SELECT u.name FROM cash_sessions c JOIN users u ON u.id=c.opened_by WHERE c.tenant_id=$1 AND c.status='open'", [tenant])).rows[0].name, 'Bia Souza');

    // Venda com cadastro completo.
    await page.fill('#scan', '003622'); await page.press('#scan', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('#items tr').length === 1 && !/Nenhuma/.test(document.getElementById('itemsInfo').textContent));
    await page.click('#newCustBtn');
    for (const id of ['nc_name', 'nc_phone', 'nc_cpf', 'nc_birth_date', 'nc_email', 'nc_postal_code', 'nc_address']) assert.ok(await page.isVisible('#' + id), id);
    await page.fill('#nc_name', 'Maria Souza'); await page.fill('#nc_phone', '(85) 98888-1234'); await page.fill('#nc_cpf', '111.111.111-11');
    await page.fill('#nc_birth_date', '1990-05-12'); await page.fill('#nc_email', 'maria@email.com'); await page.fill('#nc_postal_code', '62800-000'); await page.fill('#nc_address', 'Rua A, 10, Centro, Cascavel');
    await page.screenshot(shot('kiosk-new-customer'));
    await page.locator('#sellers [data-s]').first().click();
    for (const k of '4321') await page.click(`#keys [data-k="${k}"]`);
    await page.waitForFunction(() => !document.getElementById('pinDlg').open);
    await page.click('#finish'); await page.click('#rvOk');
    await page.waitForFunction(() => /CPF inválido/.test(document.getElementById('saleMsg').textContent));
    await page.fill('#nc_cpf', '090.961.743-05');
    await page.click('#finish'); await page.click('#rvOk');
    await page.waitForFunction(() => document.querySelectorAll('#items tr').length === 0 || /Venda/.test(document.body.innerText), null, { timeout: 10000 });
    await page.waitForTimeout(500);
    const row = (await f.db.query("SELECT cpf,to_char(birth_date,'YYYY-MM-DD') b,email,postal_code,address FROM customers WHERE name='Maria Souza'")).rows[0];
    assert.deepEqual(row, { cpf: '09096174305', b: '1990-05-12', email: 'maria@email.com', postal_code: '62800000', address: 'Rua A, 10, Centro, Cascavel' });

    // Aba Clientes: lista, histórico e edição.
    await page.click('[data-view="clients"]');
    await page.waitForSelector('#clRows tr.clrow');
    assert.match(await page.textContent('#clRows'), /Maria Souza[\s\S]*Cascavel[\s\S]*R\$ 50,00/);
    await page.screenshot(shot('kiosk-clients'));
    await page.click('#clRows tr.clrow');
    await page.waitForSelector('#chDlg[open] .hsale');
    const hist = await page.textContent('#chBody');
    assert.match(hist, /090\.961\.743-05/); assert.match(hist, /12\/05\/1990/); assert.match(hist, /Brinco Gota/); assert.match(hist, /Bia Souza/);
    await page.screenshot(shot('kiosk-client-history'));
    await page.click('#chEdit'); await page.waitForSelector('#cuDlg[open]');
    assert.equal(await page.inputValue('#cu_email'), 'maria@email.com');
    await page.fill('#cu_email', 'maria@novo.com'); await page.click('#cuSave');
    await page.waitForFunction(() => /maria@novo\.com/.test(document.getElementById('chBody').textContent));
    await page.click('#chX');
    await page.click('#clNew'); await page.fill('#cu_name', 'Carla Dias'); await page.fill('#cu_phone', '88999990000'); await page.click('#cuSave');
    await page.waitForFunction(() => document.getElementById('chDlg').open && /Carla Dias/.test(document.getElementById('chBody').textContent));
    await page.click('#chX');

    // Estoque: Cascavel (unidade aberta) é a primeira coluna.
    await page.click('[data-view="stock"]');
    await page.waitForSelector('#sfHead th.u');
    const heads = await page.$$eval('#sfHead th.u', ths => ths.map(t => t.textContent.trim()));
    assert.match(heads[0], /^Cascavel/); assert.match(heads[1], /Aquiraz/);
    const firstRow = await page.$$eval('#sfRes tr:first-child td.u', tds => tds.map(t => t.textContent.trim()));
    assert.deepEqual(firstRow, ['2', '7']);
    await page.screenshot(shot('kiosk-stock'));

    // Fechar caixa no topo, com o PIN de quem fecha.
    await page.click('[data-view="cash"]');
    await page.click('#topClose'); await page.waitForSelector('#clDlg[open]');
    await page.waitForFunction(() => /R\$/.test(document.getElementById('cdExp').textContent));
    await page.screenshot(shot('kiosk-close-dialog'));
    await page.fill('#cdCash', '0');
    await page.locator('#cdWho [data-w]').first().click();
    await page.waitForSelector('#pinDlg[open]');
    for (const k of '4321') await page.click(`#keys [data-k="${k}"]`);
    await page.waitForSelector('#closedBox:not([hidden]) #closedInfo:not([hidden])');
    assert.match(await page.textContent('#closedInfo'), /Caixa fechado por Bia Souza/);
    assert.equal(await page.isHidden('#topClose'), true);
    await page.screenshot(shot('kiosk-closed'));
    const s = (await f.db.query("SELECT u.name FROM cash_sessions c JOIN users u ON u.id=c.closed_by WHERE c.tenant_id=$1 AND c.status='closed'", [tenant])).rows[0];
    assert.equal(s.name, 'Bia Souza');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
