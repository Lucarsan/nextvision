// Lojas parceiras na página pública /lojas: mapa (com latitude/longitude) e lista por nicho.
// Só lojas marcadas pela central, ativas ou em teste e fora do modo demonstração.
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

const NICHES = { pet: 'Pet shop · banho e tosa', electronics: 'Assistência técnica', automotive: 'Oficina e funilaria', carwash: 'Estética automotiva', food: 'Alimentação', general: 'Serviços' };

export function registerPartners(app, { q, auth, roles, route, bad, valid, audit }) {
  let cache = { at: 0, data: null };
  app.get('/api/public/partners', rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }), route(async (_req, res) => {
    if (!cache.data || Date.now() - cache.at > 60000) {
      const r = await q(`SELECT t.id, t.name, t.niche, t.partner_description description, t.address, t.city, t.state, t.whatsapp,
          t.partner_lat lat, t.partner_lng lng, t.logo_url, EXISTS (SELECT 1 FROM tenant_logos l WHERE l.tenant_id = t.id) has_logo
        FROM tenants t WHERE t.partner_listed AND NOT t.demo_mode AND t.status IN ('trial', 'active') ORDER BY t.name`);
      cache = { at: Date.now(), data: r.rows.map(t => ({
        name: t.name, niche: t.niche, niche_label: NICHES[t.niche] || NICHES.general, description: t.description || '',
        address: t.address || '', city: t.city || '', state: t.state || '', whatsapp: t.whatsapp || '',
        lat: t.lat, lng: t.lng,
        logo: t.has_logo ? '/api/public/store-logo/' + t.id : (/^https:\/\//.test(t.logo_url || '') ? t.logo_url : null)
      })) };
    }
    res.set('Cache-Control', 'public, max-age=60').json(cache.data);
  }));

  // Central: incluir/tirar a loja da página e ajustar descrição e posição no mapa.
  app.patch('/api/master/tenants/:id/partner', auth, roles('master'), route(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return bad(res, 400, 'Loja inválida');
    const v = valid(z.object({
      partner_listed: z.boolean().optional(), partner_description: z.string().trim().max(400).nullable().optional(),
      partner_lat: z.number().min(-90).max(90).nullable().optional(), partner_lng: z.number().min(-180).max(180).nullable().optional()
    }).strict(), req, res); if (!v) return;
    const keys = Object.keys(v); if (!keys.length) return bad(res, 400, 'Nada para alterar');
    const r = await q(`UPDATE tenants SET ${keys.map((k, i) => k + ' = $' + (i + 2)).join(', ')} WHERE id = $1
      RETURNING id, partner_listed, partner_description, partner_lat, partner_lng`, [req.params.id, ...keys.map(k => v[k] === '' ? null : v[k])]);
    if (!r.rowCount) return bad(res, 404, 'Loja não encontrada');
    cache = { at: 0, data: null };
    await audit(req, 'update_partner_listing', 'tenant', req.params.id, req.params.id);
    res.json(r.rows[0]);
  }));
}
