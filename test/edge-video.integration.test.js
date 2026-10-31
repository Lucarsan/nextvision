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
import * as worker from '../edge/video-worker.js';

const KEY = crypto.randomBytes(32).toString('base64url');
const ACCOUNT = 'a'.repeat(32), ZONE = 'b'.repeat(32);

async function withEnv(vars, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
}

// ---------- Unidade: token e Worker (sem banco) ----------
test('edge token: Render cifra, Worker abre; adulterado, vencido ou outra chave é recusado', async () => {
  await withEnv({ EDGE_VIDEO_KEY: KEY, EDGE_VIDEO_HOST: 'live.ficoupronto.com' }, async () => {
    const edge = await import('../src/edge-video.js?unit=' + Date.now());
    const { token } = edge.sealEdgeToken({ o: 'https://video-x.ficoupronto.com/', s: 'cam_1', u: 'ficoupronto', w: 'senha-secreta-123', t: 'pedido-token-abcdefgh' });
    const p = await worker.openEdgeToken(token, KEY);
    assert.equal(p.o, 'https://video-x.ficoupronto.com/'); assert.equal(p.w, 'senha-secreta-123');
    assert.ok(!Buffer.from(token, 'base64url').toString('latin1').includes('senha-secreta'), 'senha não aparece no link');
    assert.deepEqual(edge.openEdgeToken(token), p);
    const bytes = Buffer.from(token, 'base64url'); bytes[20] ^= 1;
    assert.equal(await worker.openEdgeToken(bytes.toString('base64url'), KEY), null);
    assert.equal(await worker.openEdgeToken(token, crypto.randomBytes(32).toString('base64url')), null);
    assert.equal(await worker.openEdgeToken(token, KEY, Date.now() + 31 * 60000), null, 'vence em 30 min');
    assert.equal(edge.edgeEnabledFor({ id: 'x', slug: 'eliastech' }), false);
    process.env.EDGE_VIDEO_TENANTS = 'lojateste, EliasTech';
    assert.equal(edge.edgeEnabledFor({ id: 'x', slug: 'eliastech' }), true);
    assert.equal(edge.edgeEnabledFor({ id: 'y', slug: 'outra' }), false);
  });
});

