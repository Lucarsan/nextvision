// Acesso só no computador da unidade (pedido da Audace). A trava é ligada por unidade:
//  - tenants.device_lock: caixa do quiosque e logins da própria loja só no PC DESTA unidade;
//  - store_networks.device_lock: gestão da rede (dono e supervisores) só em PC de alguma unidade da rede.
// Só liga numa unidade que já tem PC ativado, para não derrubar quem ainda não instalou o agente.
//
// Como funciona:
//  1. O agente Ficou Pronto do PC da unidade (já ativado na central, com credencial nvdev_) abre uma ponte
//     local em http://127.0.0.1:47833. Ela só responde a páginas do endereço da rede.
//  2. Na hora do login, a página pede uma prova à ponte; a ponte pede à central (POST /api/connect/login-proof)
//     e devolve uma prova de uso único que vale 2 minutos.
//  3. O login travado só passa com a senha certa E a prova de um PC ativo.
//     A sessão leva o ID do PC (dev) e cai se o PC for revogado.
// Central (master) e técnico nunca são travados. Desligar a trava na central volta ao acesso pelo link.
import crypto from 'node:crypto';
import { z } from 'zod';
import jwt from 'jsonwebtoken';

export const DEVICE_REQUIRED = 'device_required';
export const DEVICE_MSG = 'Este acesso só funciona no computador da unidade, com o Ficou Pronto instalado.';
const PROOF = /^nvlp_[a-f0-9]{64}$/;
const digest = v => crypto.createHash('sha256').update(v).digest('hex');
export const proofField = z.string().max(80).optional();
export const retryField = z.boolean().optional();

// Gestão da rede travada? (networkId null: nunca)
export async function networkLocked(q, networkId) {
  if (!networkId) return false;
  return !!(await q('SELECT device_lock FROM store_networks WHERE id = $1', [networkId])).rows[0]?.device_lock;
}
// Unidade travada?
export async function unitLocked(q, unitId) {
  if (!unitId) return false;
  return !!(await q('SELECT device_lock FROM tenants WHERE id = $1', [unitId])).rows[0]?.device_lock;
}

// Confere e consome a prova. unitId: o PC precisa ser desta unidade (quiosque). Devolve o PC ou null.
export async function consumeProof(q, { proof, networkId, unitId = null }) {
  if (!PROOF.test(String(proof || ''))) return null;
  const r = await q(`UPDATE device_login_proofs p SET used_at = now()
      FROM shop_devices d JOIN tenants t ON t.id = d.tenant_id
     WHERE p.proof_hash = $1 AND p.used_at IS NULL AND p.expires_at > now() AND d.id = p.device_id
       AND d.enabled AND d.revoked_at IS NULL AND t.status IN ('trial', 'active')
       AND (d.support OR (($2::uuid IS NULL OR t.network_id = $2::uuid) AND ($3::uuid IS NULL OR d.tenant_id = $3::uuid)))
     RETURNING d.id, d.tenant_id, d.name`, [digest(proof), networkId, unitId]);
  return r.rows[0] || null;
}

// Usado no login. locked: a trava que vale para quem está entrando (unidade ou gestão da rede).
// Travado sem prova válida → 403 com code device_required (a página pede a prova e tenta de novo).
// Devolve { ok: true, dev } (dev = ID do PC ou undefined sem trava) ou { ok: false } já respondido.
// retry: segunda tentativa da página (a primeira vai sempre sem prova e não conta como recusa).
export async function gateLogin(q, res, { locked, networkId = null, unitId = null, proof, retry = false, actorId = null, tenantId = null }) {
  if (!locked) return { ok: true };
  const device = await consumeProof(q, { proof, networkId, unitId });
  if (device) return { ok: true, dev: device.id };
  if (retry || proof) await q("INSERT INTO audit_events(tenant_id, actor_id, action, target_type, target_id) VALUES($1, $2, 'device_lock_denied', 'network', $3)",
    [tenantId || unitId, actorId, networkId || unitId]).catch(() => {});
  res.status(403).json({ error: DEVICE_MSG, code: DEVICE_REQUIRED, had_proof: !!proof });
  return { ok: false };
}

