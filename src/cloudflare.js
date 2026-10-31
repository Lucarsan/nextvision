// Cliente mínimo da API da Cloudflare para túneis nomeados (remote-managed) e DNS.
// Variáveis: CLOUDFLARE_API_TOKEN (permissões: Account > Cloudflare Tunnel > Edit;
// Zone > DNS > Edit no domínio; para o vídeo pela borda também Account > Workers Scripts > Edit
// e Zone > Workers Routes > Edit), CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID.
// CLOUDFLARE_API_BASE só existe para testes locais.
const base = () => (process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');

export const cloudflareConfigured = () =>
  Boolean(process.env.CLOUDFLARE_API_TOKEN && /^[a-f0-9]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID || '') && /^[a-f0-9]{32}$/.test(process.env.CLOUDFLARE_ZONE_ID || ''));

export class CloudflareError extends Error {
  constructor(step, status, codes) { super('Cloudflare: falha em ' + step); this.step = step; this.status = status; this.codes = codes; }
}

async function call(step, method, path, body, raw = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response, json;
  try {
    response = await fetch(base() + path, {
      method,
      headers: { Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal
    });
    json = await response.json().catch(() => ({}));
  } catch (error) {
    throw new CloudflareError(step, 0, [error.name]);
  } finally { clearTimeout(timer); }
  if (!response.ok || json.success === false) throw new CloudflareError(step, response.status, (json.errors || []).map(e => e.code));
  return json.result;
}

const account = () => '/accounts/' + process.env.CLOUDFLARE_ACCOUNT_ID;
const zone = () => '/zones/' + process.env.CLOUDFLARE_ZONE_ID;

// Rotas publicadas pelo túnel da loja. O HLS do MediaMTX fica em 127.0.0.1:8888.
export const ingressFor = hostname => ({ config: { ingress: [{ hostname, service: 'http://127.0.0.1:8888' }, { service: 'http_status:404' }] } });

export const createTunnel = name => call('criar túnel', 'POST', account() + '/cfd_tunnel', { name, config_src: 'cloudflare' });
export const getTunnel = id => call('consultar túnel', 'GET', account() + '/cfd_tunnel/' + id);
export const configureTunnel = (id, hostname) => call('configurar túnel', 'PUT', account() + '/cfd_tunnel/' + id + '/configurations', ingressFor(hostname));
export const tunnelToken = id => call('obter token do túnel', 'GET', account() + '/cfd_tunnel/' + id + '/token');
export const deleteTunnel = id => call('remover túnel', 'DELETE', account() + '/cfd_tunnel/' + id);
export const findDnsRecord = name => call('consultar DNS', 'GET', zone() + '/dns_records?type=CNAME&name=' + encodeURIComponent(name));
export const createDnsRecord = (name, tunnelId) => call('criar DNS', 'POST', zone() + '/dns_records', { type: 'CNAME', name, content: tunnelId + '.cfargotunnel.com', proxied: true, comment: 'Ficou Pronto: vídeo da loja' });
export const deleteDnsRecord = id => call('remover DNS', 'DELETE', zone() + '/dns_records/' + id);

// Worker do vídeo pela borda (módulo ES). Reenviar o mesmo script é idempotente.
export function putWorkerModule(name, code, bindings) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.js', compatibility_date: '2026-10-01', bindings })], { type: 'application/json' }));
  form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');
  return call('publicar Worker de vídeo', 'PUT', account() + '/workers/scripts/' + encodeURIComponent(name), form, true);
}
// Domínio próprio do Worker (a Cloudflare cria o DNS e o certificado).
export const attachWorkerDomain = (hostname, service) => call('ligar domínio do Worker', 'PUT', account() + '/workers/domains', { environment: 'production', hostname, service, zone_id: process.env.CLOUDFLARE_ZONE_ID });