test('edge worker: origem, CORS, revogação, playlist e central fora do ar', async () => {
  await withEnv({ EDGE_VIDEO_KEY: KEY, EDGE_VIDEO_HOST: 'live.ficoupronto.com' }, async () => {
    const edge = await import('../src/edge-video.js?worker=' + Date.now());
    const env = { EDGE_VIDEO_KEY: KEY, CHECK_URL: 'https://app.ficoupronto.com/api/edge/live-check', ALLOWED_ORIGINS: 'https://ficoupronto.com', ORIGIN_SUFFIX: '.ficoupronto.com' };
    const linkFor = (o = 'https://video-x.ficoupronto.com/', t = 'pedido-' + crypto.randomUUID()) => edge.edgeSourceFor({ origin: o, streamPath: 'cam_1', username: 'ficoupronto', password: 'senha-secreta-123', orderToken: t }).url;
    let checkStatus = 204; const calls = [];
    const fake = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === env.CHECK_URL) { if (checkStatus === 0) throw new Error('down'); return new Response(null, { status: checkStatus }); }
      if (String(url).includes('index.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nstream.m3u8?session=abc\n', { status: 200 });
      if (String(url).includes('evil.m3u8')) return new Response('#EXTM3U\nhttps://evil.example/x.ts\n', { status: 200 });
      return new Response(new Uint8Array([71, 1, 2]), { status: 200, headers: { 'Content-Length': '3' } });
    };
    const url = linkFor();
    assert.match(url, /^https:\/\/live\.ficoupronto\.com\/v\/[A-Za-z0-9_-]+\/index\.m3u8$/);

    let r = await worker.handle(new Request(url, { headers: { Origin: 'https://ficoupronto.com' } }), env, fake);
    assert.equal(r.status, 200); assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://ficoupronto.com');
    assert.match(await r.text(), /stream\.m3u8\?session=abc/);
    const up = calls.find(c => c.url.includes('index.m3u8'));
    assert.equal(new URL(up.url).pathname, '/cam_1/index.m3u8'); assert.equal(new URL(up.url).searchParams.get('cookieCheck'), '1');
    assert.equal(up.init.headers.Authorization, 'Basic ' + Buffer.from('ficoupronto:senha-secreta-123').toString('base64'));

    // Segmento: em fluxo, sem checagem extra na central.
    const before = calls.filter(c => c.url === env.CHECK_URL).length;
    r = await worker.handle(new Request(url.replace('index.m3u8', 'segment0.ts?session=abc')), env, fake);
    assert.equal(r.status, 200); assert.equal(r.headers.get('Content-Type'), 'video/mp2t'); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(calls.filter(c => c.url === env.CHECK_URL).length, before);

    // Parâmetro estranho, arquivo estranho, link adulterado.
    assert.equal((await worker.handle(new Request(url + '?redirect=x'), env, fake)).status, 400);
    assert.equal((await worker.handle(new Request(url.replace('index.m3u8', '..%2Fx')), env, fake)).status, 404);
    assert.equal((await worker.handle(new Request(url.replace('/v/', '/v/AA')), env, fake)).status, 403);
    // Origem fora do domínio da Ficou Pronto nunca é buscada, mesmo com token válido.
    assert.equal((await worker.handle(new Request(linkFor('https://evil.example/')), env, fake)).status, 403);
    // Playlist com endereço absoluto é recusada.
    assert.equal((await worker.handle(new Request(url.replace('index.m3u8', 'evil.m3u8')), env, fake)).status, 502);

    // Revogação: a central diz que o pedido saiu do ar.
    checkStatus = 403;
    assert.equal((await worker.handle(new Request(linkFor()), env, fake)).status, 403);
    checkStatus = 409;
    assert.equal((await worker.handle(new Request(linkFor()), env, fake)).status, 409);
    // Central fora do ar: o vídeo continua até a validade do link.
    checkStatus = 0;
    assert.equal((await worker.handle(new Request(linkFor()), env, fake)).status, 200);
    checkStatus = 503;
    assert.equal((await worker.handle(new Request(linkFor()), env, fake)).status, 200);
  });
});

// ---------- Integração: API real + banco local + Cloudflare e MediaMTX simulados ----------
async function fakeCloudflare() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    calls.push({ method: req.method, url: req.url, raw, type: req.headers['content-type'] || '' });
    res.writeHead(req.headers.authorization === 'Bearer test-cf-token' ? 200 : 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: req.headers.authorization === 'Bearer test-cf-token', result: {}, errors: [] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, calls, base: 'http://127.0.0.1:' + server.address().port };
}
async function fakeMediaMTX() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-edge-'));
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

