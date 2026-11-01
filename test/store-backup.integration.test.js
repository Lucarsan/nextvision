import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('backup cifrado da loja: o PC baixa, ninguém lê, só a central abre e restaura', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignTenant, masterToken, base } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const sale = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Maria Backup', phone: '85 98888-7777' }, total_cents: 4500, payment_method: 'pix' } }, 201);
    await api('/store/products', { method: 'POST', body: { kind: 'part', name: 'Tela', device_model: 'Galaxy A12', supplier: 'João Peças', cost_cents: 8000, stock_qty: 2 } }, 201);

    const activate = async t => { const code = await api('/master/tenants/' + t + '/activation-codes', { method: 'POST', token: masterToken }, 201);
      return (await api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: 'PC' } }, 201)).device_token; };
    const device = await activate(tenant);
    const get = token => fetch(base + '/api/connect/backup', { headers: { Authorization: 'Bearer ' + token } });

    // O PC recebe um arquivo binário cifrado: sem texto legível de clientes, vendas ou peças.
    const r = await get(device);
    assert.equal(r.status, 200);
    const file = Buffer.from(await r.arrayBuffer()), id = r.headers.get('x-backup-id');
    assert.equal(file.subarray(0, 6).toString(), 'FPBK1\n');
    assert.equal(crypto.createHash('sha256').update(file).digest('hex'), r.headers.get('x-backup-sha256'));
    for (const secret of ['Maria Backup', '98888', 'Galaxy', 'João']) assert.ok(!file.includes(Buffer.from(secret)), 'legível no arquivo: ' + secret);
    assert.throws(() => zlib.gunzipSync(file.subarray(200)), 'conteúdo não é um gzip comum');

    // Uma vez por hora por computador; confirmação de gravação confere tamanho e SHA-256.
    assert.equal((await get(device)).status, 429);
    assert.equal((await request(`/connect/backup/${id}/saved`, { method: 'POST', token: device, body: { bytes: file.length, sha256: '0'.repeat(64) } })).status, 409);
    await api(`/connect/backup/${id}/saved`, { method: 'POST', token: device, body: { bytes: file.length, sha256: r.headers.get('x-backup-sha256') } });
    const list = await api('/master/tenants/' + tenant + '/backups', { token: masterToken });
    assert.equal(list.length, 1); assert.ok(list[0].saved_at); assert.equal(list[0].device_name, 'PC');
    assert.equal((await request('/master/tenants/' + tenant + '/backups')).status, 403, 'lojista não vê nem abre backups');

    const post = (path, body, token = masterToken, extra = '') => fetch(base + '/api/master/backups/' + path + extra, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body });
    // Só a central abre. Lojista não consegue; arquivo alterado em 1 byte é recusado.
    assert.equal((await post('inspect', file, f.ownerToken)).status, 403);
    const info = await (await post('inspect', file)).json();
    assert.equal(info.tenant_id, tenant); assert.equal(info.tables.customers, 1); assert.equal(info.tables.sales, 1); assert.ok(info.tables.products >= 1);
    const bad = Buffer.from(file); bad[bad.length - 5] ^= 1;
    assert.equal((await post('inspect', bad)).status, 422);
    assert.equal((await post('inspect', Buffer.from('qualquer coisa'))).status, 400);
    // Trocar a loja no cabeçalho não engana: a chave é por loja e o cabeçalho é autenticado.
    const forged = Buffer.from(file.toString('latin1').replace(tenant, foreignTenant), 'latin1');
    assert.equal((await post('inspect', forged)).status, 422);

    // Exportar: JSON completo para a central.
    const exp = await (await post('export', file)).json();
    assert.equal(exp.tables.customers[0].name, 'Maria Backup');
    assert.equal(exp.tables.sales[0].total_cents, 4500);

    // Desastre: a venda e o cliente somem do banco. Restaurar devolve só o que falta, sem duplicar.
    await f.db.query('DELETE FROM loyalty_checkins WHERE tenant_id=$1', [tenant]);
    await f.db.query('DELETE FROM sale_items WHERE tenant_id=$1', [tenant]);
    await f.db.query('DELETE FROM sales WHERE tenant_id=$1', [tenant]);
    await f.db.query('DELETE FROM customers WHERE tenant_id=$1', [tenant]);
    assert.equal((await post('restore', file)).status, 400, 'restaurar exige confirmar a loja');
    const rest = await (await post('restore', file, masterToken, '?tenant=' + tenant)).json();
    assert.equal(rest.inserted.customers, 1); assert.equal(rest.inserted.sales, 1);
    assert.ok(!rest.inserted.products, 'o que já existe não é inserido de novo');
    assert.deepEqual(rest.failed, {});
    const back = await f.db.query('SELECT c.name,s.total_cents FROM sales s JOIN customers c ON c.id=s.customer_id WHERE s.id=$1', [sale.sale.id]);
    assert.deepEqual(back.rows[0], { name: 'Maria Backup', total_cents: 4500 });
    const again = await (await post('restore', file, masterToken, '?tenant=' + tenant)).json();
    assert.deepEqual(again.inserted, {}, 'restaurar de novo não muda nada');

  } finally { await f.cleanup(); }
});

