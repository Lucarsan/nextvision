// Manual do sistema, por função (menu Treinamento). O conteúdo está em manual-content.js.
// - Quiosque: a vendedora abre o manual com o PIN (passe de 2 horas, amarrado ao quiosque da unidade dela).
// - Painel da rede: supervisor e gestão leem logados.
// - "Leu": chegou ao fim da página e ficou pelo menos o tempo mínimo de leitura (conferido no servidor,
//   a partir de quando a página foi aberta). Página nova versão = todos leem de novo.
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pinOk } from './kiosk.js';
import { MANUAL_PAGES, MANUAL_GROUPS, pageByKey, minSeconds } from './manual-content.js';

export const pagesFor = kind => MANUAL_PAGES.filter(p => p.audiences.includes(kind));
const listOut = (kind, reads) => {
  const by = new Map(reads.map(r => [r.page_key + '@' + r.version, r]));
  return pagesFor(kind).map(p => { const r = by.get(p.key + '@' + p.version); return { key: p.key, group: p.group, title: p.title, summary: p.summary, version: p.version, min_s: minSeconds(p), opened_at: r?.opened_at || null, done_at: r?.done_at || null }; });
};
export async function manualReads(q, userIds) {
  if (!userIds.length) return [];
  return (await q('SELECT page_key, version, user_id, opened_at, last_open_at, done_at FROM manual_reads WHERE user_id = ANY($1)', [userIds])).rows;
}
// Resumo para o relatório: por pessoa, quantas páginas leu das que valem para a função dela.
export function manualSummary(kind, reads) {
  const pages = pagesFor(kind), mine = new Map(reads.map(r => [r.page_key + '@' + r.version, r]));
  const list = pages.map(p => { const r = mine.get(p.key + '@' + p.version); return { key: p.key, title: p.title, group: p.group, done_at: r?.done_at || null, opened: !!r }; });
  return { total: list.length, done: list.filter(x => x.done_at).length, opened: list.filter(x => x.opened).length, pages: list };
}

