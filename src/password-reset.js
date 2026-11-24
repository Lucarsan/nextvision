// Redefinição de senha por e-mail.
// - "Esqueci a senha" (público): manda um link de nova senha para o e-mail, se ele tiver login ativo.
//   A resposta é sempre a mesma, exista ou não o e-mail, para não revelar quem tem conta.
// - Central: "Enviar link de senha" para qualquer login de loja ou de rede.
// - O link leva o código no fragmento (#), que não vai para logs nem para outros sites; o banco guarda só o hash.
//   Vale 1 hora, serve uma vez e um novo pedido anula os anteriores. Trocar a senha encerra as sessões abertas.
import crypto from 'node:crypto';
import { z } from 'zod';
import { sendEmail, emailConfigured } from './reports.js';

const OWN_HOSTS = new Set(['ficoupronto.com', 'www.ficoupronto.com', 'app.ficoupronto.com']);
const VALID_MINUTES = 60;
const digest = t => crypto.createHash('sha256').update(t).digest('hex');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fallbackBase = () => (process.env.PUBLIC_BASE_URL || 'https://app.ficoupronto.com').replace(/\/$/, '');

// Preenchida no registro: manda o link de criar/trocar senha para um login (usada pelo painel da rede ao criar acessos).
export let sendPasswordLink = null;

export function registerPasswordReset(app, { q, auth, roles, route, bad, valid, audit, uuid, rateLimit, bcrypt }) {
  // Endereço do link: o da rede do usuário (ex.: audace.ficoupronto.com) ou o do Ficou Pronto.
  async function baseFor(user, req) {
    if (user.network_hostname) return 'https://' + user.network_hostname;
    const host = String(req?.hostname || '').toLowerCase();
    if (OWN_HOSTS.has(host)) return 'https://' + host;
    return fallbackBase();
  }

  async function issue(user, req, requestedBy = null) {
    const token = crypto.randomBytes(32).toString('base64url');
    await q('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
    await q("INSERT INTO password_resets(user_id, token_hash, requested_by, expires_at) VALUES($1,$2,$3, now() + make_interval(mins => $4))", [user.id, digest(token), requestedBy, VALID_MINUTES]);
    const link = (await baseFor(user, req)) + '/nova-senha#t=' + token;
    const brand = user.brand || 'Ficou Pronto';
    const html = `<!doctype html><html><body style="margin:0;background:#f5f4f0;font-family:Arial,sans-serif;color:#17181d">
<div style="max-width:520px;margin:0 auto;padding:28px 20px"><div style="background:#fff;border-radius:12px;padding:28px">
<p style="font-size:13px;letter-spacing:.2em;font-weight:700;margin:0 0 18px">${esc(brand.toUpperCase())}</p>
<h1 style="font-size:20px;margin:0 0 10px">Criar uma nova senha</h1>
<p style="margin:0 0 18px;line-height:1.5">Olá, ${esc(user.name.split(' ')[0])}. Use o botão abaixo para criar uma nova senha de acesso. O link vale por 1 hora e pode ser usado uma vez.</p>
<p style="margin:0 0 22px"><a href="${esc(link)}" style="display:inline-block;background:#17181d;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700">Criar nova senha</a></p>
<p style="font-size:12px;color:#6b6b70;line-height:1.5;margin:0">Se você não pediu, ignore este e-mail: sua senha atual continua valendo.</p>
</div><p style="font-size:11px;color:#9a9893;text-align:center;margin-top:14px">Enviado pelo Ficou Pronto</p></div></body></html>`;
    await sendEmail(user.email, 'Nova senha · ' + brand, html);
  }

  sendPasswordLink = async (userId, req, requestedBy = null) => {
    if (!emailConfigured()) return false;
    const r = await q(`SELECT u.id, u.name, u.email, n.hostname network_hostname, coalesce(n.name, t.name) brand
      FROM users u LEFT JOIN store_networks n ON n.id = coalesce(u.network_id, (SELECT network_id FROM tenants WHERE id = u.tenant_id))
      LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1 AND u.active AND u.login_kind = 'email'`, [userId]);
    if (!r.rowCount) return false;
    await issue(r.rows[0], req, requestedBy); return true;
  };

  const userByEmail = email => q(`SELECT u.id, u.name, u.email, n.hostname network_hostname, coalesce(n.name, t.name) brand
    FROM users u LEFT JOIN store_networks n ON n.id = coalesce(u.network_id, (SELECT network_id FROM tenants WHERE id = u.tenant_id))
    LEFT JOIN tenants t ON t.id = u.tenant_id WHERE lower(u.email) = lower($1) AND u.active AND u.login_kind = 'email'`, [email]);

  app.post('/api/auth/forgot', rateLimit({ windowMs: 900000, limit: 6, standardHeaders: 'draft-7', legacyHeaders: false }), route(async (req, res) => {
    const v = valid(z.object({ email: z.string().trim().email().max(200) }), req, res); if (!v) return;
    const u = (await userByEmail(v.email)).rows[0];
    if (u && emailConfigured()) {
      // Um pedido por minuto por login (evita encher a caixa de alguém).
      const recent = await q("SELECT 1 FROM password_resets WHERE user_id = $1 AND requested_by IS NULL AND created_at > now() - interval '1 minute'", [u.id]);
      if (!recent.rowCount) await issue(u, req).catch(e => console.error('Envio do link de senha falhou', { message: e.message }));
    }
    res.json({ ok: true, message: 'Se este e-mail tiver acesso, enviamos um link para criar a nova senha. Confira também o spam.' });
  }));

  app.post('/api/auth/reset', rateLimit({ windowMs: 900000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }), route(async (req, res) => {
    const v = valid(z.object({ token: z.string().min(20).max(200), password: z.string().min(12).max(200) }), req, res); if (!v) return;
    const r = await q(`UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`, [digest(v.token)]);
    if (!r.rowCount) return bad(res, 400, 'Link inválido ou vencido. Peça um novo em "Esqueci a senha".');
    const u = await q('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1 AND active RETURNING id, email', [r.rows[0].user_id, await bcrypt.hash(v.password, 12)]);
    if (!u.rowCount) return bad(res, 400, 'Este acesso está desativado. Fale com o suporte.');
    await q('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [u.rows[0].id]);
    await q('INSERT INTO audit_events(tenant_id, actor_id, action, target_type, target_id) SELECT tenant_id, id, $2, $3, id FROM users WHERE id = $1', [u.rows[0].id, 'password_reset', 'user']);
    res.json({ ok: true, email: u.rows[0].email });
  }));

  // Central: manda o link para um login (loja ou rede).
  app.post('/api/master/users/:id/password-link', auth, roles('master'), route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    if (!emailConfigured()) return bad(res, 503, 'Envio de e-mail não configurado no servidor');
    const r = await q(`SELECT u.id, u.name, u.email, u.role, n.hostname network_hostname, coalesce(n.name, t.name) brand
      FROM users u LEFT JOIN store_networks n ON n.id = coalesce(u.network_id, (SELECT network_id FROM tenants WHERE id = u.tenant_id))
      LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1 AND u.active AND u.role <> 'master' AND u.login_kind = 'email'`, [req.params.id]);
    if (!r.rowCount) return bad(res, 404, 'Login não encontrado ou desativado');
    try { await issue(r.rows[0], req, req.user.id); } catch (e) { return bad(res, 502, 'O e-mail não foi enviado: ' + e.message.slice(0, 120)); }
    await audit(req, 'send_password_link', 'user', req.params.id, null);
    res.json({ sent: true, email: r.rows[0].email });
  }));
}