// Agente Windows (PowerShell): baixa o backup, confere SHA-256, guarda na pasta de backups e confirma.
test('agente guarda o backup diário da loja e não baixa de novo antes de 24 h', { skip: process.env.TEST_DATABASE_URL && process.env.PWSH_BINARY ? false : 'Set TEST_DATABASE_URL and PWSH_BINARY' }, async () => {
  const f = await createStoreFixture(); const programData = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-backup-'));
  try {
    const { api, tenant, masterToken, base } = f;
    const code = await api('/master/tenants/' + tenant + '/activation-codes', { method: 'POST', token: masterToken }, 201);
    const token = (await api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: 'PC loja' } }, 201)).device_token;
    const MODULE = path.resolve('installer/windows/payload/FicouPronto.psm1');
    const ps = script => { const run = spawnSync(process.env.PWSH_BINARY, ['-NoProfile', '-NonInteractive', '-Command', `$env:ProgramData='${programData}'; Import-Module '${MODULE}' -Force; $c=[pscustomobject]@{ api_base='${base}' }; ${script}`], { encoding: 'utf8', timeout: 60000 });
      assert.equal(run.status, 0, run.stderr || run.stdout); return run.stdout.trim(); };
    const dir = path.join(programData, 'FicouPronto', 'backups');
    const first = JSON.parse(ps(`Sync-FpBackup $c '${token}' | ConvertTo-Json -Compress`));
    assert.equal(first.state, 'ok'); assert.match(first.detail, /ultimo em .* \(1 guardados\)/);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1); assert.match(files[0], /^ficoupronto-\d{8}-\d{6}\.fpbak$/);
    assert.equal(fs.readFileSync(path.join(dir, files[0])).subarray(0, 6).toString(), 'FPBK1\n');
    const list = await api('/master/tenants/' + tenant + '/backups', { token: masterToken });
    assert.equal(list.length, 1); assert.ok(list[0].saved_at, 'agente confirmou a gravação');
    // Menos de 24 h: não baixa. Forçando (0 h), a central limita a 1 por hora e o agente segue sem erro.
    ps(`Sync-FpBackup $c '${token}' | Out-Null`);
    const forced = JSON.parse(ps(`Sync-FpBackup $c '${token}' 0 | ConvertTo-Json -Compress`));
    assert.equal(forced.state, 'ok'); assert.equal(fs.readdirSync(dir).length, 1);
    assert.equal((await api('/master/tenants/' + tenant + '/backups', { token: masterToken })).length, 1);
    // Central fora do ar: backup antigo continua guardado e o estado avisa a falha.
    const down = JSON.parse(ps(`$c.api_base='http://127.0.0.1:9'; Sync-FpBackup $c '${token}' 0 | ConvertTo-Json -Compress`));
    assert.equal(down.state, 'degraded'); assert.match(down.detail, /sem conexao/); assert.equal(fs.readdirSync(dir).length, 1);
  } finally { fs.rmSync(programData, { recursive: true, force: true }); await f.cleanup(); }
});

// Central: página Backups lista o histórico, abre o arquivo e restaura o que falta.
test('central abre o arquivo de backup e restaura', { skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000 }, async () => {
  const f = await createStoreFixture(); let browser; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-bk-ui-'));
  try {
    const { api, tenant, masterToken, base } = f;
    await f.db.query("INSERT INTO customers(tenant_id,name,phone) VALUES($1,'Cliente Perdido','85999990000')", [tenant]);
    const code = await api('/master/tenants/' + tenant + '/activation-codes', { method: 'POST', token: masterToken }, 201);
    const token = (await api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: 'PC balcão' } }, 201)).device_token;
    const file = path.join(dir, 'loja.fpbak');
    fs.writeFileSync(file, Buffer.from(await (await fetch(base + '/api/connect/backup', { headers: { Authorization: 'Bearer ' + token } })).arrayBuffer()));
    await f.db.query("DELETE FROM customers WHERE name='Cliente Perdido'");
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } }); await context.addInitScript(v => sessionStorage.setItem('nv_token', v), masterToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(base + '/central.html');
    await page.locator('.ct-nav-btn[data-page="Backups"]').click();
    await page.locator('#bkTenant').selectOption(tenant);
    await page.waitForSelector('#bkList table');
    assert.match(await page.locator('#bkList').innerText(), /PC balcão/);
    await page.locator('#bkFile').setInputFiles(file);
    await page.waitForSelector('#bkRestore');
    assert.match(await page.locator('#bkInfo').innerText(), /Clientes\s+1/);
    await page.locator('#bkRestore').click();
    await page.waitForSelector('#bkResult table');
    assert.match(await page.locator('#bkResult').innerText(), /Clientes\s+1/);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM customers WHERE name='Cliente Perdido'")).rows[0].n, 1);
    if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/central-backups.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); fs.rmSync(dir, { recursive: true, force: true }); await f.cleanup(); }
});
