import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createStoreFixture } from './helpers/store-fixture.js';

const ACCOUNT = 'a'.repeat(32), ZONE = 'b'.repeat(32);

// Cloudflare simulada: registra as chamadas e responde como a API real.
async function fakeCloudflare() {
  const calls = [], tunnels = new Map(), dns = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, url: req.url, body: json, auth: req.headers.authorization });
    const send = (result, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ code: 1000 }] })); };
    const u = new URL(req.url, 'http://x');
    if (req.headers.authorization !== 'Bearer test-cf-token') return send(null, 403);
    if (req.method === 'GET' && u.pathname === `/zones/${ZONE}/dns_records`) return send(dns.filter(r => r.name === u.searchParams.get('name')));
    if (req.method === 'POST' && u.pathname === `/zones/${ZONE}/dns_records`) { const r = { id: 'dns-' + dns.length, ...json }; dns.push(r); return send(r); }
    if (req.method === 'POST' && u.pathname === `/accounts/${ACCOUNT}/cfd_tunnel`) { const t = { id: crypto.randomUUID(), name: json.name }; tunnels.set(t.id, t); return send(t); }
    const m = /^\/accounts\/a+\/cfd_tunnel\/([0-9a-f-]{36})(\/configurations|\/token)?$/.exec(u.pathname);
    if (m && tunnels.has(m[1])) {
      if (req.method === 'PUT' && m[2] === '/configurations') { tunnels.get(m[1]).config = json.config; return send({}); }
      if (req.method === 'GET' && m[2] === '/token') return send('eyJ' + crypto.createHash('sha256').update(m[1]).digest('hex').repeat(3));
      if (req.method === 'GET' && !m[2]) return send(tunnels.get(m[1]));
      if (req.method === 'DELETE' && !m[2]) { tunnels.delete(m[1]); return send({}); }
    }
    send(null, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, calls, tunnels, dns, base: 'http://127.0.0.1:' + server.address().port };
}

