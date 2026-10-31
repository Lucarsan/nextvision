// Gravação e download de ponta a ponta, com as peças reais:
// API + Postgres local, MediaMTX 1.21.3 com a config gerada pelo instalador, FFmpeg publicando,
// as funções do agente (PowerShell) ligando/desligando a gravação, e o Worker entregando o MP4.
// O túnel da Cloudflare é simulado por um proxy HTTPS com as mesmas regras (/get → 9996, resto → 8888).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createStoreFixture } from './helpers/store-fixture.js';
import * as worker from '../edge/video-worker.js';

const KEY = crypto.randomBytes(32).toString('base64url');
const ACCOUNT = 'a'.repeat(32), ZONE = 'b'.repeat(32);
const enabled = process.env.TEST_DATABASE_URL && process.env.MEDIAMTX_BINARY && process.env.PWSH_BINARY;
const MODULE = path.resolve('installer/windows/payload/FicouPronto.psm1');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pwsh(programData, script) {
  const run = spawnSync(process.env.PWSH_BINARY, ['-NoProfile', '-NonInteractive', '-Command', `$env:ProgramData='${programData}'; Import-Module '${MODULE}' -Force; ${script}`], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return run.stdout.trim();
}

async function fakeCloudflare() {
  const server = http.createServer(async (req, res) => { for await (const _ of req); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"success":true,"result":{},"errors":[]}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}

// "Túnel" da loja: mesmas regras de ingress que a central configura na Cloudflare.
async function fakeTunnel(dir) {
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem'], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  const server = https.createServer({ key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem') }, (req, res) => {
    const port = new URL(req.url, 'http://x').pathname === '/get' ? 9996 : 8888;
    const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, origin: 'https://localhost:' + server.address().port };
}