test('edge video: publica o Worker, entrega link assinado, Worker busca na loja e revoga ao pausar', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 60000
}, async () => {
  const cf = await fakeCloudflare(), media = await fakeMediaMTX();
  const saved = { ...process.env };
  Object.assign(process.env, {
    CLOUDFLARE_API_BASE: cf.base, CLOUDFLARE_API_TOKEN: 'test-cf-token', CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_ZONE_ID: ZONE,
    EDGE_VIDEO_KEY: KEY, EDGE_VIDEO_HOST: 'live.ficoupronto.com', EDGE_VIDEO_TENANTS: 'all',
    MEDIA_SECRET_KEY: crypto.randomBytes(32).toString('hex'), NODE_TLS_REJECT_UNAUTHORIZED: '0'
  });
  delete process.env.MEDIA_UPSTREAM_URL; delete process.env.LIVE_CAMERA_ID;
  const { seal } = await import('../src/secret-box.js?edge=' + Date.now());
  const f = await createStoreFixture();
  const { api, request, db } = f;
  try {
    // Worker publicado na inicialização da API: script com segredo e domínio próprio.
    for (let i = 0; i < 50 && cf.calls.length < 2; i++) await new Promise(r => setTimeout(r, 100));
    const put = cf.calls.find(c => c.method === 'PUT' && c.url === `/accounts/${ACCOUNT}/workers/scripts/ficoupronto-video`);
    assert.ok(put, 'Worker enviado'); assert.match(put.type, /multipart\/form-data/);
    assert.match(put.raw, /"main_module":"worker\.js"/); assert.match(put.raw, /"name":"EDGE_VIDEO_KEY"/); assert.match(put.raw, /export async function handle/);
    const domain = cf.calls.find(c => c.method === 'PUT' && c.url === `/accounts/${ACCOUNT}/workers/domains`);
    assert.deepEqual(JSON.parse(domain.raw), { environment: 'production', hostname: 'live.ficoupronto.com', service: 'ficoupronto-video', zone_id: ZONE });
    assert.equal((await api('/master/edge-video', { token: f.masterToken })).state, 'publicado');
    assert.equal((await request('/master/edge-video', { token: f.ownerToken })).status, 403);

    // Loja com vídeo próprio (origem simulada), câmera ligada ao PC da loja e pedido ao vivo.
    const camera = await api('/cameras', { method: 'POST', token: f.masterToken, body: { tenant_id: f.tenant, name: 'Bancada 1' } }, 201);
    const code = await api('/master/tenants/' + f.tenant + '/activation-codes', { method: 'POST', token: f.masterToken }, 201);
    await api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: 'PC' } }, 201);
    await db.query('UPDATE cameras SET device_id=(SELECT id FROM shop_devices WHERE tenant_id=$1 LIMIT 1) WHERE id=$2', [f.tenant, camera.id]);
    const password = 'senha-da-loja-123456';
    await db.query("INSERT INTO store_media(tenant_id,origin,media_username,media_password_enc,source) VALUES($1,$2,'ficoupronto',$3,'adopted')", [f.tenant, media.origin, seal(password)]);
    const proc = await api('/processes', { method: 'POST', body: { name: 'Reparo', steps: ['Bancada'], camera_id: camera.id } }, 201);
    const order = await api('/orders/quick', { method: 'POST', body: { reference: 'Teste', process_id: proc.id } }, 201);
    assert.equal((await request('/orders/' + order.id + '/transition', { method: 'POST', body: { action: 'start' } })).status, 200);
    const token = order.tracking_url.split('/p/')[1];

    // O player recebe um link da borda; nada de senha ou origem no link.
    const source = await (await fetch(f.base + '/api/public/orders/' + token + '/live-source')).json();
    assert.equal(source.mode, 'edge');
    assert.match(source.url, /^https:\/\/live\.ficoupronto\.com\/v\/[A-Za-z0-9_-]+\/index\.m3u8$/);
    assert.ok(!source.url.includes(password) && !source.url.includes('localhost'));

    // O Worker (código real) atende o link: confere com a central e busca na loja.
    const env = { EDGE_VIDEO_KEY: KEY, CHECK_URL: f.base + '/api/edge/live-check', ALLOWED_ORIGINS: 'https://ficoupronto.com', ORIGIN_SUFFIX: 'localhost' };
    let r = await worker.handle(new Request(source.url, { headers: { Origin: 'https://ficoupronto.com' } }), env);
    const text = await r.text();
    assert.equal(r.status, 200, text);
    assert.match(text, /^segment0\.ts\?session=abc$/m, 'referências relativas: herdam /v/<token>/');
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://ficoupronto.com');
    const stream = (await db.query('SELECT stream_path FROM cameras WHERE id=$1', [camera.id])).rows[0].stream_path;
    assert.ok(media.seen.at(-1).url.startsWith('/' + stream + '/index.m3u8'));
    assert.equal(media.seen.at(-1).auth, 'Basic ' + Buffer.from('ficoupronto:' + password).toString('base64'));

    // Checagem direta: válido agora; link de outro segredo é recusado.
    assert.equal((await fetch(env.CHECK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: source.url.split('/v/')[1].split('/')[0] }) })).status, 204);
    assert.equal((await fetch(env.CHECK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(60) }) })).status, 403);

    // Pausou: a central revoga e o Worker passa a recusar (depois do cache de 15 s).
    assert.equal((await request('/orders/' + order.id + '/transition', { method: 'POST', body: { action: 'pause' } })).status, 200);
    assert.equal((await fetch(env.CHECK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: source.url.split('/v/')[1].split('/')[0] }) })).status, 403);
    worker._resetChecks();
    r = await worker.handle(new Request(source.url), env);
    assert.equal(r.status, 403);
    assert.equal((await fetch(f.base + '/api/public/orders/' + token + '/live-source')).status, 404);
  } finally {
    await f.cleanup(); cf.server.close(); media.server.close(); fs.rmSync(media.dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved);
  }
});

