// Vídeo ao vivo pela borda da Cloudflare (Worker em edge/video-worker.js).
//
// O Render deixa de carregar os bytes do vídeo. Ele só:
//  1. emite um link assinado e cifrado (/v/<token>/index.m3u8) para o pedido autorizado;
//  2. responde ao Worker, a cada ~15 s, se aquele link ainda pode ver a câmera;
//  3. publica o Worker na Cloudflare ao iniciar (idempotente).
//
// Ativação por variáveis (sem migração de banco):
//  EDGE_VIDEO_KEY      base64url de 32 bytes aleatórios (o mesmo segredo vai para o Worker)
//  EDGE_VIDEO_HOST     ex.: live.ficoupronto.com (domínio do Worker)
//  EDGE_VIDEO_TENANTS  "all" ou lista de slugs/ids de loja separados por vírgula
//  EDGE_VIDEO_CHECK_URL (opcional) URL pública de /api/edge/live-check
//  EDGE_VIDEO_ALLOWED_ORIGINS (opcional) origens da página do cliente, para o hls.js
// Sem essas variáveis tudo continua pelo proxy antigo do Render.
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as cf from './cloudflare.js';

const AAD = Buffer.from('ficoupronto-edge-v1');
export const EDGE_TOKEN_SECONDS = 30 * 60;
const WORKER_NAME = 'ficoupronto-video';

const keyBytes = () => {
  const raw = process.env.EDGE_VIDEO_KEY || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const key = Buffer.from(raw, 'base64url');
  return key.length === 32 ? key : null;
};
const edgeHost = () => {
  const host = String(process.env.EDGE_VIDEO_HOST || '').toLowerCase();
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host) ? host : null;
};
const mediaDomain = () => (process.env.MEDIA_DOMAIN || 'ficoupronto.com').toLowerCase();

export const edgeConfigured = () => Boolean(keyBytes() && edgeHost());

export function edgeEnabledFor(tenant) {
  if (!edgeConfigured()) return false;
  const list = String(process.env.EDGE_VIDEO_TENANTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (list.includes('all')) return true;
  return list.includes(String(tenant.id).toLowerCase()) || (tenant.slug && list.includes(String(tenant.slug).toLowerCase()));
}

export function sealEdgeToken(payload, now = Date.now(), seconds = EDGE_TOKEN_SECONDS) {
  const key = keyBytes();
  if (!key) throw new Error('EDGE_VIDEO_KEY ausente');
  const body = { v: 1, ...payload, e: Math.floor(now / 1000) + seconds };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const enc = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
  return { token: Buffer.concat([Buffer.from([1]), iv, enc, cipher.getAuthTag()]).toString('base64url'), expiresAt: new Date(body.e * 1000) };
}

export function openEdgeToken(token, now = Date.now()) {
  const key = keyBytes();
  if (!key || typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,1500}$/.test(token)) return null;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length < 1 + 12 + 16 + 2 || bytes[0] !== 1) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
    decipher.setAAD(AAD);
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const plain = Buffer.concat([decipher.update(bytes.subarray(13, bytes.length - 16)), decipher.final()]);
    const p = JSON.parse(plain.toString('utf8'));
    if (p?.v !== 1 || typeof p.e !== 'number' || p.e * 1000 <= now) return null;
    return p;
  } catch { return null; }
}

// Link que o player do cliente vai usar. `orderToken` é o token público do pedido:
// o Worker o devolve ao Render na checagem de revogação (cifrado, o cliente não vê).
export function edgeSourceFor({ origin, streamPath, username, password, orderToken }) {
  const { token, expiresAt } = sealEdgeToken({ o: String(origin), s: streamPath, u: username, w: password, t: orderToken });
  return { url: 'https://' + edgeHost() + '/v/' + token + '/index.m3u8', expiresAt };
}

// Download de uma gravação: link curto (15 min para começar a baixar), só para aquele trecho.
// `start`/`seconds` já vêm no relógio do PC da loja (a central corrige a diferença).
export const DOWNLOAD_TOKEN_SECONDS = 15 * 60;
export function edgeDownloadFor({ origin, streamPath, username, password, start, seconds, filename }) {
  const { token, expiresAt } = sealEdgeToken({ k: 'd', o: String(origin), s: streamPath, u: username, w: password, st: start.toISOString(), du: seconds }, Date.now(), DOWNLOAD_TOKEN_SECONDS);
  return { url: 'https://' + edgeHost() + '/d/' + token + '/' + filename, expiresAt };
}

// ---------- Publicação do Worker ----------
let workerStatus = { state: 'desligado', at: null, detail: null };
export const edgeWorkerStatus = () => ({ ...workerStatus, host: edgeHost(), tenants: process.env.EDGE_VIDEO_TENANTS || '' });

export async function workerSource() {
  return readFile(new URL('../edge/video-worker.js', import.meta.url), 'utf8');
}

export function workerBindings() {
  const app = (process.env.SHORT_LINK_BASE_URL || 'https://ficoupronto.com').replace(/\/$/, '');
  const check = process.env.EDGE_VIDEO_CHECK_URL || 'https://app.' + mediaDomain() + '/api/edge/live-check';
  const origins = process.env.EDGE_VIDEO_ALLOWED_ORIGINS || [app, 'https://app.' + mediaDomain(), 'https://' + mediaDomain()].filter((v, i, a) => a.indexOf(v) === i).join(',');
  return [
    { type: 'secret_text', name: 'EDGE_VIDEO_KEY', text: process.env.EDGE_VIDEO_KEY },
    { type: 'plain_text', name: 'CHECK_URL', text: check },
    { type: 'plain_text', name: 'ALLOWED_ORIGINS', text: origins },
    { type: 'plain_text', name: 'ORIGIN_SUFFIX', text: '.' + mediaDomain() }
  ];
}

export async function ensureEdgeWorker() {
  if (!edgeConfigured()) { workerStatus = { state: 'desligado', at: new Date().toISOString(), detail: 'EDGE_VIDEO_KEY/EDGE_VIDEO_HOST ausentes' }; return workerStatus; }
  if (!cf.cloudflareConfigured()) { workerStatus = { state: 'falhou', at: new Date().toISOString(), detail: 'Cloudflare não configurada' }; return workerStatus; }
  try {
    await cf.putWorkerModule(WORKER_NAME, await workerSource(), workerBindings());
    await cf.attachWorkerDomain(edgeHost(), WORKER_NAME);
    workerStatus = { state: 'publicado', at: new Date().toISOString(), detail: null };
  } catch (e) {
    // Sem permissão de Workers no token, o vídeo segue pelo proxy antigo.
    workerStatus = { state: 'falhou', at: new Date().toISOString(), detail: (e.step || e.message) + (e.status ? ' (HTTP ' + e.status + (e.codes?.length ? ', ' + e.codes.join('/') : '') + ')' : '') };
    console.error('Worker de vídeo não publicado:', workerStatus.detail);
  }
  return workerStatus;
}

// O link pela borda só é entregue depois que o Worker foi publicado neste processo.
export const edgeReady = () => workerStatus.state === 'publicado' || process.env.EDGE_VIDEO_ASSUME_READY === 'true';
