// Ficou Pronto — entrega do vídeo ao vivo pela borda da Cloudflare (Worker).
//
// Caminho: celular → este Worker → túnel da loja (video-<loja>.ficoupronto.com) → MediaMTX.
// O Render não carrega mais os bytes do vídeo: ele só emite um link /v/<token>/index.m3u8.
//
// O <token> é AES-256-GCM (chave EDGE_VIDEO_KEY, a mesma do Render). Dentro dele vão a
// origem da loja, o caminho da câmera, a senha de leitura do MediaMTX e a validade. O
// cliente não consegue ler nem alterar nada disso. O token vai no CAMINHO do link (não em
// cabeçalho) para funcionar no HLS nativo do iPhone, e as referências relativas da
// playlist herdam o mesmo prefixo /v/<token>/ sozinhas.
//
// Revogação: a cada ~15 s por token, o Worker pergunta ao Render (CHECK_URL) se o pedido
// ainda pode ver aquela câmera. Se o Render estiver fora do ar, o vídeo continua até a
// validade do token (o acesso já tinha sido autorizado na emissão).
//
// Variáveis (bindings): EDGE_VIDEO_KEY (segredo, base64url de 32 bytes), CHECK_URL,
// ALLOWED_ORIGINS (lista separada por vírgula), ORIGIN_SUFFIX (ex.: .ficoupronto.com).

const AAD = new TextEncoder().encode('ficoupronto-edge-v1');
const CHECK_TTL_MS = 15000;
const ASSET = /^(?:index|stream|segment|part|init)[A-Za-z0-9_.-]{0,100}\.(?:m3u8|ts|m4s|mp4)$|^[A-Za-z0-9_-]{1,100}\.(?:m3u8|ts|m4s|mp4)$/;
const STREAM_PATH = /^[A-Za-z0-9_-]{1,100}$/;
const QUERY_KEYS = new Set(['session', '_HLS_msn', '_HLS_part', '_HLS_skip']);
const REFERENCE = /^[A-Za-z0-9_.-]+\.(?:m3u8|ts|m4s|mp4)(?:\?[A-Za-z0-9_=.&-]+)?$/;

const keyCache = new Map();
const checkCache = new Map();

export function base64urlToBytes(value) {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesKey(secret) {
  if (!keyCache.has(secret)) {
    const raw = base64urlToBytes(secret);
    if (raw.length !== 32) throw new Error('EDGE_VIDEO_KEY inválida');
    keyCache.set(secret, crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']));
  }
  return keyCache.get(secret);
}

// Formato: base64url( 0x01 | iv(12) | ciphertext+tag ).
export async function openEdgeToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 1500 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  let bytes;
  try { bytes = base64urlToBytes(token); } catch { return null; }
  if (bytes.length < 1 + 12 + 16 + 2 || bytes[0] !== 1) return null;
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(1, 13), additionalData: AAD }, await aesKey(secret), bytes.subarray(13));
  } catch { return null; }
  let p;
  try { p = JSON.parse(new TextDecoder().decode(plain)); } catch { return null; }
  if (!p || p.v !== 1 || typeof p.e !== 'number' || p.e * 1000 <= now) return null;
  if (typeof p.o !== 'string' || typeof p.s !== 'string' || typeof p.u !== 'string' || typeof p.w !== 'string') return null;
  return p;
}

function originAllowed(origin, suffix) {
  let url;
  try { url = new URL(origin); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  if (!suffix || !url.hostname.endsWith(suffix)) return null;
  return url;
}

function cors(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
}

const reply = (status, message, extra = {}) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });

async function tokenKey(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// true = pode ver; false = revogado; o status vai junto para a mensagem do player.
export async function stillAuthorized(token, env, fetchImpl = fetch, now = Date.now()) {
  const key = await tokenKey(token);
  const cached = checkCache.get(key);
  if (cached && cached.until > now) return cached;
  let result;
  try {
    const r = await fetchImpl(env.CHECK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(5000) });
    if (r.status === 204) result = { ok: true, status: 204 };
    else if ([403, 404, 409, 410].includes(r.status)) result = { ok: false, status: r.status === 409 ? 409 : 403 };
    else result = { ok: true, status: 0 }; // central com problema: mantém até a validade do token
  } catch {
    result = { ok: true, status: 0 };
  }
  result.until = now + CHECK_TTL_MS;
  if (checkCache.size > 5000) checkCache.clear();
  checkCache.set(key, result);
  return result;
}

export function safePlaylist(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('#')) {
      if (/^#EXT-X-(?:KEY|SESSION-KEY):/i.test(line)) return false;
      for (const m of line.matchAll(/URI="([^"]+)"/g)) if (!REFERENCE.test(m[1]) || !ASSET.test(m[1].split('?')[0])) return false;
    } else if (!REFERENCE.test(line) || !ASSET.test(line.split('?')[0])) return false;
  }
  return true;
}