test('gravação e download: agente liga a gravação, cliente baixa o MP4 da etapa pelo Worker', {
  skip: enabled ? false : 'Set TEST_DATABASE_URL, MEDIAMTX_BINARY and PWSH_BINARY', timeout: 180000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-rec-'));
  const programData = path.join(root, 'ProgramData');
  fs.mkdirSync(path.join(programData, 'FicouPronto', 'secrets'), { recursive: true });
  const password = 'senha-da-loja-' + crypto.randomBytes(6).toString('hex');
  const procs = [];
  const cf = await fakeCloudflare(), tunnel = await fakeTunnel(root);
  const saved = { ...process.env };
  Object.assign(process.env, {
    CLOUDFLARE_API_BASE: cf.base, CLOUDFLARE_API_TOKEN: 'test-cf-token', CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_ZONE_ID: ZONE,
    EDGE_VIDEO_KEY: KEY, EDGE_VIDEO_HOST: 'live.ficoupronto.com', EDGE_VIDEO_TENANTS: 'all',
    MEDIA_SECRET_KEY: crypto.randomBytes(32).toString('hex'), NODE_TLS_REJECT_UNAUTHORIZED: '0'
  });
  delete process.env.MEDIA_UPSTREAM_URL; delete process.env.LIVE_CAMERA_ID;
  const { seal } = await import('../src/secret-box.js?rec=' + Date.now());
  const f = await createStoreFixture();
  const { api, request, db } = f;
  try {
    // MediaMTX com a configuração exata que o instalador grava no PC da loja.
    pwsh(programData, `Write-FpMediaMtxConfig 'ficoupronto' '${password}' 7`);
    const yml = fs.readFileSync(path.join(programData, 'FicouPronto', 'secrets', 'mediamtx.yml'), 'utf8');
    assert.match(yml, /recordDeleteAfter: 168h/); assert.match(yml, /action: playback/); assert.match(yml, /moq: no/);
    const mtx = spawn(process.env.MEDIAMTX_BINARY, [path.join(programData, 'FicouPronto', 'secrets', 'mediamtx.yml')], { stdio: ['ignore', 'ignore', 'pipe'] });
    mtx.stderr.resume(); procs.push(mtx);
    for (let i = 0; ; i++) { try { await fetch('http://127.0.0.1:9997/v3/paths/list'); break; } catch { assert.ok(i < 50, 'MediaMTX must start'); await sleep(100); } }

    // Loja, PC ativado, câmera ligada ao PC e vídeo da loja apontando para o "túnel".
    const camera = await api('/cameras', { method: 'POST', token: f.masterToken, body: { tenant_id: f.tenant, name: 'Bancada 1' } }, 201);
    const code = await api('/master/tenants/' + f.tenant + '/activation-codes', { method: 'POST', token: f.masterToken }, 201);
    const deviceToken = (await api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: 'PC' } }, 201)).device_token;
    await db.query('UPDATE cameras SET device_id=(SELECT id FROM shop_devices WHERE tenant_id=$1 LIMIT 1) WHERE id=$2', [f.tenant, camera.id]);
    await db.query("INSERT INTO store_media(tenant_id,origin,media_username,media_password_enc,source) VALUES($1,$2,'ficoupronto',$3,'adopted')", [f.tenant, tunnel.origin, seal(password)]);
    const stream = (await db.query('SELECT stream_path FROM cameras WHERE id=$1', [camera.id])).rows[0].stream_path;
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '15', '-pix_fmt', 'yuv420p', '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://127.0.0.1:8554/' + stream], { stdio: 'ignore' });
    procs.push(ff);
    await sleep(2000);

    const agentConfig = path.join(root, 'config.json');
    fs.writeFileSync(agentConfig, JSON.stringify({ api_base: f.base, cameras: [{ id: camera.id, name: 'Bancada 1', stream_path: stream }] }));
    const sync = () => JSON.parse(pwsh(programData, `$c = Get-Content '${agentConfig}' -Raw | ConvertFrom-Json; $r = @{}; Sync-FpRecordings $c '${deviceToken}' $r | ConvertTo-Json -Compress`));
    const recordFlag = async () => { const r = await fetch('http://127.0.0.1:9997/v3/config/paths/get/' + stream); return r.ok ? (await r.json()).record : null; };

    // Sem atendimento: nada é gravado.
    assert.equal(sync().detail, 'sem atendimento em andamento');
    assert.equal(await recordFlag(), null);

    // Atendimento iniciado: o agente liga a gravação e confirma a etapa.
    const proc = await api('/processes', { method: 'POST', body: { name: 'Reparo', steps: ['Bancada'], camera_id: camera.id } }, 201);
    const order = await api('/orders/quick', { method: 'POST', body: { reference: 'Teste', process_id: proc.id } }, 201);
    assert.equal((await request('/orders/' + order.id + '/transition', { method: 'POST', body: { action: 'start' } })).status, 200);
    const token = order.tracking_url.split('/p/')[1];
    assert.equal(sync().detail, 'gravando 1 camera(s)');
    assert.equal(await recordFlag(), true);
    assert.equal((await db.query('SELECT status FROM recordings WHERE order_id=$1', [order.id])).rows[0].status, 'recording');
    // O vídeo ao vivo continua no ar enquanto grava.
    assert.equal((await fetch('http://127.0.0.1:9997/v3/paths/get/' + stream).then(r => r.json())).ready, true);
    await sleep(8000);

    // Concluiu: o agente desliga a gravação e fecha a etapa.
    assert.equal((await request('/orders/' + order.id + '/transition', { method: 'POST', body: { action: 'complete' } })).status, 200);
    assert.equal(sync().detail, 'sem atendimento em andamento');
    assert.equal(await recordFlag(), false);
    const rec = (await db.query('SELECT id,status,extract(epoch FROM ended_at-started_at) seconds FROM recordings WHERE order_id=$1', [order.id])).rows[0];
    assert.equal(rec.status, 'upload_pending');
    const files = fs.readdirSync(path.join(programData, 'FicouPronto', 'gravacoes', stream));
    assert.ok(files.length >= 1 && files.every(n => n.endsWith('.mp4')), 'arquivos gravados no PC');

    // A página do cliente lista o vídeo da etapa.
    const pub = await (await fetch(f.base + '/api/public/orders/' + token)).json();
    assert.equal(pub.recordings.length, 1); assert.equal(pub.recordings[0].id, rec.id);
    assert.ok(pub.recordings[0].seconds >= 7, 'duração da etapa');

    // Download: a central devolve um link do Worker; o Worker busca o trecho no PC da loja.
    const dl = await (await fetch(f.base + '/api/public/orders/' + token + '/recordings/' + rec.id + '/download')).json();
    assert.match(dl.url, /^https:\/\/live\.ficoupronto\.com\/d\/[A-Za-z0-9_-]+\/pedido-\d+-etapa-1\.mp4$/);
    assert.ok(!dl.url.includes(password) && !dl.url.includes('localhost'));
    const env = { EDGE_VIDEO_KEY: KEY, CHECK_URL: f.base + '/api/edge/live-check', ALLOWED_ORIGINS: '', ORIGIN_SUFFIX: 'localhost' };
    const r = await worker.handle(new Request(dl.url), env);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(r.headers.get('Content-Type'), 'video/mp4');
    assert.match(r.headers.get('Content-Disposition'), /attachment; filename="pedido-\d+-etapa-1\.mp4"/);
    const out = path.join(root, 'baixado.mp4');
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', out], { encoding: 'utf8' });
    const info = JSON.parse(probe.stdout);
    assert.equal(info.streams[0].codec_name, 'h264'); assert.equal(info.streams[0].width, 640);
    const got = Number(info.format.duration);
    assert.ok(Math.abs(got - Number(rec.seconds)) <= 3, `duração baixada ${got}s vs etapa ${rec.seconds}s`);

    // Link de download não serve para o ao vivo, e vice-versa.
    assert.equal((await worker.handle(new Request(dl.url.replace('/d/', '/v/').replace(/[^/]+\.mp4$/, 'index.m3u8')), env)).status, 403);
    // Senha errada no PC (link forjado com outra chave) não passa.
    assert.equal((await worker.handle(new Request(dl.url), { ...env, EDGE_VIDEO_KEY: crypto.randomBytes(32).toString('base64url') })).status, 403);

    // PC da loja offline: a página explica, sem erro genérico.
    await db.query("UPDATE shop_devices SET last_seen_at=now()-interval '10 minutes' WHERE tenant_id=$1", [f.tenant]);
    const off = await fetch(f.base + '/api/public/orders/' + token + '/recordings/' + rec.id + '/download');
    assert.equal(off.status, 409); assert.match((await off.json()).error, /offline/);
    // Passou do prazo de guarda: 410.
    await db.query("UPDATE recordings SET started_at=started_at-interval '30 days',ended_at=ended_at-interval '30 days' WHERE id=$1", [rec.id]);
    assert.equal((await fetch(f.base + '/api/public/orders/' + token + '/recordings/' + rec.id + '/download')).status, 410);
    assert.equal((await (await fetch(f.base + '/api/public/orders/' + token)).json()).recordings.length, 0);
  } finally {
    for (const p of procs) p.kill('SIGTERM');
    await f.cleanup(); cf.server.close(); tunnel.server.close();
    fs.rmSync(root, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved);
  }
});
