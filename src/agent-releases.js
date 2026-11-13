// Atualização remota do agente da loja.
// - Pacotes assinados ficam em agent-releases/<versao>.json (gerados por scripts/agent-release.mjs).
//   A assinatura é conferida no PC (chave pública embutida no agente); a central só entrega.
// - A central marca um computador para atualizar; o pedido vai na resposta do sinal de vida.
// - O PC relata o andamento no próprio sinal de vida (baixando, aguardando, instalando, concluída, desfeita).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
// Primeira versão com o atualizador: as anteriores ignoram o pedido.
export const FIRST_UPDATABLE = '0.5.1';
export const releasesDir = () => process.env.AGENT_RELEASES_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-releases');

export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

let cache = { at: 0, list: [] };
export function listReleases() {
  if (Date.now() - cache.at < 30000) return cache.list;
  const dir = releasesDir(); const list = [];
  let names = []; try { names = fs.readdirSync(dir); } catch { names = []; }
  for (const name of names) {
    const m = /^(\d{1,4}\.\d{1,4}\.\d{1,4})\.json$/.exec(name); if (!m) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name));
      const env = JSON.parse(raw.toString('utf8'));
      const manifest = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8'));
      if (manifest.version !== m[1]) continue;
      list.push({ version: m[1], notes: manifest.notes || '', created_at: manifest.created_at || null, files: (manifest.files || []).length, bytes: raw.length, sha256: crypto.createHash('sha256').update(raw).digest('hex'), key_id: env.key_id });
    } catch { /* pacote ilegível: fica de fora */ }
  }
  list.sort((a, b) => compareVersions(b.version, a.version));
  cache = { at: Date.now(), list };
  return list;
}
export const releaseExists = v => VERSION.test(v) && listReleases().some(r => r.version === v);

const updateReport = z.object({
  version: z.string().regex(VERSION),
  request_id: z.string().uuid().optional(),
  state: z.enum(['downloading', 'waiting', 'installing', 'done', 'failed', 'rolled_back']),
  detail: z.string().max(200).optional()
});
export const heartbeatUpdateSchema = updateReport.optional();

// Pedido a devolver no sinal de vida (ou null).
export function pendingUpdate(device, agentVersion) {
  const target = device.agent_update_target;
  if (!target || !device.agent_update_request) return null;
  if (compareVersions(agentVersion, FIRST_UPDATABLE) < 0) return null;
  if (compareVersions(target, agentVersion) <= 0) return null;
  if (!releaseExists(target)) return null;
  return { version: target, request_id: device.agent_update_request, url: '/api/connect/agent-release/' + target };
}

export function registerAgentReleases(app, { q, auth, roles, deviceAuth, route, bad, valid, audit, uuid }) {
  app.get('/api/master/agent-releases', auth, roles('master'), route(async (req, res) => {
    res.set('Cache-Control', 'no-store').json({ first_updatable: FIRST_UPDATABLE, releases: listReleases() });
  }));

  const target = z.object({ version: z.string().regex(VERSION) });
  app.post('/api/master/tenants/:id/devices/:deviceId/agent-update', auth, roles('master'), route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success || !uuid.safeParse(req.params.deviceId).success) return bad(res, 400, 'Computador inválido');
    const v = valid(target, req, res); if (!v) return;
    if (!releaseExists(v.version)) return bad(res, 404, 'Versão ' + v.version + ' não está publicada na central');
    const dev = await q('SELECT id,agent_version FROM shop_devices WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL', [req.params.deviceId, req.params.id]);
    if (!dev.rowCount) return bad(res, 404, 'Computador não encontrado');
    const current = dev.rows[0].agent_version;
    if (!current || compareVersions(current, FIRST_UPDATABLE) < 0) return bad(res, 409, 'Este computador está com o agente ' + (current || 'desconhecido') + ': a atualização à distância começa na ' + FIRST_UPDATABLE + '. Rode o instalador no PC uma vez.');
    if (compareVersions(v.version, current) <= 0) return bad(res, 409, 'O computador já está na ' + current);
    const r = await q(`UPDATE shop_devices SET agent_update_target=$3,agent_update_request=gen_random_uuid(),agent_update_requested_at=now(),agent_update_status=NULL,agent_update_status_at=NULL
      WHERE id=$1 AND tenant_id=$2 RETURNING id,agent_update_target,agent_update_request,agent_update_requested_at`, [req.params.deviceId, req.params.id, v.version]);
    await audit(req, 'agent_update_requested', 'shop_device', req.params.deviceId, req.params.id);
    res.json(r.rows[0]);
  }));

  app.delete('/api/master/tenants/:id/devices/:deviceId/agent-update', auth, roles('master'), route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success || !uuid.safeParse(req.params.deviceId).success) return bad(res, 400, 'Computador inválido');
    const r = await q('UPDATE shop_devices SET agent_update_target=NULL,agent_update_request=NULL WHERE id=$1 AND tenant_id=$2 RETURNING id', [req.params.deviceId, req.params.id]);
    if (!r.rowCount) return bad(res, 404, 'Computador não encontrado');
    await audit(req, 'agent_update_cancelled', 'shop_device', req.params.deviceId, req.params.id);
    res.json({ ok: true });
  }));

  // Download do pacote: só para o computador que recebeu o pedido daquela versão.
  app.get('/api/connect/agent-release/:version', deviceAuth, route(async (req, res) => {
    const version = req.params.version;
    if (!VERSION.test(version) || !releaseExists(version)) return bad(res, 404, 'Versão não encontrada');
    const dev = await q('SELECT agent_update_target FROM shop_devices WHERE id=$1', [req.device.id]);
    if (dev.rows[0]?.agent_update_target !== version) return bad(res, 403, 'Atualização não liberada para este computador');
    res.set('Cache-Control', 'no-store').type('application/json').send(fs.readFileSync(path.join(releasesDir(), version + '.json')));
  }));
}