export function registerManual(app, { q, auth, roles, route, bad, valid, uuid, rateLimit, bcrypt, secret }) {
  const limiter = (limit, windowMs = 300000) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false });
  const kindOf = u => u.network_access === 'supervisor' ? 'supervisor' : 'owner';
  const groups = kind => MANUAL_GROUPS.filter(g => pagesFor(kind).some(p => p.group === g.key));
  const staff = [auth, roles('owner', 'operator')], net = [auth, roles('network')];
  // Quem está lendo: a vendedora pelo passe do quiosque, ou a pessoa logada no painel da rede.
  async function reader(req, res, sessionToken) {
    if (req.user.role === 'network') return { userId: req.user.id, kind: kindOf(req.user), tenantId: null };
    if (!['owner', 'operator'].includes(req.user.role)) { bad(res, 403, 'Sem permissão'); return null; }
    let t; try { t = jwt.verify(sessionToken || '', secret, { algorithms: ['HS256'] }); } catch { bad(res, 410, 'Manual fechado. Toque no seu nome e digite o PIN de novo.'); return null; }
    if (!t.ms || t.tid !== req.user.tenant_id) { bad(res, 410, 'Manual fechado. Toque no seu nome e digite o PIN de novo.'); return null; }
    const ok = (await q("SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND active AND login_kind = 'pin'", [t.uid, req.user.tenant_id])).rowCount;
    if (!ok) { bad(res, 410, 'Manual fechado.'); return null; }
    return { userId: t.uid, kind: 'seller', tenantId: req.user.tenant_id };
  }

  // Quiosque: abre o manual da vendedora com o PIN.
  app.post('/api/store/kiosk/manual/session', ...staff, limiter(60), route(async (req, res) => {
    const v = valid(z.object({ seller_id: uuid, pin: z.string().regex(/^\d{4}$/) }).strict(), req, res); if (!v) return;
    const s = (await q("SELECT id, name FROM users WHERE id = $1 AND tenant_id = $2 AND active AND login_kind = 'pin'", [v.seller_id, req.user.tenant_id])).rows[0];
    if (!s || !(await pinOk({ query: q }, bcrypt, s.id, v.pin))) return bad(res, 401, 'PIN incorreto');
    const token = jwt.sign({ ms: 1, uid: s.id, tid: req.user.tenant_id }, secret, { algorithm: 'HS256', expiresIn: '2h' });
    res.set('Cache-Control', 'no-store').json({ token, who: { id: s.id, name: s.name }, groups: groups('seller'), pages: listOut('seller', await manualReads(q, [s.id])) });
  }));
  // Quiosque: quantas páginas cada vendedora da unidade já leu (para a tela do Treinamento).
  app.get('/api/store/kiosk/manual/status', ...staff, route(async (req, res) => {
    const sellers = (await q("SELECT id, name FROM users WHERE tenant_id = $1 AND active AND login_kind = 'pin' ORDER BY lower(name)", [req.user.tenant_id])).rows;
    const reads = await manualReads(q, sellers.map(s => s.id));
    res.set('Cache-Control', 'no-store').json({ total: pagesFor('seller').length, sellers: sellers.map(s => { const m = manualSummary('seller', reads.filter(r => r.user_id === s.id)); return { id: s.id, name: s.name, done: m.done, opened: m.opened }; }) });
  }));
  // Painel da rede: o manual de quem está logado.
  app.get('/api/network/manual', ...net, route(async (req, res) => {
    const kind = kindOf(req.user);
    res.set('Cache-Control', 'no-store').json({ groups: groups(kind), pages: listOut(kind, await manualReads(q, [req.user.id])) });
  }));

  // Abre uma página (conteúdo + marca "abriu"). Reabrir recomeça a contagem do tempo de leitura.
  app.post('/api/manual/pages/:key/open', auth, limiter(300), route(async (req, res) => {
    const v = valid(z.object({ session: z.string().max(1000).optional() }).strict(), req, res); if (!v) return;
    const who = await reader(req, res, v.session); if (!who) return;
    const p = pageByKey.get(req.params.key);
    if (!p || !p.audiences.includes(who.kind)) return bad(res, 404, 'Página não encontrada');
    const r = (await q(`INSERT INTO manual_reads(page_key, version, user_id, tenant_id) VALUES($1,$2,$3,$4)
      ON CONFLICT (page_key, version, user_id) DO UPDATE SET last_open_at = now() RETURNING done_at`, [p.key, p.version, who.userId, who.tenantId])).rows[0];
    res.set('Cache-Control', 'no-store').json({ page: { key: p.key, group: p.group, title: p.title, summary: p.summary, version: p.version, blocks: p.blocks, min_s: minSeconds(p) }, done_at: r.done_at });
  }));
  // Chegou ao fim da página: conta como lida se ficou aberta o tempo mínimo.
  app.post('/api/manual/pages/:key/done', auth, limiter(300), route(async (req, res) => {
    const v = valid(z.object({ session: z.string().max(1000).optional() }).strict(), req, res); if (!v) return;
    const who = await reader(req, res, v.session); if (!who) return;
    const p = pageByKey.get(req.params.key);
    if (!p || !p.audiences.includes(who.kind)) return bad(res, 404, 'Página não encontrada');
    const r = (await q(`UPDATE manual_reads SET done_at = coalesce(done_at, CASE WHEN now() - last_open_at >= make_interval(secs => $4) THEN now() END)
      WHERE page_key = $1 AND version = $2 AND user_id = $3 RETURNING done_at, extract(epoch FROM now() - last_open_at)::int open_s`, [p.key, p.version, who.userId, minSeconds(p)])).rows[0];
    if (!r) return bad(res, 409, 'Abra a página de novo');
    res.json({ done_at: r.done_at, wait_s: r.done_at ? 0 : Math.max(1, minSeconds(p) - r.open_s) });
  }));
}
