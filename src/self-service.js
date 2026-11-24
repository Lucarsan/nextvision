// Autoatendimento de acessos, sem passar pela central:
// - Trocar a própria senha estando logado (qualquer login com e-mail).
// - Senha do computador do quiosque: dono e supervisor da rede trocam nas unidades deles.
// - PIN: a vendedora troca o próprio no quiosque (PIN atual + novo); supervisor ou dono gera um novo para quem esqueceu.
import crypto from 'node:crypto';
import { z } from 'zod';
import { pinOk } from './kiosk.js';

export function registerSelfService(app, { q, auth, roles, route, bad, valid, audit, uuid, rateLimit, bcrypt }) {
  const network = [auth, roles('network')];
  const inScope = (req, tenantId) => req.user.network_access !== 'supervisor' || (req.user.network_unit_ids || []).includes(tenantId);
  const limiter = (limit, windowMs = 900000) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false });

  // Trocar a própria senha. As outras sessões abertas são encerradas; esta continua com o novo login feito pela tela.
  app.post('/api/auth/change-password', auth, limiter(10), route(async (req, res) => {
    const v = valid(z.object({ current_password: z.string().min(1).max(200), new_password: z.string().min(12, 'A nova senha precisa ter pelo menos 12 caracteres').max(200) }).strict(), req, res); if (!v) return;
    const u = (await q("SELECT id, email, password_hash, login_kind FROM users WHERE id=$1 AND active", [req.user.id])).rows[0];
    if (!u || u.login_kind !== 'email') return bad(res, 403, 'Este acesso não tem senha própria');
    if (!(await bcrypt.compare(v.current_password, u.password_hash))) return bad(res, 400, 'Senha atual incorreta');
    if (v.current_password === v.new_password) return bad(res, 400, 'A nova senha precisa ser diferente da atual');
    await q('UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1', [u.id, await bcrypt.hash(v.new_password, 12)]);
    await q('UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [u.id]).catch(() => {});
    await audit(req, 'change_password', 'user', u.id, req.user.tenant_id || null);
    res.json({ ok: true, email: u.email });
  }));

  // Senha do quiosque da unidade (dono ou supervisor da unidade).
  app.put('/api/network/units/:id/kiosk-password', ...network, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success || !inScope(req, req.params.id)) return bad(res, 404, 'Unidade não encontrada');
    const v = valid(z.object({ password: z.string().min(8, 'A senha do quiosque precisa ter pelo menos 8 caracteres').max(200).optional() }).strict(), req, res); if (!v) return;
    const t = (await q('SELECT id, name, unit_label FROM tenants WHERE id=$1 AND network_id=$2', [req.params.id, req.user.network_id])).rows[0];
    if (!t) return bad(res, 404, 'Unidade não encontrada');
    const password = v.password || ('Un-' + crypto.randomBytes(6).toString('base64url'));
    const hash = await bcrypt.hash(password, 12);
    const up = await q("UPDATE users SET password_hash=$2, password_changed_at=now(), active=true WHERE tenant_id=$1 AND login_kind='kiosk' RETURNING id", [t.id, hash]);
    if (!up.rowCount) await q(`INSERT INTO users(tenant_id, name, email, password_hash, role, access_level, login_kind) VALUES($1,$2,$3,$4,'operator','full','kiosk')`,
      [t.id, 'Caixa do quiosque ' + (t.unit_label || t.name), 'quiosque+' + t.id + '@kiosk.invalid', hash]);
    await audit(req, 'set_kiosk_password', 'tenant', t.id, t.id);
    res.json({ unit: t.unit_label || t.name, password: v.password ? null : password });
  }));

  // Vendedora troca o próprio PIN no quiosque.
  app.post('/api/store/kiosk/change-pin', auth, roles('owner', 'operator'), limiter(20), route(async (req, res) => {
    const v = valid(z.object({ seller_id: uuid, current_pin: z.string().regex(/^\d{4}$/), new_pin: z.string().regex(/^\d{4}$/, 'O PIN tem 4 números') }).strict(), req, res); if (!v) return;
    const s = (await q("SELECT id FROM users WHERE id=$1 AND tenant_id=$2 AND active AND login_kind='pin'", [v.seller_id, req.user.tenant_id])).rows[0];
    if (!s || !(await pinOk({ query: q }, bcrypt, s.id, v.current_pin))) return bad(res, 401, 'PIN atual incorreto');
    if (v.current_pin === v.new_pin) return bad(res, 400, 'O novo PIN precisa ser diferente do atual');
    if (/^(\d)\1{3}$|^(0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321|3210)$/.test(v.new_pin)) return bad(res, 400, 'PIN fácil demais (números repetidos ou em sequência). Escolha outro.');
    await q('UPDATE users SET pin_hash=$2 WHERE id=$1', [s.id, await bcrypt.hash(v.new_pin, 10)]);
    await audit(req, 'change_pin', 'user', s.id, req.user.tenant_id);
    res.json({ ok: true });
  }));

  // Supervisor (das unidades dele) ou dono gera um PIN novo para quem esqueceu. Mostrado uma vez.
  app.post('/api/network/people/:id/new-pin', ...network, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const u = (await q(`SELECT u.id, u.name, u.tenant_id, u.role, u.network_id, u.network_access, u.login_kind FROM users u LEFT JOIN tenants t ON t.id=u.tenant_id
      WHERE u.id=$1 AND u.active AND (t.network_id=$2 OR u.network_id=$2)`, [req.params.id, req.user.network_id])).rows[0];
    if (!u) return bad(res, 404, 'Pessoa não encontrada');
    const isSeller = u.login_kind === 'pin';
    if (req.user.network_access === 'supervisor' && (!isSeller || !inScope(req, u.tenant_id))) return bad(res, 403, 'Supervisor gera PIN só para vendedoras das unidades dele');
    if (!isSeller && u.id !== req.user.id && req.user.network_access !== 'owner') return bad(res, 403, 'Sem permissão');
    let pin; do { pin = String(crypto.randomInt(0, 10000)).padStart(4, '0'); } while (/^(\d)\1{3}$/.test(pin));
    await q('UPDATE users SET pin_hash=$2 WHERE id=$1', [u.id, await bcrypt.hash(pin, 10)]);
    await audit(req, 'reset_pin', 'user', u.id, u.tenant_id || null);
    res.json({ name: u.name, pin });
  }));
}
