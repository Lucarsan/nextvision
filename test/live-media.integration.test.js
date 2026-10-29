import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';
import jwt from 'jsonwebtoken';

// Requires a verified MediaMTX 1.21.3 binary, FFmpeg/ffprobe, OpenSSL and local
// PostgreSQL. Only a disposable schema is created; application data is untouched.
const enabled = process.env.TEST_DATABASE_URL && process.env.MEDIAMTX_BINARY;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const firstReference = text => text.split(/\r?\n/).find(line => line && !line.startsWith('#'));
async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('HLS sessions through the real NextVision API and MediaMTX', {
  skip: enabled ? false : 'Set TEST_DATABASE_URL and MEDIAMTX_BINARY; see docs/HLS_SESSION_DIAGNOSIS.md',
  timeout: 120000
}, async t => {
  const databaseURL = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseURL.hostname), 'Use local PostgreSQL only');
  const db = new pg.Client({ connectionString: databaseURL.toString(), ssl: false });
  const schema = 'nv_hls_' + crypto.randomBytes(8).toString('hex');
  const root = await mkdtemp(tmpdir() + '/nextvision-hls-test-');
  const processes = [];
  let connected = false;
  const start = (command, args, options = {}) => {
    const process = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
    process.stderr.resume(); // Never dump upstream logs, credentials or session IDs.
    processes.push(process);
    return process;
  };
  try {
    await db.connect(); connected = true;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    // Minimal fixture schema for the actual HLS authorization queries. This
    // does not run, repair or skip migrations in the application's schema.
    await db.query(`
      CREATE TABLE tenants(id uuid PRIMARY KEY, status text);
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE cameras(id uuid PRIMARY KEY, tenant_id uuid);
      CREATE TABLE processes(id uuid PRIMARY KEY, tenant_id uuid, camera_id uuid, step_cameras jsonb);
      CREATE TABLE orders(id uuid PRIMARY KEY, tenant_id uuid, process_id uuid, camera_id uuid,
        step_index integer, status text, public_token_hash text, share_code text, deleted_at timestamptz);
    `);
    const [tenant, foreignTenant, camera, otherCamera, processID, foreignProcess, orderID] = Array.from({ length: 7 }, () => crypto.randomUUID());
    const token = crypto.randomBytes(18).toString('base64url');
    const foreignToken = crypto.randomBytes(18).toString('base64url');
    const hash = token => crypto.createHash('sha256').update(token).digest('hex');
    await db.query("INSERT INTO tenants VALUES($1,'active'),($2,'active')", [tenant, foreignTenant]);
    await db.query('INSERT INTO cameras VALUES($1,$2),($3,$2)', [camera, tenant, otherCamera]);
    await db.query('INSERT INTO processes VALUES($1,$2,$3,$4),($5,$6,NULL,$7)', [processID, tenant, camera, JSON.stringify({ 1: otherCamera }), foreignProcess, foreignTenant, '{}']);
    await db.query("INSERT INTO orders VALUES($1,$2,$3,$4,0,'live',$5,$6,NULL),($7,$8,$9,NULL,0,'live',$10,$11,NULL)", [orderID, tenant, processID, camera, hash(token), crypto.randomBytes(12).toString('hex'), crypto.randomUUID(), foreignTenant, foreignProcess, hash(foreignToken), crypto.randomBytes(12).toString('hex')]);
    // Columns read by the real public tracking page's metadata endpoint.
    await db.query(`
      ALTER TABLE tenants ADD name text DEFAULT 'Test store', ADD logo_url text,
        ADD loyalty_enabled boolean DEFAULT false, ADD loyalty_target integer DEFAULT 10, ADD loyalty_reward text;
      ALTER TABLE processes ADD name text DEFAULT 'Test service', ADD steps jsonb DEFAULT '["Reception","Repair"]';
      ALTER TABLE orders ADD customer_id uuid, ADD external_reference text, ADD created_at timestamptz DEFAULT now(), ADD started_at timestamptz, ADD completed_at timestamptz;
      CREATE TABLE recordings(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,order_id uuid,step_index integer,camera_id uuid,status text,started_at timestamptz,ended_at timestamptz,updated_at timestamptz DEFAULT now(),UNIQUE(order_id,step_index));
      CREATE TABLE audit_events(tenant_id uuid,actor_id uuid,action text,target_type text,target_id uuid);
      CREATE TABLE loyalty_checkins(tenant_id uuid,customer_id uuid,redemption_id uuid);
      CREATE TABLE loyalty_redemptions(tenant_id uuid,customer_id uuid,status text,reward_snapshot text,issued_at timestamptz,redeemed_at timestamptz);
    `);

    const cert = root + '/test.crt', key = root + '/test.key';
    const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
    assert.equal(openssl.status, 0, 'Create a trusted local TLS fixture');
    const ca = await readFile(cert);
    const inheritedCA = process.env.NODE_EXTRA_CA_CERTS ? await readFile(process.env.NODE_EXTRA_CA_CERTS, 'utf8') : '';
    await writeFile(root + '/trust.pem', inheritedCA.trimEnd() + '\n' + ca);
    const hlsPort = await freePort(), rtspPort = await freePort(), apiPort = await freePort();
    const password = crypto.randomBytes(18).toString('hex');
    const origin = `https://127.0.0.1:${hlsPort}/`;
    const authorization = 'Basic ' + Buffer.from('reader:' + password).toString('base64');
    const mediaGet = (path, useCookie = false) => new Promise((resolve, reject) => {
      const req = https.get(new URL(path, origin), { ca, headers: { Authorization: authorization, ...(useCookie ? { Cookie: 'cookieCheck=1' } : {}) } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
        res.on('error', reject);
      });
      req.setTimeout(5000, () => req.destroy(new Error('Media fixture timeout')));
      req.on('error', reject);
    });
    await writeFile(root + '/mediamtx.yml', `logLevel: error
rtspAddress: 127.0.0.1:${rtspPort}
rtspTransports: [tcp]
rtmp: false
webrtc: false
srt: false
moq: false
hlsAddress: 127.0.0.1:${hlsPort}
hlsEncryption: true
hlsServerCert: ${cert}
hlsServerKey: ${key}
hlsAlwaysRemux: true
hlsVariant: mpegts
hlsSegmentDuration: 1s
authMethod: internal
authInternalUsers:
  - user: any
    ips: [127.0.0.1]
    permissions:
      - action: publish
        path: camera
  - user: reader
    pass: ${password}
    permissions:
      - action: read
        path: camera
paths:
  camera:
    source: publisher
`, { mode: 0o600 });
    start(resolve(process.env.MEDIAMTX_BINARY), [root + '/mediamtx.yml']);
    for (let attempt = 0; ; attempt++) {
      try { await mediaGet('/camera/'); break; }
      catch { assert.ok(attempt < 40, 'MediaMTX must start'); await sleep(100); }
    }
    const publisherArgs = ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:${rtspPort}/camera`];
    let publisher=start('ffmpeg',publisherArgs);
    for (let attempt = 0; ; attempt++) {
      const result = await mediaGet('/camera/index.m3u8?cookieCheck=1');
      if (result.status === 200) break;
      assert.ok(attempt < 30, 'Synthetic source must publish'); await sleep(200);
    }
    databaseURL.searchParams.set('options', '-c search_path=' + schema);
    const jwtSecret=crypto.randomBytes(32).toString('hex');
    start(process.execPath, ['src/server.js'], {
      cwd: resolve(process.env.NEXTVISION_TEST_SERVER_ROOT || '.'),
      env: { ...process.env, DATABASE_URL: databaseURL.toString(), DB_SSL: 'disable', JWT_SECRET: jwtSecret, PORT: String(apiPort), MEDIA_UPSTREAM_URL: origin, MEDIA_USERNAME: 'reader', MEDIA_PASSWORD: password, LIVE_CAMERA_ID: camera, NODE_EXTRA_CA_CERTS: root + '/trust.pem' }
    });
    const base = `http://127.0.0.1:${apiPort}`;
    const get = path => fetch(new URL(path, base), { signal: AbortSignal.timeout(10000) });
    for (let attempt = 0; ; attempt++) {
      try { assert.equal((await get('/health')).status, 200); break; }
      catch { assert.ok(attempt < 40, 'NextVision API must start'); await sleep(100); }
    }
    const live = value => `/api/public/orders/${value}/live/index.m3u8`;
    const authorizedPaths = [];
    await t.test('advertising cookies without retaining a jar reproduces the upstream 401', async () => {
      const master = await mediaGet('/camera/index.m3u8?cookieCheck=1', true);
      assert.equal(master.status, 200);
      const reference = firstReference(master.text);
      assert.ok(!new URL(reference, origin).searchParams.has('session'));
      const child = await mediaGet(new URL(reference, origin + 'camera/').pathname, true);
      assert.equal(child.status, 401);
      assert.equal(JSON.parse(child.text).error, 'session not found');
    });
    await t.test('the API delivers authenticated playlists and decodable, changing H.264 segments', async () => {
      const master = await get(live(token)); assert.equal(master.status, 200);
      const masterText = await master.text();
      assert.ok(!masterText.includes(password) && !masterText.includes(origin), 'Do not expose credentials or origin');
      const childPath = firstReference(masterText);
      authorizedPaths.push(childPath);
      assert.ok(childPath.startsWith(`/api/public/orders/${token}/live/`));
      assert.ok(new URL(childPath, base).searchParams.has('session'), 'Keep the query-backed media session');
      assert.ok(!new URL(childPath, base).searchParams.has('cookieCheck'), 'Probe must not leak to child playlists');
      const segments = [];
      for (let sample = 0; sample < 2; sample++) {
        const child = await get(childPath); assert.equal(child.status, 200);
        const mediaText = await child.text();
        const segmentPath = mediaText.split(/\r?\n/).filter(line => line && !line.startsWith('#')).at(-1);
        authorizedPaths.push(segmentPath);
        const segment = await get(segmentPath); assert.equal(segment.status, 200);
        assert.ok(segment.headers.get('cache-control').includes('no-store'));
        const bytes = Buffer.from(await segment.arrayBuffer());
        const probe = spawnSync('ffprobe', ['-v', 'error', '-f', 'mpegts', '-count_frames', '-show_entries', 'stream=codec_name,nb_read_frames', '-of', 'json', '-i', 'pipe:0'], { input: bytes, encoding: 'utf8' });
        assert.equal(probe.status, 0, 'Decode the delivered video');
        assert.ok(JSON.parse(probe.stdout).streams.some(s => s.codec_name === 'h264' && Number(s.nb_read_frames) > 1));
        segments.push(crypto.createHash('sha256').update(bytes).digest('hex'));
        if (!sample) await sleep(2100);
      }
      assert.ok(segments[0] !== segments[1], 'Delivered video must advance');
    });
    await t.test('a foreign tenant or invalid token cannot read the camera', async () => {
      assert.equal((await get(live(foreignToken))).status, 404);
      assert.equal((await get(live('not-a-valid-token'))).status, 404);
    });
    await t.test('the tracking page recovers automatically and plays for 60 seconds ('+(process.env.TEST_HLS_ENGINE||'native')+')', {
      skip: process.env.BROWSER_EXECUTABLE && process.env.HLS_JS_PATH ? false : 'Set BROWSER_EXECUTABLE and HLS_JS_PATH for browser validation'
    }, async () => {
      const { chromium } = createRequire(import.meta.url)('playwright');
      const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
      try {
        const page = await browser.newPage();
        if(process.env.TEST_HLS_ENGINE==='hlsjs')await page.addInitScript(()=>{const original=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(type){return /mpegurl/i.test(type)?'':original.call(this,type);};});
        await page.route('https://fonts.googleapis.com/**', route => route.abort());
        await page.route('https://fonts.gstatic.com/**', route => route.abort());
        await page.route('https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js', route => route.fulfill({ path: process.env.HLS_JS_PATH, contentType: 'application/javascript' }));
        let initialOutage=true;
        await page.route('**/api/public/orders/*/live/*',route=>initialOutage?route.fulfill({status:502,contentType:'application/json',body:'{"error":"Synthetic initial outage"}'}):route.continue());
        await page.goto(base + '/p/' + token);
        await page.waitForFunction(()=>document.querySelector('.nv-live-message')?.textContent.includes('Reconectando em'),{},{timeout:45000});
        initialOutage=false;
        await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0, {}, { timeout: 45000 });
        const startTime = await page.locator('video').evaluate(video => video.currentTime);
        for (let sample = 0; sample < 6; sample++) {
          await sleep(10000);
          const state = await page.locator('video').evaluate(video => ({ time: video.currentTime, error: !!video.error, paused: video.paused }));
          assert.equal(state.error, false); assert.equal(state.paused, false);
          assert.ok(state.time > startTime + (sample + 1) * 8, 'Playback must continue advancing through automatic metadata refreshes');
        }
        publisher.kill('SIGTERM');await once(publisher,'exit');
        await page.waitForFunction(()=>document.querySelector('.nv-live-message')?.textContent.includes('Reconectando'),{},{timeout:45000});
        publisher=start('ffmpeg',publisherArgs);
        await page.waitForFunction(()=>document.querySelector('.nv-live-message')?.textContent==='Ao vivo',{},{timeout:45000});
        const recovered=await page.locator('video').evaluate(video=>video.currentTime);
        await sleep(2500);assert.ok(await page.locator('video').evaluate((video,time)=>video.currentTime>time,recovered),'Video must resume without F5 after a real publisher restart');
        await db.query("UPDATE orders SET status='paused' WHERE id=$1", [orderID]);
        await page.getByRole('button', { name: 'Atualizar agora' }).click();
        await page.waitForFunction(() => !document.querySelector('video.nv-live-player'));
        assert.equal((await get(live(token))).status, 404);
        await db.query("UPDATE orders SET status='live' WHERE id=$1", [orderID]);
      } finally { await browser.close(); }
    });
    await t.test('starting competing orders reserves the camera atomically; resume and stage changes preserve existing video',async()=>{
      const first=crypto.randomUUID(),second=crypto.randomUUID(),other=crypto.randomUUID(),otherProcess=crypto.randomUUID();
      const ownerToken=jwt.sign({id:crypto.randomUUID(),tenant_id:tenant,role:'owner'},jwtSecret,{algorithm:'HS256'});
      const move=async(id,action)=>{
        const response=await fetch(base+'/api/orders/'+id+'/transition',{method:'POST',headers:{Authorization:'Bearer '+ownerToken,'Content-Type':'application/json'},body:JSON.stringify({action}),signal:AbortSignal.timeout(10000)});
        return {status:response.status,data:await response.json()};
      };
      await db.query("UPDATE orders SET status='paused' WHERE id=$1",[orderID]);
      await db.query("INSERT INTO processes(id,tenant_id,camera_id,step_cameras,steps,name) VALUES($1,$2,$3,'{}','[\"Other station\"]','Other process')",[otherProcess,tenant,otherCamera]);
      await db.query("INSERT INTO orders(id,tenant_id,process_id,camera_id,step_index,status) VALUES($1,$3,$4,$5,0,'queued'),($2,$3,$4,$5,0,'queued'),($6,$3,$7,$8,0,'queued')",[first,second,tenant,processID,camera,other,otherProcess,otherCamera]);
      try{
        const attempts=await Promise.all([move(first,'start'),move(second,'start')]);
        assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
        const winner=attempts[0].status===200?first:second,loser=winner===first?second:first;
        const state=await db.query('SELECT id,status FROM orders WHERE id=ANY($1::uuid[])',[[winner,loser]]);
        assert.equal(state.rows.find(r=>r.id===winner).status,'live');assert.equal(state.rows.find(r=>r.id===loser).status,'queued');
        assert.equal((await db.query('SELECT count(*)::int n FROM recordings WHERE order_id=$1',[loser])).rows[0].n,0);
        assert.equal((await move(other,'start')).status,200,'Another camera remains independently usable');
        assert.equal((await move(winner,'advance')).status,409,'Cannot enter the occupied second station');
        assert.equal((await db.query('SELECT step_index FROM orders WHERE id=$1',[winner])).rows[0].step_index,0);
        await db.query("UPDATE orders SET public_token_hash=$1 WHERE id=$2",[hash('winner-token-for-testing'),winner]);
        const stream=await get(live('winner-token-for-testing'));assert.equal(stream.status,200);await stream.text();
        assert.equal((await move(winner,'pause')).status,200);assert.equal((await move(loser,'start')).status,200);
        assert.equal((await move(winner,'resume')).status,409);
        assert.equal((await db.query('SELECT status FROM orders WHERE id=$1',[winner])).rows[0].status,'paused');
        assert.equal((await move(loser,'pause')).status,200);assert.equal((await move(winner,'resume')).status,200);
      }finally{
        await db.query('DELETE FROM recordings WHERE order_id=ANY($1::uuid[])',[[first,second,other]]);
        await db.query('DELETE FROM orders WHERE id=ANY($1::uuid[])',[[first,second,other]]);
        await db.query('DELETE FROM processes WHERE id=$1',[otherProcess]);
        await db.query("UPDATE orders SET status='live',step_index=0 WHERE id=$1",[orderID]);
      }
    });
    await t.test('another active order using the same camera blocks concurrent viewing', async () => {
      const competitor = crypto.randomUUID();
      await db.query("INSERT INTO orders(id,tenant_id,process_id,camera_id,step_index,status) VALUES($1,$2,$3,$4,0,'live')", [competitor, tenant, processID, camera]);
      try { assert.equal((await get(live(token))).status, 409); }
      finally { await db.query('DELETE FROM orders WHERE id=$1', [competitor]); }
    });
    await t.test('pausing, completing, deleting, or changing camera revokes live access', async () => {
      for (const status of ['paused', 'completed']) {
        await db.query('UPDATE orders SET status=$1 WHERE id=$2', [status, orderID]);
        for (const path of [live(token), ...authorizedPaths]) assert.equal((await get(path)).status, 404);
      }
      await db.query("UPDATE orders SET status='live',step_index=1 WHERE id=$1", [orderID]);
      assert.equal((await get(live(token))).status, 404);
      await db.query('UPDATE orders SET step_index=0,deleted_at=now() WHERE id=$1', [orderID]);
      assert.equal((await get(live(token))).status, 404);
      await db.query('UPDATE orders SET deleted_at=NULL WHERE id=$1', [orderID]);
      await db.query("UPDATE tenants SET status='suspended' WHERE id=$1", [tenant]);
      assert.equal((await get(live(token))).status, 404);
    });
  } finally {
    for (const child of processes.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), sleep(2000)]);
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
      }
    }
    if (connected) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
    await rm(root, { recursive: true, force: true });
  }
});