export async function handle(request, env, fetchImpl = fetch) {
  const corsHeaders = cors(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'GET' && request.method !== 'HEAD') return reply(405, 'Método não permitido', corsHeaders);

  const url = new URL(request.url);
  const download = /^\/d\/([A-Za-z0-9_-]{40,1500})\/([A-Za-z0-9_.-]{1,120}\.mp4)$/.exec(url.pathname);
  if (download) return handleDownload(request, env, fetchImpl, download[1], download[2]);
  const match = /^\/v\/([A-Za-z0-9_-]{40,1500})\/([^/]+)$/.exec(url.pathname);
  if (!match || !ASSET.test(match[2])) return reply(404, 'Não encontrado', corsHeaders);
  const [, token, asset] = match;

  const payload = await openEdgeToken(token, env.EDGE_VIDEO_KEY);
  if (!payload || payload.k === 'd') return reply(403, 'Link de vídeo expirado ou inválido', corsHeaders);
  const origin = originAllowed(payload.o, env.ORIGIN_SUFFIX);
  if (!origin || !STREAM_PATH.test(payload.s)) return reply(403, 'Link de vídeo inválido', corsHeaders);

  const upstream = new URL('/' + payload.s + '/' + asset, origin);
  for (const [key, value] of url.searchParams) {
    if (!QUERY_KEYS.has(key) || value.length > 160 || !/^[a-zA-Z0-9_.-]+$/.test(value)) return reply(400, 'Parâmetro HLS inválido', corsHeaders);
    upstream.searchParams.set(key, value);
  }
  const playlist = asset.endsWith('.m3u8');
  if (playlist) {
    // Playlists são pedidas o tempo todo; é nelas que a revogação acontece.
    const check = await stillAuthorized(token, env, fetchImpl);
    if (!check.ok) return reply(check.status, check.status === 409 ? 'Câmera ocupada por outro pedido' : 'Acesso ao vídeo encerrado', corsHeaders);
    if (asset === 'index.m3u8') upstream.searchParams.set('cookieCheck', '1');
  }

  let r;
  try {
    r = await fetchImpl(upstream.toString(), {
      headers: { Authorization: 'Basic ' + btoa(payload.u + ':' + payload.w), Accept: '*/*', 'User-Agent': 'FicouPronto-Edge/1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(35000)
    });
  } catch {
    return reply(502, 'Origem do vídeo indisponível', corsHeaders);
  }
  if (!r.ok) return reply(r.status === 404 ? 404 : 502, r.status === 404 ? 'Aguardando câmera' : 'Origem do vídeo indisponível', corsHeaders);

  const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', ...corsHeaders };
  if (playlist) {
    const text = await r.text();
    if (!safePlaylist(text)) return reply(502, 'Playlist inválida', corsHeaders);
    return new Response(request.method === 'HEAD' ? null : text, { status: 200, headers: { ...headers, 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  const length = Number(r.headers.get('Content-Length') || 0);
  if (length > 8 * 1024 * 1024) return reply(502, 'Segmento excede o limite', corsHeaders);
  // Segmentos passam em fluxo, sem guardar tudo na memória: menos atraso.
  return new Response(request.method === 'HEAD' ? null : r.body, { status: 200, headers: { ...headers, 'Content-Type': asset.endsWith('.ts') ? 'video/mp2t' : 'video/mp4' } });
}

// ---------- Download de gravações ----------
// /d/<token>/<arquivo>.mp4 → MediaMTX da loja: /get?path=&start=&duration=&format=mp4 (servidor de
// gravações, porta 9996, publicado no mesmo túnel e com a mesma senha de leitura).
// O link é aberto direto pelo navegador, então os erros voltam como uma página simples.
const page = (status, title, message) => new Response('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#222"><h1 style="font-size:1.3rem">' + title + '</h1><p>' + message + '</p></body></html>',
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function handleDownload(request, env, fetchImpl, token, filename) {
  const payload = await openEdgeToken(token, env.EDGE_VIDEO_KEY);
  if (!payload || payload.k !== 'd') return page(403, 'Link vencido', 'Este link de download venceu. Volte à página do pedido e toque em "Baixar vídeo" de novo.');
  const origin = originAllowed(payload.o, env.ORIGIN_SUFFIX);
  const start = Date.parse(payload.st);
  if (!origin || !STREAM_PATH.test(payload.s) || !Number.isFinite(start) || !(payload.du > 0 && payload.du <= 6 * 3600)) return page(403, 'Link inválido', 'Este link de download não é válido.');
  const upstream = new URL('/get', origin);
  upstream.searchParams.set('path', payload.s);
  upstream.searchParams.set('start', new Date(start).toISOString());
  upstream.searchParams.set('duration', String(payload.du));
  upstream.searchParams.set('format', 'mp4');
  let r;
  try {
    r = await fetchImpl(upstream.toString(), {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: { Authorization: 'Basic ' + btoa(payload.u + ':' + payload.w), Accept: '*/*', 'User-Agent': 'FicouPronto-Edge/1' },
      redirect: 'manual', signal: AbortSignal.timeout(60000)
    });
  } catch {
    return page(503, 'Loja offline', 'O vídeo fica guardado no computador da loja, que não respondeu agora. Tente novamente mais tarde.');
  }
  if (r.status === 404) return page(404, 'Vídeo não encontrado', 'Não há gravação deste trecho no computador da loja. Ela pode ter passado do prazo de guarda ou não ter sido gravada.');
  if (!r.ok) return page(503, 'Loja offline', 'O vídeo fica guardado no computador da loja, que não respondeu agora. Tente novamente mais tarde.');
  const headers = { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="' + filename + '"', 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' };
  const length = r.headers.get('Content-Length');
  if (length && /^\d+$/.test(length)) headers['Content-Length'] = length;
  // Em fluxo: o arquivo não passa inteiro pela memória do Worker.
  return new Response(request.method === 'HEAD' ? null : r.body, { status: 200, headers });
}

export default { fetch: (request, env) => handle(request, env) };
// Só para testes: esquece o cache de revogação.
export const _resetChecks = () => checkCache.clear();
