import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import pg from 'pg';
import jwt from 'jsonwebtoken';

test('order history and recording scheduling across multiple steps', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL to a local test PostgreSQL URL',
  timeout: 60000
}, async t => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const schema = 'nv_steps_' + crypto.randomBytes(8).toString('hex');
  const db = new pg.Client({ connectionString: url.toString(), ssl: false });
  let server;
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    // Reproduce upgrading an existing installation, including a completed order.
    for (const file of (await readdir('sql')).filter(file => file.endsWith('.sql') && file < '014').sort()) {
      await db.query(await readFile('sql/' + file, 'utf8'));
    }
    const ids = Array.from({ length: 10 }, () => crypto.randomUUID());
    const [tenant, foreignTenant, owner, foreignOwner, cameraA, cameraB, foreignCamera, device, foreignDevice, customer] = ids;
    await db.query("INSERT INTO tenants(id,name,slug,status) VALUES($1,'Steps store',$2,'active'),($3,'Foreign store',$4,'active')", [tenant, schema, foreignTenant, schema + '-foreign']);
    await db.query("INSERT INTO users(id,tenant_id,name,email,password_hash,role) VALUES($1,$2,'Owner',$3,'unused','owner'),($4,$5,'Foreign owner',$6,'unused','owner')", [owner, tenant, schema + '@example.test', foreignOwner, foreignTenant, schema + '-foreign@example.test']);
    const deviceToken = 'nvdev_' + crypto.randomBytes(32).toString('hex');
    const foreignDeviceToken = 'nvdev_' + crypto.randomBytes(32).toString('hex');
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    await db.query("INSERT INTO shop_devices(id,tenant_id,name,credential_hash) VALUES($1,$2,'Test machine',$3),($4,$5,'Foreign machine',$6)", [device, tenant, digest(deviceToken), foreignDevice, foreignTenant, digest(foreignDeviceToken)]);
    await db.query("INSERT INTO cameras(id,tenant_id,name,device_id) VALUES($1,$2,'Camera A',$3),($4,$2,'Camera B',$3),($5,$6,'Foreign camera',$7)", [cameraA, tenant, device, cameraB, foreignCamera, foreignTenant, foreignDevice]);
    await db.query("INSERT INTO customers(id,tenant_id,name) VALUES($1,$2,'Test customer')", [customer, tenant]);
    const legacyProcess = crypto.randomUUID(), legacyOrder = crypto.randomUUID();
    await db.query("INSERT INTO processes(id,tenant_id,name,steps,camera_id) VALUES($1,$2,'Legacy service','[\"Original stage\"]',$3)", [legacyProcess, tenant, cameraA]);
    await db.query("INSERT INTO orders(id,tenant_id,process_id,status,public_token_hash) VALUES($1,$2,$3,'completed',$4)", [legacyOrder, tenant, legacyProcess, digest(crypto.randomBytes(16))]);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    const env = { ...process.env, DATABASE_URL: url.toString(), DB_SSL: 'disable' };
    const migrate = () => {
      const result = spawnSync(process.execPath, ['src/migrate.js'], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    await t.test('migration upgrades existing orders and is repeatable without rewriting history', async () => {
      migrate();
      const first = (await db.query('SELECT process_snapshot FROM orders WHERE id=$1', [legacyOrder])).rows[0].process_snapshot;
      assert.deepEqual(first.steps, ['Original stage']);
      await db.query("UPDATE processes SET name='Changed legacy service',steps='[\"Changed stage\"]' WHERE id=$1", [legacyProcess]);
      migrate();
      assert.deepEqual((await db.query('SELECT process_snapshot FROM orders WHERE id=$1', [legacyOrder])).rows[0].process_snapshot, first);
    });

    const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const { port } = listener.address(); await new Promise(resolve => listener.close(resolve));
    const secret = crypto.randomBytes(32).toString('hex');
    server = spawn(process.execPath, ['src/server.js'], { env: { ...env, PORT: String(port), JWT_SECRET: secret, RESEND_API_KEY: '', EMAIL_FROM: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.resume();
    const ownerToken = jwt.sign({ id: owner, tenant_id: tenant, role: 'owner' }, secret, { algorithm: 'HS256' });
    const foreignOwnerToken = jwt.sign({ id: foreignOwner, tenant_id: foreignTenant, role: 'owner' }, secret, { algorithm: 'HS256' });
    const request = async (path, { method = 'GET', body, token = ownerToken } = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}` + path, {
        method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000)
      });
      return { status: res.status, data: await res.json() };
    };
    const ok = async (path, options, expected = 200) => { const result = await request(path, options); assert.equal(result.status, expected, result.data.error); return result.data; };
    for (let attempt = 0; ; attempt++) {
      try { await ok('/health'); break; }
      catch { assert.ok(attempt < 40, 'Test API must start'); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    const initial = { name: 'Three-stage service', steps: ['Reception', 'Repair', 'Delivery'], camera_id: cameraA, step_cameras: { 1: cameraB, 2: null } };
    const updated = { name: 'New service version', steps: ['Inspection', 'Ready'], camera_id: cameraB, step_cameras: {} };
    let processID, orderID, trackingPath, quickOrderID;
    const transition = action => request(`/api/orders/${orderID}/transition`, { method: 'POST', body: { action } });
    const rows = async () => (await db.query('SELECT * FROM recordings WHERE order_id=$1 ORDER BY step_index', [orderID])).rows;
    await t.test('regular and quick orders capture their process at creation', async () => {
      processID = (await ok('/api/processes', { method: 'POST', body: initial }, 201)).id;
      const order = await ok('/api/orders', { method: 'POST', body: { customer_id: customer, process_id: processID } }, 201);
      orderID = order.id; trackingPath = '/api/public/orders/' + new URL(order.tracking_url).pathname.split('/').at(-1);
      quickOrderID = (await ok('/api/orders/quick', { method: 'POST', body: { reference: 'first-quick', process_id: processID } }, 201)).id;
      const data = (await db.query('SELECT process_snapshot,camera_id FROM orders WHERE id=ANY($1::uuid[])', [[orderID, quickOrderID]])).rows;
      assert.equal(data.length, 2);
      for (const row of data) { assert.deepEqual(row.process_snapshot, initial); assert.equal(row.camera_id, cameraA); }
    });
    await t.test('editing a process leaves queued orders and their public history unchanged', async () => {
      await ok('/api/processes/' + processID, { method: 'PATCH', body: updated });
      const publicOrder = await ok(trackingPath, { token: null });
      assert.deepEqual(publicOrder.steps, initial.steps); assert.equal(publicOrder.process, initial.name);
      const listed = (await ok('/api/orders')).find(row => row.id === orderID);
      assert.deepEqual(listed.steps, initial.steps); assert.equal(listed.process, initial.name);
    });
    await t.test('new orders use the edited version; snapshots cannot be reassigned or modified', async () => {
      const newer = await ok('/api/orders/quick', { method: 'POST', body: { reference: 'new-quick', process_id: processID } }, 201);
      assert.deepEqual((await db.query('SELECT process_snapshot FROM orders WHERE id=$1', [newer.id])).rows[0].process_snapshot, updated);
      await assert.rejects(db.query("UPDATE orders SET process_snapshot='{}' WHERE id=$1", [orderID]), { code: '23514' });
      await assert.rejects(db.query('UPDATE orders SET process_id=$1 WHERE id=$2', [legacyProcess, orderID]), { code: '23514' });
    });
    await t.test('the store UI saves and reloads a camera-free stage with a default camera', {
      skip: process.env.BROWSER_EXECUTABLE ? false : 'Set BROWSER_EXECUTABLE for browser validation'
    }, async () => {
      const { chromium } = createRequire(import.meta.url)('playwright');
      const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
      try {
        const page = await browser.newPage();
        await page.addInitScript(value => sessionStorage.setItem('nv_token', value), ownerToken);
        await page.goto(`http://127.0.0.1:${port}/loja.html`);
        await page.locator('.nv-sidebar [data-view="processes"]').click();
        const form = page.locator('#processForm');
        await form.locator('[name="name"]').fill('Browser process');
        await form.locator('[name="steps"]').fill('Reception, Private stage, Delivery');
        await form.locator('[name="camera_id"]').selectOption(cameraA);
        await form.locator('[name="step_1"]').selectOption('none');
        const saved = page.waitForResponse(res => res.url().endsWith('/api/processes') && res.request().method() === 'POST');
        await form.getByRole('button', { name: 'Salvar processo' }).click();
        const response = await saved; assert.equal(response.status(), 201);
        const created = await response.json(); assert.equal(created.step_cameras['1'], null);
        const editor = page.locator(`.nv-process-edit[data-id="${created.id}"]`);
        await editor.waitFor(); assert.equal(await editor.locator('[name="step_1"]').inputValue(), 'none');
        const updated = page.waitForResponse(res => res.url().endsWith('/api/processes/' + created.id) && res.request().method() === 'PATCH');
        await editor.getByRole('button', { name: 'Salvar alterações' }).click();
        assert.equal((await updated).status(), 200);
        assert.equal((await ok('/api/processes')).find(row => row.id === created.id).step_cameras['1'], null);
      } finally { await browser.close(); }
    });
    let firstRecording;
    const event = (id, value, token = deviceToken) => request(`/api/connect/recording-jobs/${id}/event`, { method: 'POST', token, body: { event: value } });
    await t.test('starting schedules only the original first camera and rejects invalid transitions', async () => {
      assert.equal((await transition('advance')).status, 409);
      assert.equal((await transition('start')).status, 200);
      assert.equal((await transition('start')).status, 409);
      assert.equal((await transition('complete')).status, 409);
      const recordings = await rows(); assert.equal(recordings.length, 1);
      firstRecording = recordings[0].id;
      assert.equal(recordings[0].camera_id, cameraA); assert.equal(recordings[0].status, 'pending');
      assert.equal((await event(firstRecording, 'started')).status, 200);
    });
    await t.test('pause and resume preserve the recording identity and reject stale stop notifications', async () => {
      assert.equal((await transition('pause')).status, 200);
      assert.equal((await transition('advance')).status, 409);
      assert.equal((await event(firstRecording, 'stopped')).status, 200);
      assert.equal((await transition('resume')).status, 200);
      assert.equal((await event(firstRecording, 'stopped')).status, 409);
      assert.equal((await event(firstRecording, 'started')).status, 200);
      assert.equal((await rows()).length, 1); assert.equal((await rows())[0].id, firstRecording);
    });
    await t.test('advancing finalizes the previous step and schedules the second camera separately', async () => {
      assert.equal((await transition('advance')).status, 200);
      const recordings = await rows(); assert.equal(recordings.length, 2);
      assert.equal(recordings[0].status, 'finalizing'); assert.equal(recordings[0].camera_id, cameraA);
      assert.equal(recordings[1].status, 'pending'); assert.equal(recordings[1].camera_id, cameraB);
      assert.notEqual(recordings[0].id, recordings[1].id);
      const jobs = await ok('/api/connect/recording-jobs', { token: deviceToken });
      assert.equal(jobs.jobs.length, 2);
      assert.equal((await event(firstRecording, 'started')).status, 409);
      assert.equal((await event(firstRecording, 'stopped', foreignDeviceToken)).status, 404);
      assert.equal((await event(firstRecording, 'stopped')).status, 200);
      assert.equal((await rows())[0].status, 'upload_pending');
    });
    await t.test('an explicitly camera-free step does not fall back to the default camera', async () => {
      assert.equal((await transition('complete')).status, 409);
      assert.equal((await transition('advance')).status, 200);
      assert.equal((await rows()).length, 2);
      const order = (await db.query('SELECT camera_id,step_index FROM orders WHERE id=$1', [orderID])).rows[0];
      assert.equal(order.camera_id, null); assert.equal(order.step_index, 2);
      assert.equal((await transition('complete')).status, 200);
      assert.equal((await transition('advance')).status, 409);
    });
    await t.test('completed histories survive later edits and deleted orders cannot be operated or tracked', async () => {
      await ok('/api/processes/' + processID, { method: 'PATCH', body: { ...updated, steps: ['Only one stage'] } });
      const order = await ok(trackingPath, { token: null });
      assert.equal(order.status, 'completed'); assert.deepEqual(order.steps, initial.steps);
      migrate(); // Re-running installation must not refresh existing snapshots.
      assert.deepEqual((await ok(trackingPath, { token: null })).steps, initial.steps);
      await ok('/api/orders/' + orderID, { method: 'DELETE' });
      assert.equal((await transition('start')).status, 404);
      assert.equal((await request(trackingPath, { token: null })).status, 404);
    });
    await t.test('process and camera configuration never crosses tenant boundaries', async () => {
      assert.equal((await request('/api/processes', { method: 'POST', body: { ...initial, camera_id: foreignCamera } })).status, 400);
      assert.equal((await request('/api/orders/quick', { method: 'POST', token: foreignOwnerToken, body: { reference: 'foreign', process_id: processID } })).status, 400);
      assert.equal((await request('/api/orders', { method: 'POST', token: foreignOwnerToken, body: { customer_id: customer, process_id: processID } })).status, 400);
      assert.equal((await request('/api/processes/' + processID, { method: 'PATCH', token: foreignOwnerToken, body: { ...updated, camera_id: null } })).status, 404);
    });
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM'); await once(server, 'exit');
    }
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  }
});
