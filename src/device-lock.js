// Acesso só no computador da unidade (rede com device_lock ligado; pedido da Audace).
//
// Como funciona:
//  1. O agente Ficou Pronto do PC da unidade (já ativado na central, com credencial nvdev_) abre uma ponte
//     local em http://127.0.0.1:47833. Ela só responde a páginas do endereço da rede.
//  2. Na hora do login, a página pede uma prova à ponte; a ponte pede à central (POST /api/connect/login-proof)
//     e devolve uma prova de uso único que vale 2 minutos.
//  3. O login (quiosque, dono, supervisor, gerente) só passa com a senha certa E a prova de um PC ativo da rede.
//     No quiosque, o PC precisa ser da própria unidade. A sessão leva o ID do PC (dev) e cai se o PC for revogado.
// Central (master) e técnico nunca são travados. Desligar a trava na central volta ao acesso pelo link.
import crypto from 'node:crypto';
import { z } from 'zod';

export const DEVICE_REQUIRED = 'device_required';
export const DEVICE_MSG = 'Este acesso só funciona no computador da unidade, com o Ficou Pronto instalado.';
const PROOF = /^nvlp_[a-f0-9]{64}$/;
const digest = v => crypto.createHash('sha256').update(v).digest('hex');
export const proofField = z.string().max(80).optional();

// Rede travada? (networkId pode ser null: loja fora de rede nunca é travada)
export async function networkLocked(q, networkId) {
  if (!networkId) return false;
  return !!(await q('SELECT device_lock FROM store_networks WHERE id = $1', [networkId])).rows[0]?.device_lock;
}

// Confere e consome a prova. unitId: o PC precisa ser desta unidade (quiosque). Devolve o PC ou null.
export async function consumeProof(q, { proof, networkId, unitId = null }) {
  if (!PROOF.test(String(proof || ''))) return null;
  const r = await q(`UPDATE device_login_proofs p SET used_at = now()
      FROM shop_devices d JOIN tenants t ON t.id = d.tenant_id
     WHERE p.proof_hash = $1 AND p.used_at IS NULL AND p.expires_at > now() AND d.id = p.device_id
       AND d.enabled AND d.revoked_at IS NULL AND t.status IN ('trial', 'active') AND t.network_id = $2
       AND ($3::uuid IS NULL OR d.tenant_id = $3::uuid)
     RETURNING d.id, d.tenant_id, d.name`, [digest(proof), networkId, unitId]);
  return r.rows[0] || null;
}

// Usado no login: rede travada sem prova válida → 403 com code device_required (a página pede a prova e tenta de novo).
// Devolve { ok: true, dev } (dev = ID do PC ou undefined quando a rede não é travada) ou { ok: false } já respondido.
export async function gateLogin(q, res, { networkId, unitId = null, proof, actorId = null, tenantId = null }) {
  if (!(await networkLocked(q, networkId))) return { ok: true };
  const device = await consumeProof(q, { proof, networkId, unitId });
  if (device) return { ok: true, dev: device.id };
  await q("INSERT INTO audit_events(tenant_id, actor_id, action, target_type, target_id) VALUES($1, $2, 'device_lock_denied', 'network', $3)",
    [tenantId || unitId, actorId, networkId]).catch(() => {});
  res.status(403).json({ error: DEVICE_MSG, code: DEVICE_REQUIRED, had_proof: !!proof });
  return { ok: false };
}

export function registerDeviceLock(app, { q, auth, roles, route, bad, valid, audit, uuid, rateLimit, deviceAuth }) {
  const master = [auth, roles('master')];

  // Agente → central: prova de uso único para o login neste PC.
  app.post('/api/connect/login-proof', rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }), deviceAuth, route(async (req, res) => {
    const proof = 'nvlp_' + crypto.randomBytes(32).toString('hex');
    await q("INSERT INTO device_login_proofs(proof_hash, device_id, expires_at) VALUES($1, $2, now() + interval '2 minutes')", [digest(proof), req.device.id]);
    // Limpeza de provas antigas (barata, pelo índice de validade).
    if (Math.random() < 0.05) await q("DELETE FROM device_login_proofs WHERE expires_at < now() - interval '1 day'").catch(() => {});
    res.set('Cache-Control', 'no-store').json({ proof, expires_in: 120 });
  }));

  // Agente → central: de quais endereços a ponte local aceita pedidos (endereço próprio da rede da unidade).
  app.get('/api/connect/login-origins', deviceAuth, route(async (req, res) => {
    const r = await q('SELECT n.hostname FROM tenants t JOIN store_networks n ON n.id = t.network_id WHERE t.id = $1', [req.device.tenant_id]);
    const host = r.rows[0]?.hostname;
    res.set('Cache-Control', 'no-store').json({ origins: host ? ['https://' + host] : [] });
  }));

  // Central: situação da trava e os PCs de cada unidade.
  app.get('/api/master/networks/:id/device-lock', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Rede inválida');
    const n = (await q('SELECT id, device_lock FROM store_networks WHERE id = $1', [req.params.id])).rows[0];
    if (!n) return bad(res, 404, 'Rede não encontrada');
    const units = await q(`SELECT t.id, coalesce(t.unit_label, t.name) label,
        coalesce((SELECT json_agg(json_build_object('id', d.id, 'name', d.name, 'last_seen_at', d.last_seen_at, 'created_at', d.created_at) ORDER BY d.created_at)
          FROM shop_devices d WHERE d.tenant_id = t.id AND d.enabled AND d.revoked_at IS NULL), '[]') devices
      FROM tenants t WHERE t.network_id = $1 AND t.status IN ('trial', 'active') ORDER BY lower(coalesce(t.unit_label, t.name))`, [n.id]);
    const denied = await q(`SELECT a.created_at, u.name actor, coalesce(t.unit_label, t.name) unit FROM audit_events a
        LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN tenants t ON t.id = a.tenant_id
      WHERE a.action = 'device_lock_denied' AND a.target_id = $1 ORDER BY a.created_at DESC LIMIT 20`, [n.id]);
    res.set('Cache-Control', 'no-store').json({ enabled: n.device_lock, units: units.rows, denied: denied.rows });
  }));

  app.patch('/api/master/networks/:id/device-lock', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Rede inválida');
    const v = valid(z.object({ enabled: z.boolean() }).strict(), req, res); if (!v) return;
    const r = await q('UPDATE store_networks SET device_lock = $2 WHERE id = $1 RETURNING id, device_lock', [req.params.id, v.enabled]);
    if (!r.rowCount) return bad(res, 404, 'Rede não encontrada');
    await audit(req, v.enabled ? 'device_lock_on' : 'device_lock_off', 'network', req.params.id, null);
    res.json({ enabled: r.rows[0].device_lock });
  }));
}