// MediaMTX simulado por HTTPS (certificado próprio), para conferir origem, caminho e senha.
async function fakeMediaMTX() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-media-'));
  const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem'], { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  const seen = [];
  const server = https.createServer({ key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem') }, (req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\nsegment0.ts?session=abc\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, seen, origin: 'https://localhost:' + server.address().port, dir };
}

test('store media: provisioning, adoption, heartbeat and per-store video origin', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 60000
}, async () => {
  const cf = await fakeCloudflare(), media = await fakeMediaMTX();
  const saved = { ...process.env };
  Object.assign(process.env, {
    CLOUDFLARE_API_BASE: cf.base, CLOUDFLARE_API_TOKEN: 'test-cf-token', CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_ZONE_ID: ZONE,
    MEDIA_UPSTREAM_URL: 'https://legacy.example.test', MEDIA_USERNAME: 'ficoupronto', MEDIA_PASSWORD: 'legacy-password-123', MEDIA_MULTI_CAMERA_ENABLED: 'true',
    NODE_TLS_REJECT_UNAUTHORIZED: '0'
  });
  delete process.env.LIVE_CAMERA_ID;
  const f = await createStoreFixture();
  const { api, request, db } = f;
  try {
    const activate = async (tenant, name) => {
      const code = await api('/master/tenants/' + tenant + '/activation-codes', { method: 'POST', token: f.masterToken }, 201);
      return (await api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: name } }, 201)).device_token;
    };

    // Antes de ativar: a central vê que a loja ainda não tem vídeo.
    const before = await api('/master/tenants/' + f.tenant + '/media', { token: f.masterToken });
    assert.equal(before.configured, false); assert.equal(before.cloudflare_configured, true);

    // Uma câmera cadastrada pela central antes da instalação.
    const camera = await api('/cameras', { method: 'POST', token: f.masterToken, body: { tenant_id: f.tenant, name: 'Bancada 1' } }, 201);

    // O computador ativado recebe tudo: túnel, senha, câmeras.
    const device = await activate(f.tenant, 'PC da loja');
    const p1 = await api('/connect/provision', { method: 'POST', token: device });
    const slug = (await db.query('SELECT slug FROM tenants WHERE id=$1', [f.tenant])).rows[0].slug;
    const label = slug.replace(/[^a-z0-9-]/g, '').slice(0, 40);
    assert.equal(p1.media.hostname, 'video-' + label + '.ficoupronto.com');
    assert.equal(p1.media.username, 'ficoupronto');
    assert.ok(p1.media.password.length >= 24);
    assert.match(p1.tunnel.token, /^eyJ/);
    assert.equal(p1.tunnel.name, 'loja-' + label);
    assert.deepEqual(p1.cameras.map(c => [c.id, c.bound]), [[camera.id, true]]);
    // /get → servidor de gravações (download); o resto → HLS ao vivo.
    assert.deepEqual(cf.tunnels.get(p1.tunnel.id).config.ingress.map(r => [r.hostname, r.path, r.service]), [
      [p1.media.hostname, '^/get$', 'http://127.0.0.1:9996'], [p1.media.hostname, undefined, 'http://127.0.0.1:8888'], [undefined, undefined, 'http_status:404']]);
    assert.equal(p1.recording.retention_days, 15);
    assert.equal(cf.dns[0].content, p1.tunnel.id + '.cfargotunnel.com'); assert.equal(cf.dns[0].proxied, true);
    // A senha fica criptografada no banco.
    const stored = (await db.query('SELECT media_password_enc FROM store_media WHERE tenant_id=$1', [f.tenant])).rows[0].media_password_enc;
    assert.match(stored, /^v1:/); assert.ok(!stored.includes(p1.media.password));

    // Repetir não cria outro túnel.
    const p2 = await api('/connect/provision', { method: 'POST', token: device });
    assert.equal(p2.tunnel.id, p1.tunnel.id); assert.equal(p2.media.password, p1.media.password);
    assert.equal(cf.calls.filter(c => c.method === 'POST' && c.url.endsWith('/cfd_tunnel')).length, 1);

    // Sem token de computador, nada é entregue.
    assert.equal((await request('/connect/provision', { method: 'POST', token: null })).status, 401);

    // Sinal de vida: câmeras de outra loja são descartadas.
    await api('/connect/heartbeat', { method: 'POST', token: device, body: { agent_version: '0.3.0', components: { tunnel: { state: 'ok' }, relay: { state: 'ok' }, publisher: { state: 'degraded', detail: 'reconectando' } }, cameras: [{ id: camera.id, state: 'ok' }, { id: crypto.randomUUID(), state: 'down' }] } });
    const view = await api('/master/tenants/' + f.tenant + '/media', { token: f.masterToken });
    assert.equal(view.configured, true); assert.equal(view.source, 'provisioned');
    assert.equal(view.devices[0].agent_version, '0.3.0');
    assert.deepEqual(view.devices[0].health.cameras.map(c => c.id), [camera.id]);
    assert.equal(view.devices[0].health.components.publisher.state, 'degraded');
    assert.equal(JSON.stringify(view).includes(p1.media.password), false, 'a central não recebe a senha');
    assert.equal((await request('/connect/heartbeat', { method: 'POST', token: device, body: { agent_version: 'x y' } })).status, 400);

    // Outra loja ganha túnel e senha próprios; o lojista não acessa a rota da central.
    const otherDevice = await activate(f.foreignTenant, 'PC da outra loja');
    const other = await api('/connect/provision', { method: 'POST', token: otherDevice });
    assert.notEqual(other.tunnel.id, p1.tunnel.id); assert.notEqual(other.media.password, p1.media.password);
    assert.equal((await request('/master/tenants/' + f.tenant + '/media', { token: f.ownerToken })).status, 403);

    // Vídeo do cliente vai para a origem da própria loja, com a senha da loja.
    await db.query('UPDATE store_media SET origin=$1 WHERE tenant_id=$2', [media.origin, f.tenant]);
    const proc = await api('/processes', { method: 'POST', body: { name: 'Reparo', steps: ['Bancada'], camera_id: camera.id } }, 201);
    const order = await api('/orders/quick', { method: 'POST', body: { reference: 'Teste', process_id: proc.id } }, 201);
    assert.equal((await request('/orders/' + order.id + '/transition', { method: 'POST', body: { action: 'start' } })).status, 200);
    const token = order.tracking_url.split('/p/')[1];
    const live = await fetch(f.base + '/api/public/orders/' + token + '/live/index.m3u8');
    const text = await live.text();
    assert.equal(live.status, 200, text);
    assert.match(text, /\/api\/public\/orders\/.+\/live\/segment0\.ts\?session=abc/);
    assert.equal(media.seen.length, 1);
    assert.ok(media.seen[0].url.startsWith('/' + p1.cameras[0].stream_path + '/index.m3u8'));
    assert.equal(media.seen[0].auth, 'Basic ' + Buffer.from('ficoupronto:' + p1.media.password).toString('base64'));

    // Loja antiga: adota o túnel existente com a senha atual do Render.
    await db.query('DELETE FROM store_media WHERE tenant_id=$1', [f.foreignTenant]);
    const legacyTunnel = [...cf.tunnels.values()].find(t => t.name !== p1.tunnel.name);
    const adopted = await api('/master/tenants/' + f.foreignTenant + '/media/adopt', { method: 'POST', token: f.masterToken, body: { tunnel_id: legacyTunnel.id, hostname: 'video.ficoupronto.com' } }, 201);
    assert.equal(adopted.source, 'adopted'); assert.equal(adopted.origin, 'https://video.ficoupronto.com');
    const again = await api('/connect/provision', { method: 'POST', token: otherDevice });
    assert.equal(again.media.password, 'legacy-password-123'); assert.equal(again.tunnel.id, legacyTunnel.id);
    assert.equal((await request('/master/tenants/' + f.foreignTenant + '/media/adopt', { method: 'POST', token: f.masterToken, body: { tunnel_id: legacyTunnel.id, hostname: 'video.ficoupronto.com' } })).status, 409);
  } finally {
    await f.cleanup(); cf.server.close(); media.server.close(); fs.rmSync(media.dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('store media: stores without their own video keep the legacy single camera', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 60000
}, async () => {
  const media = await fakeMediaMTX();
  const saved = { ...process.env };
  const cameraId = crypto.randomUUID();
  Object.assign(process.env, { MEDIA_UPSTREAM_URL: media.origin, MEDIA_USERNAME: 'ficoupronto', MEDIA_PASSWORD: 'legacy-password-123', LIVE_CAMERA_ID: cameraId, NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  for (const key of ['CLOUDFLARE_API_TOKEN', 'MEDIA_MULTI_CAMERA_ENABLED']) delete process.env[key];
  const f = await createStoreFixture();
  const { api, request, db } = f;
  try {
    const camera = await api('/cameras', { method: 'POST', token: f.masterToken, body: { tenant_id: f.tenant, name: 'Bancada 1' } }, 201);
    await db.query('UPDATE cameras SET id=$1 WHERE id=$2', [cameraId, camera.id]);
    const other = await api('/cameras', { method: 'POST', token: f.masterToken, body: { tenant_id: f.foreignTenant, name: 'Outra' } }, 201);
    const start = async (owner, cam) => {
      const proc = await api('/processes', { method: 'POST', token: owner, body: { name: 'Reparo', steps: ['Bancada'], camera_id: cam } }, 201);
      const order = await api('/orders/quick', { method: 'POST', token: owner, body: { reference: 'Teste', process_id: proc.id } }, 201);
      assert.equal((await request('/orders/' + order.id + '/transition', { method: 'POST', token: owner, body: { action: 'start' } })).status, 200);
      return order.tracking_url.split('/p/')[1];
    };
    const live = await fetch(f.base + '/api/public/orders/' + await start(f.ownerToken, cameraId) + '/live/index.m3u8');
    assert.equal(live.status, 200, await live.clone().text());
    assert.ok(media.seen[0].url.startsWith('/camera/index.m3u8'));
    assert.equal(media.seen[0].auth, 'Basic ' + Buffer.from('ficoupronto:legacy-password-123').toString('base64'));
    // A câmera de outra loja (sem vídeo próprio e fora do modo antigo) não abre.
    const denied = await fetch(f.base + '/api/public/orders/' + await start(f.foreignToken, other.id) + '/live/index.m3u8');
    assert.equal(denied.status, 404);
    assert.equal(media.seen.length, 1);
    // Sem Cloudflare configurada, o computador recebe uma mensagem clara.
    const code = await api('/master/tenants/' + f.tenant + '/activation-codes', { method: 'POST', token: f.masterToken }, 201);
    const device = (await api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: 'PC' } }, 201)).device_token;
    const res = await request('/connect/provision', { method: 'POST', token: device });
    assert.equal(res.status, 503); assert.match(res.data.error, /Cloudflare/);
  } finally {
    await f.cleanup(); media.server.close(); fs.rmSync(media.dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
