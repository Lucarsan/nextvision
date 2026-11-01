// Vídeo por loja e provisionamento do computador da loja.
// - A central prepara (ou adota) o túnel e o endereço de vídeo da loja.
// - O computador ativado pede /api/connect/provision e recebe tudo de que precisa
//   (token do túnel, senha do MediaMTX, câmeras), sem ninguém abrir a Cloudflare.
// - O computador envia sinal de vida por componente em /api/connect/heartbeat.
import { z } from 'zod';
import * as cf from './cloudflare.js';
import { seal, open, randomPassword } from './secret-box.js';

const mediaDomain = () => (process.env.MEDIA_DOMAIN || 'ficoupronto.com').toLowerCase();
const hostLabel = slug => String(slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 40);
const validHostname = h => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h);

export class MediaError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Configuração antiga (uma origem para tudo, no Render). Continua valendo como reserva
// para lojas que ainda não têm vídeo próprio.
export function legacyMediaConfig() {
  const { MEDIA_UPSTREAM_URL, MEDIA_USERNAME, MEDIA_PASSWORD, LIVE_CAMERA_ID } = process.env;
  const uuidOk = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  if (!MEDIA_UPSTREAM_URL || !MEDIA_USERNAME || !MEDIA_PASSWORD) return null;
  if (LIVE_CAMERA_ID && !uuidOk(LIVE_CAMERA_ID)) return null;
  if (!LIVE_CAMERA_ID && process.env.MEDIA_MULTI_CAMERA_ENABLED !== 'true') return null;
  let origin; try { origin = new URL(MEDIA_UPSTREAM_URL); } catch { return null; }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') return null;
  return { origin, username: MEDIA_USERNAME, password: MEDIA_PASSWORD, cameraId: LIVE_CAMERA_ID || null };
}

// Origem de vídeo de um pedido: a da loja, se existir; senão a antiga do Render.
export function mediaConfigFor(row, legacy) {
  if (row.media_origin) {
    let password; try { password = open(row.media_password_enc); } catch { return null; }
    return { origin: new URL(row.media_origin), username: row.media_username, password, cameraId: null, perStore: true };
  }
  return legacy ? { ...legacy, perStore: false } : null;
}

// Caminho no MediaMTX: a câmera do modo antigo publica em /camera; as demais em stream_path.
export const streamPathFor = (camera, legacy) => legacy?.cameraId && camera.id === legacy.cameraId ? 'camera' : camera.stream_path;

async function withTenantLock(db, tenantId, fn) {
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('store-media:' || $1))", [tenantId]);
    return await fn(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('store-media:' || $1))", [tenantId]).catch(() => {});
    client.release();
  }
}

// Cria túnel + endereço + senha da loja, uma vez só. Idempotente.
export async function ensureStoreMedia(db, tenantId, actorId = null) {
  return withTenantLock(db, tenantId, async client => {
    const existing = await client.query('SELECT * FROM store_media WHERE tenant_id=$1', [tenantId]);
    if (existing.rowCount) return existing.rows[0];
    if (!cf.cloudflareConfigured()) throw new MediaError(503, 'A central ainda não está ligada à Cloudflare (CLOUDFLARE_API_TOKEN)');
    const store = await client.query('SELECT id,slug,status FROM tenants WHERE id=$1', [tenantId]);
    if (!store.rowCount) throw new MediaError(404, 'Loja não encontrada');
    const label = hostLabel(store.rows[0].slug);
    if (label.length < 2) throw new MediaError(409, 'Identificador da loja inválido para o endereço de vídeo');
    const hostname = 'video-' + label + '.' + mediaDomain();
    const tunnelName = 'loja-' + label;
    const existingDns = await cf.findDnsRecord(hostname);
    if (Array.isArray(existingDns) && existingDns.length) throw new MediaError(409, 'O endereço ' + hostname + ' já existe na Cloudflare; use "Adotar túnel existente"');
    const tunnel = await cf.createTunnel(tunnelName);
    let dns;
    try {
      await cf.configureTunnel(tunnel.id, hostname);
      dns = await cf.createDnsRecord(hostname, tunnel.id);
    } catch (error) {
      await cf.deleteTunnel(tunnel.id).catch(() => {});
      throw error;
    }
    const row = await client.query(`INSERT INTO store_media(tenant_id,origin,tunnel_id,tunnel_name,media_password_enc,dns_record_id,source,created_by)
      VALUES($1,$2,$3,$4,$5,$6,'provisioned',$7) RETURNING *`,
      [tenantId, 'https://' + hostname, tunnel.id, tunnelName, seal(randomPassword()), dns?.id || null, actorId]);
    await client.query("INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,'provision_media','store_media',$3)", [tenantId, actorId, tunnel.id]);
    return row.rows[0];
  });
}