export function registerDeviceLock(app, { q, auth, roles, route, bad, valid, audit, uuid, rateLimit, deviceAuth, secret }) {
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

  // Painel da rede: tentativas de entrar fora do PC da unidade. Dono vê a rede toda; supervisor, só as unidades dele.
  app.get('/api/network/access-denied', auth, roles('network'), route(async (req, res) => {
    const all = req.user.network_access === 'owner', ids = req.user.network_unit_ids || [];
    const r = await q(`SELECT a.created_at, u.name actor, coalesce(t.unit_label, t.name) unit FROM audit_events a
        LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN tenants t ON t.id = a.tenant_id
      WHERE a.action = 'device_lock_denied' AND a.created_at > now() - interval '30 days'
        AND (a.target_id = $1::text OR t.network_id = $1::uuid)
        AND ($2::boolean OR a.tenant_id = ANY($3::uuid[]))
      ORDER BY a.created_at DESC LIMIT 100`, [req.user.network_id, all, ids]);
    const locks = await q(`SELECT coalesce(unit_label, name) unit, device_lock locked FROM tenants
      WHERE network_id = $1 AND status IN ('trial', 'active') AND ($2::boolean OR id = ANY($3::uuid[])) ORDER BY 1`, [req.user.network_id, all, ids]);
    res.set('Cache-Control', 'no-store').json({ denied: r.rows, units: locks.rows });
  }));

  // Central: situação da trava e os PCs de cada unidade.
  app.get('/api/master/networks/:id/device-lock', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Rede inválida');
    const n = (await q('SELECT id, device_lock FROM store_networks WHERE id = $1', [req.params.id])).rows[0];
    if (!n) return bad(res, 404, 'Rede não encontrada');
    const units = await q(`SELECT t.id, coalesce(t.unit_label, t.name) label, t.device_lock locked,
        coalesce((SELECT json_agg(json_build_object('id', d.id, 'name', d.name, 'last_seen_at', d.last_seen_at, 'created_at', d.created_at) ORDER BY d.created_at)
          FROM shop_devices d WHERE d.tenant_id = t.id AND d.enabled AND d.revoked_at IS NULL), '[]') devices
      FROM tenants t WHERE t.network_id = $1 AND t.status IN ('trial', 'active') ORDER BY lower(coalesce(t.unit_label, t.name))`, [n.id]);
    const denied = await q(`SELECT a.created_at, u.name actor, coalesce(t.unit_label, t.name) unit FROM audit_events a
        LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN tenants t ON t.id = a.tenant_id
      WHERE a.action = 'device_lock_denied' AND (a.target_id = $1 OR a.tenant_id IN (SELECT id FROM tenants WHERE network_id = $1::uuid)) ORDER BY a.created_at DESC LIMIT 20`, [n.id]);
    res.set('Cache-Control', 'no-store').json({ enabled: n.device_lock, units: units.rows, denied: denied.rows });
  }));

  app.patch('/api/master/networks/:id/device-lock', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Rede inválida');
    const v = valid(z.object({ enabled: z.boolean() }).strict(), req, res); if (!v) return;
    if (!(await q('SELECT 1 FROM store_networks WHERE id = $1', [req.params.id])).rowCount) return bad(res, 404, 'Rede não encontrada');
    if (v.enabled && !(await q(`SELECT 1 FROM shop_devices d JOIN tenants t ON t.id = d.tenant_id
        WHERE t.network_id = $1 AND d.enabled AND d.revoked_at IS NULL LIMIT 1`, [req.params.id])).rowCount)
      return bad(res, 409, 'Nenhuma unidade tem PC ativado. Instale o Ficou Pronto num PC de unidade antes.');
    const r = await q('UPDATE store_networks SET device_lock = $2 WHERE id = $1 RETURNING id, device_lock', [req.params.id, v.enabled]);
    await audit(req, v.enabled ? 'device_lock_on' : 'device_lock_off', 'network', req.params.id, null);
    res.json({ enabled: r.rows[0].device_lock });
  }));

  // Central (suporte): abre o caixa de uma unidade no PC de quem está na central, sem a senha do quiosque
  // e sem a trava. A sessão leva o ID de quem abriu (sup), vale 4 h, cai se essa conta deixar de ser master ativo,
  // e fica registrada (support_open). Não mexe na sessão do PC da unidade.
  app.post('/api/master/tenants/:id/support-session', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Loja inválida');
    const k = (await q(`SELECT u.id, u.tenant_id, u.role, coalesce(t.unit_label, t.name) unit FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.tenant_id = $1 AND u.login_kind = 'kiosk' AND u.active AND t.status IN ('trial', 'active')`, [req.params.id])).rows[0];
    if (!k) return bad(res, 404, 'Esta unidade ainda não tem acesso de quiosque (crie a senha do quiosque).');
    const token = jwt.sign({ id: k.id, tenant_id: k.tenant_id, role: k.role, sup: req.user.id }, secret, { algorithm: 'HS256', expiresIn: '4h' });
    await audit(req, 'support_open', 'tenant', req.params.id, req.params.id);
    res.set('Cache-Control', 'no-store').json({ token, unit: k.unit, panel: '/caixa' });
  }));

  // PCs de suporte: qualquer PC com o agente ativado (de qualquer loja) que a central libera em todas as unidades.
  app.get('/api/master/support-devices', ...master, route(async (_req, res) => {
    const r = await q(`SELECT d.id, d.name, d.support, d.last_seen_at, coalesce(t.unit_label, t.name) store FROM shop_devices d JOIN tenants t ON t.id = d.tenant_id
      WHERE d.enabled AND d.revoked_at IS NULL ORDER BY d.support DESC, lower(coalesce(t.unit_label, t.name)), lower(d.name)`);
    res.set('Cache-Control', 'no-store').json(r.rows);
  }));
  app.patch('/api/master/devices/:id/support', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Computador inválido');
    const v = valid(z.object({ enabled: z.boolean() }).strict(), req, res); if (!v) return;
    const r = await q('UPDATE shop_devices SET support = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id, tenant_id, support', [req.params.id, v.enabled]);
    if (!r.rowCount) return bad(res, 404, 'Computador não encontrado');
    await audit(req, v.enabled ? 'support_device_on' : 'support_device_off', 'shop_device', req.params.id, r.rows[0].tenant_id);
    res.json({ support: r.rows[0].support });
  }));

  // Trava de uma unidade: só liga com PC ativado nela (senão o caixa daquela loja não abre mais).
  app.patch('/api/master/tenants/:id/device-lock', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Loja inválida');
    const v = valid(z.object({ enabled: z.boolean() }).strict(), req, res); if (!v) return;
    if (!(await q('SELECT 1 FROM tenants WHERE id = $1', [req.params.id])).rowCount) return bad(res, 404, 'Loja não encontrada');
    if (v.enabled && !(await q('SELECT 1 FROM shop_devices WHERE tenant_id = $1 AND enabled AND revoked_at IS NULL LIMIT 1', [req.params.id])).rowCount)
      return bad(res, 409, 'Esta unidade ainda não tem PC ativado. Instale o Ficou Pronto no PC dela antes de ligar a trava.');
    const r = await q('UPDATE tenants SET device_lock = $2 WHERE id = $1 RETURNING device_lock', [req.params.id, v.enabled]);
    await audit(req, v.enabled ? 'device_lock_on' : 'device_lock_off', 'tenant', req.params.id, req.params.id);
    res.json({ enabled: r.rows[0].device_lock });
  }));
}