test('edge worker: download — só link de download, página amigável quando a loja não responde', async () => {
  await withEnv({ EDGE_VIDEO_KEY: KEY, EDGE_VIDEO_HOST: 'live.ficoupronto.com' }, async () => {
    const edge = await import('../src/edge-video.js?download=' + Date.now());
    const env = { EDGE_VIDEO_KEY: KEY, CHECK_URL: 'https://app.ficoupronto.com/api/edge/live-check', ALLOWED_ORIGINS: '', ORIGIN_SUFFIX: '.ficoupronto.com' };
    const link = edge.edgeDownloadFor({ origin: 'https://video-x.ficoupronto.com/', streamPath: 'cam_1', username: 'ficoupronto', password: 'senha-secreta-123', start: new Date('2026-10-31T12:00:00Z'), seconds: 90, filename: 'pedido-7-etapa-2.mp4' });
    assert.match(link.url, /^https:\/\/live\.ficoupronto\.com\/d\/[A-Za-z0-9_-]+\/pedido-7-etapa-2\.mp4$/);
    let mode = 'ok'; const calls = [];
    const fake = async (url, init) => {
      calls.push({ url: String(url), init });
      if (mode === 'down') throw new Error('down');
      if (mode === '404') return new Response('', { status: 404 });
      return new Response(new Uint8Array([0, 0, 0, 24]), { status: 200, headers: { 'Content-Length': '4' } });
    };
    let r = await worker.handle(new Request(link.url), env, fake);
    assert.equal(r.status, 200); assert.equal(r.headers.get('Content-Disposition'), 'attachment; filename="pedido-7-etapa-2.mp4"'); assert.equal(r.headers.get('Content-Length'), '4');
    const up = new URL(calls[0].url);
    assert.equal(up.origin + up.pathname, 'https://video-x.ficoupronto.com/get');
    assert.deepEqual(Object.fromEntries(up.searchParams), { path: 'cam_1', start: '2026-10-31T12:00:00.000Z', duration: '90', format: 'mp4' });
    assert.equal(calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('ficoupronto:senha-secreta-123').toString('base64'));
    mode = 'down'; r = await worker.handle(new Request(link.url), env, fake);
    assert.equal(r.status, 503); assert.match(r.headers.get('Content-Type'), /text\/html/); assert.match(await r.text(), /Loja offline/);
    mode = '404'; r = await worker.handle(new Request(link.url), env, fake);
    assert.equal(r.status, 404); assert.match(await r.text(), /não encontrado/i);
    // Link do ao vivo não baixa arquivo.
    const live = edge.edgeSourceFor({ origin: 'https://video-x.ficoupronto.com/', streamPath: 'cam_1', username: 'u_ok', password: 'senha-secreta-123', orderToken: 'pedido-abcdefghijklmnop' }).url;
    assert.equal((await worker.handle(new Request(live.replace('/v/', '/d/').replace('index.m3u8', 'x.mp4')), env, fake)).status, 403);
    // Vencido em 15 minutos.
    const t = link.url.split('/d/')[1].split('/')[0];
    assert.equal(await worker.openEdgeToken(t, KEY, Date.now() + 16 * 60000), null);
  });
});