const publicMedia = (row, cloudflare) => row ? {
  configured: true, origin: row.origin, hostname: new URL(row.origin).hostname, tunnel_id: row.tunnel_id, tunnel_name: row.tunnel_name,
  source: row.source, created_at: row.created_at, cloudflare_configured: cloudflare
} : { configured: false, cloudflare_configured: cloudflare };

const componentState = z.enum(['ok', 'starting', 'degraded', 'down', 'unknown']);
const heartbeatSchema = z.object({
  agent_version: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/),
  components: z.record(z.enum(['service', 'tunnel', 'relay', 'publisher', 'network', 'disk', 'backup']), z.object({ state: componentState, detail: z.string().max(200).optional() })).default({}),
  cameras: z.array(z.object({ id: z.string().uuid(), state: componentState, detail: z.string().max(200).optional() })).max(64).default([]),
  // Relógio do PC: as gravações são achadas pelo horário, então a central corrige a diferença.
  clock: z.string().datetime({ offset: true }).optional(),
  recording: z.object({ state: componentState, detail: z.string().max(200).optional() }).optional()
});

export function registerStoreMedia(app, { q, db, auth, roles, deviceAuth, route, bad, valid, audit, rateLimit, uuid }) {
  const sendError = (res, error) => {
    if (error instanceof MediaError) return bad(res, error.status, error.message);
    if (error instanceof cf.CloudflareError) { console.error('Cloudflare failure', { step: error.step, status: error.status, codes: error.codes }); return bad(res, 502, 'Falha na Cloudflare ao ' + error.step.replace(/^.*?\s/, '')); }
    throw error;
  };

  app.get('/api/master/tenants/:id/media', auth, roles('master'), route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Loja inválida');
    const media = await q('SELECT * FROM store_media WHERE tenant_id=$1', [req.params.id]);
    const devices = await q(`SELECT id,name,enabled,last_seen_at,agent_version,health,health_at,provisioned_at FROM shop_devices
      WHERE tenant_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC`, [req.params.id]);
    res.set('Cache-Control', 'no-store').json({ ...publicMedia(media.rows[0], cf.cloudflareConfigured()), devices: devices.rows });
  }));

  app.post('/api/master/tenants/:id/media', auth, roles('master'), rateLimit({ windowMs: 60000, limit: 10 }), route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Loja inválida');
    try { res.status(201).json(publicMedia(await ensureStoreMedia(db, req.params.id, req.user.id), true)); }
    catch (error) { sendError(res, error); }
  }));

  // Loja instalada antes desta versão: registra o túnel que já existe e a senha atual
  // do MediaMTX (a que está em MEDIA_PASSWORD no Render), sem mexer no PC da loja.
  app.post('/api/master/tenants/:id/media/adopt', auth, roles('master'), rateLimit({ windowMs: 60000, limit: 10 }), route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Loja inválida');
    const v = valid(z.object({ tunnel_id: z.string().uuid(), hostname: z.string().trim().toLowerCase().max(253).refine(validHostname) }), req, res); if (!v) return;
    const legacy = legacyMediaConfig();
    if (!legacy) return bad(res, 409, 'Não há senha de vídeo antiga (MEDIA_PASSWORD) para adotar');
    try {
      if (!cf.cloudflareConfigured()) throw new MediaError(503, 'A central ainda não está ligada à Cloudflare (CLOUDFLARE_API_TOKEN)');
      const tunnel = await cf.getTunnel(v.tunnel_id);
      if (!tunnel || tunnel.deleted_at) throw new MediaError(404, 'Túnel não encontrado na Cloudflare');
      const result = await withTenantLock(db, req.params.id, async client => {
        const row = await client.query(`INSERT INTO store_media(tenant_id,origin,tunnel_id,tunnel_name,media_username,media_password_enc,source,created_by)
          VALUES($1,$2,$3,$4,$5,$6,'adopted',$7) ON CONFLICT (tenant_id) DO NOTHING RETURNING *`,
          [req.params.id, 'https://' + v.hostname, v.tunnel_id, tunnel.name || null, legacy.username, seal(legacy.password), req.user.id]);
        if (!row.rowCount) throw new MediaError(409, 'Esta loja já tem vídeo configurado');
        return row.rows[0];
      });
      await audit(req, 'adopt_media', 'store_media', v.tunnel_id, req.params.id);
      res.status(201).json(publicMedia(result, true));
    } catch (error) {
      if (error.code === '23505') return bad(res, 409, 'Túnel ou endereço já usado por outra loja');
      sendError(res, error);
    }
  }));

  // Tudo que o instalador precisa, entregue só ao computador ativado da própria loja.
  app.post('/api/connect/provision', rateLimit({ windowMs: 10 * 60000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }), deviceAuth, route(async (req, res) => {
    let media;
    try {
      media = await ensureStoreMedia(db, req.device.tenant_id, null);
      if (!media.tunnel_id) throw new MediaError(409, 'Loja sem túnel registrado');
      const token = await cf.tunnelToken(media.tunnel_id);
      if (typeof token !== 'string' || token.length < 40) throw new MediaError(502, 'A Cloudflare não devolveu o token do túnel');
      const legacy = legacyMediaConfig();
      // Loja com um único computador: as câmeras ainda sem computador passam a ser dele.
      // Com mais de um computador, a central escolhe qual câmera fica em qual.
      const active = await q('SELECT count(*)::int n FROM shop_devices WHERE tenant_id=$1 AND enabled AND revoked_at IS NULL', [req.device.tenant_id]);
      if (active.rows[0].n === 1) await q('UPDATE cameras SET device_id=$2 WHERE tenant_id=$1 AND device_id IS NULL AND deleted_at IS NULL', [req.device.tenant_id, req.device.id]);
      const cameras = await q(`SELECT id,name,station,enabled,stream_path,config_version,device_id FROM cameras
        WHERE tenant_id=$1 AND deleted_at IS NULL AND (device_id=$2 OR device_id IS NULL) ORDER BY created_at,id`, [req.device.tenant_id, req.device.id]);
      const store = await q('SELECT id,name,slug,camera_limit,retention_days FROM tenants WHERE id=$1', [req.device.tenant_id]);
      // Mantém a rota de gravações (/get) no túnel também das lojas criadas antes dela.
      if (media.tunnel_id) await cf.configureTunnel(media.tunnel_id, new URL(media.origin).hostname).catch(e => console.error('Túnel não reconfigurado', { step: e.step, status: e.status }));
      await q('UPDATE shop_devices SET provisioned_at=now(),last_seen_at=now() WHERE id=$1', [req.device.id]);
      await q("INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,NULL,'device_provisioned','shop_device',$2)", [req.device.tenant_id, req.device.id]);
      res.set('Cache-Control', 'no-store').json({
        store: store.rows[0],
        device: { id: req.device.id, name: req.device.name },
        media: { origin: media.origin, hostname: new URL(media.origin).hostname, username: media.media_username, password: open(media.media_password_enc), rtsp_port: 8554, hls_port: 8888 },
        tunnel: { id: media.tunnel_id, name: media.tunnel_name, token },
        cameras: cameras.rows.map(({ device_id, ...c }) => ({ ...c, stream_path: streamPathFor(c, legacy), bound: device_id === req.device.id })),
        recording: { retention_days: store.rows[0].retention_days, playback_port: 9996 },
        heartbeat_seconds: 30
      });
    } catch (error) { sendError(res, error); }
  }));

  app.post('/api/connect/heartbeat', rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }), deviceAuth, route(async (req, res) => {
    const v = valid(heartbeatSchema, req, res); if (!v) return;
    const known = await q('SELECT id FROM cameras WHERE tenant_id=$1 AND deleted_at IS NULL AND id = ANY($2::uuid[])', [req.device.tenant_id, v.cameras.map(c => c.id)]);
    const allowed = new Set(known.rows.map(r => r.id));
    const health = { components: v.components, cameras: v.cameras.filter(c => allowed.has(c.id)) };
    if (v.recording) health.recording = v.recording;
    if (v.clock) { const skew = Date.parse(v.clock) - Date.now(); if (Math.abs(skew) < 86400000) health.clock_skew_ms = Math.round(skew); }
    await q('UPDATE shop_devices SET agent_version=$2,health=$3,health_at=now(),last_seen_at=now() WHERE id=$1', [req.device.id, v.agent_version, health]);
    res.set('Cache-Control', 'no-store').json({ ok: true, heartbeat_seconds: 30 });
  }));
}
