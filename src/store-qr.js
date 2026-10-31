// QR code de atendimento da loja.
// O QR abre /<loja>/oi: o cliente informa nome e WhatsApp, entra no cadastro de clientes
// da loja (source = 'qrcode') e é levado ao WhatsApp da loja com uma mensagem pronta.
// Não usa API do WhatsApp: o envio continua pelo app da loja.
import { z } from 'zod';
import QRCode from 'qrcode';
import rateLimit from 'express-rate-limit';

export const DEFAULT_QR_MESSAGE = 'Olá! Sou {nome} e vim pelo QR code da loja.';
const PAGE = /^\/([a-z0-9-]{3,60})\/oi\/?$/;
const placeholderName = name => !/\p{L}/u.test(name || '') || /^contato\s+\d+$/i.test(String(name).trim());
const firstName = name => {
  const m = String(name || '').match(/\p{L}[\p{L}\p{M}'’-]*/u); if (!m) return '';
  const t = m[0].toLocaleLowerCase('pt-BR'); return t.charAt(0).toLocaleUpperCase('pt-BR') + t.slice(1);
};

export function registerStoreQr(app, { q, auth, roles, route, bad, valid, audit }) {
  const baseUrl = () => (process.env.SHORT_LINK_BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const pageUrl = slug => baseUrl() + '/' + slug + '/oi';
  const storeBySlug = async slug => (await q(`SELECT t.id,t.name,t.slug,t.logo_url,t.whatsapp,t.qr_message FROM tenant_slugs s JOIN tenants t ON t.id=s.tenant_id
    WHERE s.slug=$1 AND t.status IN ('trial','active')`, [String(slug || '').toLowerCase()])).rows[0];
  const publicRead = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
  const publicWrite = rateLimit({ windowMs: 10 * 60000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Muitas tentativas. Tente de novo em alguns minutos.' } });

  app.get(PAGE, publicRead, (_req, res) => res.sendFile('contato.html', { root: 'public' }));

  app.get('/api/public/stores/:slug/contact', publicRead, route(async (req, res) => {
    const s = await storeBySlug(req.params.slug); if (!s) return bad(res, 404, 'Loja não encontrada');
    res.set('Cache-Control', 'no-store');
    res.json({ name: s.name, logo_url: s.logo_url || null, ready: !!s.whatsapp });
  }));

  app.post('/api/public/stores/:slug/contact', publicWrite, route(async (req, res) => {
    const v = valid(z.object({ name: z.string().trim().min(2).max(80), phone: z.string().trim().min(8).max(30) }).strict(), req, res); if (!v) return;
    const s = await storeBySlug(req.params.slug); if (!s) return bad(res, 404, 'Loja não encontrada');
    if (!s.whatsapp) return bad(res, 409, 'A loja ainda não cadastrou o WhatsApp de atendimento.');
    const key = (await q('SELECT fp_phone_key($1) k', [v.phone])).rows[0].k;
    if (!key) return bad(res, 400, 'Confira o número do WhatsApp com DDD.');
    const digits = v.phone.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
    const found = await q('SELECT id,name FROM customers WHERE tenant_id=$1 AND phone_key=$2 AND deleted_at IS NULL ORDER BY created_at LIMIT 1', [s.id, key]);
    let created = false;
    if (found.rowCount) {
      if (placeholderName(found.rows[0].name)) await q('UPDATE customers SET name=$1 WHERE id=$2', [v.name, found.rows[0].id]);
    } else {
      await q("INSERT INTO customers(tenant_id,name,phone,source) VALUES($1,$2,$3,'qrcode')", [s.id, v.name, digits]);
      created = true;
    }
    const text = (s.qr_message || DEFAULT_QR_MESSAGE).replace(/\{nome\}/g, firstName(v.name) || v.name).replace(/\{loja\}/g, s.name);
    res.set('Cache-Control', 'no-store');
    res.status(created ? 201 : 200).json({ whatsapp_url: 'https://wa.me/' + s.whatsapp + '?text=' + encodeURIComponent(text) });
  }));

  app.get('/api/public/stores/:slug/qr.svg', publicRead, route(async (req, res) => {
    const s = await storeBySlug(req.params.slug); if (!s) return bad(res, 404, 'Loja não encontrada');
    const svg = await QRCode.toString(pageUrl(s.slug), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.set('Content-Type', 'image/svg+xml'); res.set('Cache-Control', 'public, max-age=3600'); res.send(svg);
  }));

  // Painel: link, mensagem e prévia do QR.
  app.get('/api/store/qr', auth, roles('owner', 'operator'), route(async (req, res) => {
    const t = (await q('SELECT slug,name,whatsapp,qr_message FROM tenants WHERE id=$1', [req.user.tenant_id])).rows[0];
    if (!t) return bad(res, 404, 'Loja não encontrada');
    const today = (await q("SELECT count(*)::int n FROM customers WHERE tenant_id=$1 AND source='qrcode' AND deleted_at IS NULL AND created_at > now() - interval '1 day'", [req.user.tenant_id])).rows[0].n;
    res.json({ url: pageUrl(t.slug), qr_url: '/api/public/stores/' + t.slug + '/qr.svg', name: t.name, has_whatsapp: !!t.whatsapp, qr_message: t.qr_message || '', default_message: DEFAULT_QR_MESSAGE, new_last_24h: today });
  }));
  app.patch('/api/store/qr', auth, roles('owner'), route(async (req, res) => {
    const v = valid(z.object({ qr_message: z.string().trim().max(500) }).strict(), req, res); if (!v) return;
    const msg = v.qr_message === DEFAULT_QR_MESSAGE ? '' : v.qr_message;
    await q('UPDATE tenants SET qr_message=NULLIF($1,\'\') WHERE id=$2', [msg, req.user.tenant_id]);
    await audit(req, 'update', 'store_qr', req.user.tenant_id); res.json({ qr_message: msg });
  }));
}
