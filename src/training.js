// Vídeos de treinamento (Audace, 26/11/2026).
// - O vídeo fica no Cloudflare R2 (bucket privado). O servidor gera um link assinado que vale algumas horas,
//   só para quem está logado: o computador do quiosque (com o PIN da vendedora) ou o painel da rede.
// - Quem assistiu: a vendedora digita o PIN antes de abrir; supervisor e dono já estão logados.
// - O vídeo é dividido em trechos de 5 segundos. Um trecho só conta quando passa tocando de verdade;
//   arrastar a barra não conta, e o servidor recusa mais trechos do que o tempo real permite.
// - "Viu até o final" = 95% dos trechos assistidos. Partes (capítulos) mostram o que cada pessoa viu.
// - Nova versão do vídeo (tela mudou, vídeo regravado): todos voltam a "falta assistir" naquele vídeo.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pinOk } from './kiosk.js';
import { manualReads, manualSummary } from './manual.js';

export const BUCKET_S = 5;
export const DONE_PERCENT = 95;
const AUDIENCES = ['seller', 'supervisor', 'owner'];
const buckets = duration => Math.max(1, Math.ceil(duration / BUCKET_S));

// ---------- Cloudflare R2 (S3, assinatura v4 em link) ----------
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
export function r2Config(env = process.env) {
  const c = { account: env.R2_ACCOUNT_ID, key: env.R2_ACCESS_KEY_ID, secret: env.R2_SECRET_ACCESS_KEY, bucket: env.R2_BUCKET };
  return c.account && c.key && c.secret && c.bucket ? c : null;
}
export function presignR2(objectKey, { expires = 6 * 3600, now = new Date(), cfg = r2Config() } = {}) {
  if (!cfg) return null;
  // cfg.host/region/virtual: só para conferir com o exemplo oficial da AWS nos testes.
  const region = cfg.region || 'auto', host = cfg.host || `${cfg.account}.r2.cloudflarestorage.com`;
  const path = '/' + [...(cfg.virtual ? [] : [cfg.bucket]), ...objectKey.split('/')].map(enc).join('/');
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const params = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${cfg.key}/${scope}`, 'X-Amz-Date': amzDate, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host' };
  const query = Object.keys(params).sort().map(k => enc(k) + '=' + enc(params[k])).join('&');
  const canonical = ['GET', path, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const kSign = hmac(hmac(hmac(hmac('AWS4' + cfg.secret, date), region), 's3'), 'aws4_request');
  return `https://${host}${path}?${query}&X-Amz-Signature=${hmac(kSign, toSign).toString('hex')}`;
}
const srcOf = v => v.object_key ? presignR2(v.object_key) : v.url;

// Trechos assistidos: junta o que já tinha com o que chegou ('1' em qualquer um = assistido).
export function mergeSeen(seen, idx, total) {
  const a = (seen || '').padEnd(total, '0').slice(0, total).split('');
  let added = 0;
  for (const i of idx) if (Number.isInteger(i) && i >= 0 && i < total && a[i] !== '1') { a[i] = '1'; added++; }
  return { seen: a.join(''), added };
}
export const percentOf = (seen, total) => Math.floor(((seen || '').slice(0, total).split('1').length - 1) * 100 / total);
// Quanto de cada parte foi assistido.
export function chapterStats(chapters, seen, duration) {
  const total = buckets(duration), list = (chapters || []).slice().sort((a, b) => a.t - b.t);
  return list.map((c, i) => {
    const from = Math.floor(c.t / BUCKET_S), to = Math.max(from + 1, Math.ceil((list[i + 1]?.t ?? duration) / BUCKET_S));
    const part = (seen || '').padEnd(total, '0').slice(from, Math.min(to, total));
    return { title: c.title, t: c.t, percent: part.length ? Math.floor((part.split('1').length - 1) * 100 / part.length) : 0 };
  });
}

const chapter = z.object({ t: z.number().int().min(0).max(14400), title: z.string().trim().min(1).max(80) }).strict();
const videoBody = z.object({
  title: z.string().trim().min(2).max(120), description: z.string().trim().max(600).nullable().optional(),
  object_key: z.string().trim().min(1).max(400).nullable().optional(), url: z.string().trim().url().startsWith('https://').max(1000).nullable().optional(),
  duration_s: z.number().int().min(5).max(14400), chapters: z.array(chapter).max(40).optional(),
  audiences: z.array(z.enum(AUDIENCES)).min(1).max(3).optional(), active: z.boolean().optional(), sort: z.number().int().min(-1000).max(1000).optional(),
  all_networks: z.boolean().optional()
}).strict();

export function registerTraining(app, { q, db, auth, roles, route, bad, valid, audit, uuid, rateLimit, bcrypt, secret }) {
  const limiter = (limit, windowMs = 300000) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false });
  const pub = v => ({ id: v.id, title: v.title, description: v.description, duration_s: v.duration_s, chapters: v.chapters, version: v.version, audiences: v.audiences, sort: v.sort });
  const videosFor = (networkId, audience) => q(`SELECT * FROM training_videos WHERE active AND (network_id = $1 OR network_id IS NULL)
    AND ($2::text IS NULL OR $2 = ANY(audiences)) ORDER BY sort, created_at`, [networkId, audience]);
  const viewsOf = (userIds, videos) => !userIds.length || !videos.length ? Promise.resolve({ rows: [] }) : q(`SELECT w.* FROM training_views w JOIN training_videos v ON v.id = w.video_id AND v.version = w.version
    WHERE w.user_id = ANY($1) AND w.video_id = ANY($2)`, [userIds, videos.map(v => v.id)]);
  const viewOut = (w, v) => w ? { percent: w.percent, seen: w.seen, position: w.position, completed_at: w.completed_at, last_at: w.last_ping_at, chapters: chapterStats(v.chapters, w.seen, v.duration_s) } : null;
  const audienceOf = u => u.network_access === 'supervisor' ? 'supervisor' : 'owner';

  // Começa (ou continua) a assistir: devolve o link do vídeo e um passe que amarra pessoa, vídeo e versão.
  async function start(res, video, userId, tenantId) {
    const src = srcOf(video);
    if (!src) return bad(res, 503, 'Vídeo ainda não configurado no armazenamento. Fale com a FicouPronto.');
    const w = (await q(`INSERT INTO training_views(video_id, user_id, version, tenant_id, seen) VALUES($1,$2,$3,$4,repeat('0',$5))
      ON CONFLICT (video_id, user_id, version) DO UPDATE SET last_ping_at = now(), tenant_id = coalesce(EXCLUDED.tenant_id, training_views.tenant_id) RETURNING *`,
      [video.id, userId, video.version, tenantId, buckets(video.duration_s)])).rows[0];
    const token = jwt.sign({ tv: video.id, uid: userId, ver: video.version }, secret, { algorithm: 'HS256', expiresIn: '6h' });
    res.set('Cache-Control', 'no-store').json({ token, src, video: pub(video), bucket_s: BUCKET_S, done_percent: DONE_PERCENT, view: viewOut(w, video) });
  }

  // ---------- Quiosque: a vendedora assiste com o PIN ----------
  const staff = [auth, roles('owner', 'operator')];
  app.get('/api/store/kiosk/training', ...staff, route(async (req, res) => {
    const t = (await q('SELECT network_id FROM tenants WHERE id = $1', [req.user.tenant_id])).rows[0];
    if (!t?.network_id) return res.set('Cache-Control', 'no-store').json({ videos: [], sellers: [] });
    const videos = (await videosFor(t.network_id, 'seller')).rows;
    const sellers = (await q("SELECT id, name FROM users WHERE tenant_id = $1 AND active AND login_kind = 'pin' ORDER BY lower(name)", [req.user.tenant_id])).rows;
    const views = (await viewsOf(sellers.map(s => s.id), videos)).rows;
    res.set('Cache-Control', 'no-store').json({
      done_percent: DONE_PERCENT, videos: videos.map(pub),
      sellers: sellers.map(s => ({ id: s.id, name: s.name, views: Object.fromEntries(videos.map(v => { const w = views.find(x => x.user_id === s.id && x.video_id === v.id); return [v.id, w ? { percent: w.percent, completed_at: w.completed_at } : null]; })) }))
    });
  }));
  app.post('/api/store/kiosk/training/:id/start', ...staff, limiter(60), route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ seller_id: uuid, pin: z.string().regex(/^\d{4}$/) }).strict(), req, res); if (!v) return;
    const s = (await q("SELECT u.id, t.network_id FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1 AND u.tenant_id = $2 AND u.active AND u.login_kind = 'pin'", [v.seller_id, req.user.tenant_id])).rows[0];
    if (!s || !(await pinOk({ query: q }, bcrypt, s.id, v.pin))) return bad(res, 401, 'PIN incorreto');
    const video = (await videosFor(s.network_id, 'seller')).rows.find(x => x.id === req.params.id);
    if (!video) return bad(res, 404, 'Vídeo não encontrado');
    await start(res, video, s.id, req.user.tenant_id);
  }));

  // ---------- Painel da rede: dono e supervisor ----------
  const net = [auth, roles('network')];
  app.get('/api/network/training', ...net, route(async (req, res) => {
    const videos = (await videosFor(req.user.network_id, audienceOf(req.user))).rows;
    const views = (await viewsOf([req.user.id], videos)).rows;
    res.set('Cache-Control', 'no-store').json({ done_percent: DONE_PERCENT, videos: videos.map(v => ({ ...pub(v), view: viewOut(views.find(w => w.video_id === v.id), v) })) });
  }));
  app.post('/api/network/training/:id/start', ...net, limiter(60), route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const video = (await videosFor(req.user.network_id, audienceOf(req.user))).rows.find(x => x.id === req.params.id);
    if (!video) return bad(res, 404, 'Vídeo não encontrado');
    await start(res, video, req.user.id, null);
  }));
  // Quem já assistiu e quais partes. Dono vê a rede toda; supervisor vê as vendedoras das unidades dele.
  app.get('/api/network/training/report', ...net, route(async (req, res) => {
    const owner = req.user.network_access !== 'supervisor';
    const units = (await q(`SELECT id, coalesce(unit_label, name) label FROM tenants WHERE network_id = $1 AND status IN ('trial', 'active')
      AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY lower(coalesce(unit_label, name))`, [req.user.network_id, owner ? null : req.user.network_unit_ids])).rows;
    const people = (await q(`SELECT u.id, u.name, u.tenant_id, CASE WHEN u.login_kind = 'pin' THEN 'seller' WHEN u.network_access = 'supervisor' THEN 'supervisor' ELSE 'owner' END kind, u.network_unit_ids
      FROM users u WHERE u.active AND ((u.login_kind = 'pin' AND u.tenant_id = ANY($1)) OR ($2 AND u.role = 'network' AND u.network_id = $3 AND u.login_kind = 'email'))
      ORDER BY lower(u.name)`, [units.map(u => u.id), owner, req.user.network_id])).rows;
    const videos = (await videosFor(req.user.network_id, null)).rows;
    const views = (await viewsOf(people.map(p => p.id), videos)).rows;
    const reads = await manualReads(q, people.map(p => p.id));
    res.set('Cache-Control', 'no-store').json({
      done_percent: DONE_PERCENT, bucket_s: BUCKET_S, units, videos: videos.map(pub),
      people: people.map(p => ({ id: p.id, name: p.name, kind: p.kind, unit_id: p.tenant_id, unit_ids: p.kind === 'supervisor' ? p.network_unit_ids || [] : [],
        manual: manualSummary(p.kind, reads.filter(r => r.user_id === p.id)),
        views: Object.fromEntries(videos.filter(v => v.audiences.includes(p.kind)).map(v => [v.id, viewOut(views.find(w => w.user_id === p.id && w.video_id === v.id), v)])) }))
    });
  }));

  // ---------- Progresso (quiosque e painel) ----------
  app.post('/api/training/progress', auth, limiter(600), route(async (req, res) => {
    const v = valid(z.object({ token: z.string().max(1000), buckets: z.array(z.number().int().min(0).max(3000)).max(400), position: z.number().min(0).max(14400) }).strict(), req, res); if (!v) return;
    let t; try { t = jwt.verify(v.token, secret, { algorithms: ['HS256'] }); } catch { return bad(res, 410, 'Passe do vídeo expirado. Feche e abra o vídeo de novo.'); }
    if (!t.tv || !t.uid) return bad(res, 400, 'Passe inválido');
    const video = (await q('SELECT * FROM training_videos WHERE id = $1 AND version = $2', [t.tv, t.ver])).rows[0];
    if (!video) return bad(res, 409, 'Este vídeo foi atualizado. Abra de novo para ver a versão nova.');
    const total = buckets(video.duration_s);
    // Uma atualização por vez para a mesma pessoa e vídeo (dois envios juntos não apagam trechos um do outro).
    const c = await db.connect(); let r, fresh, ask;
    try {
      await c.query('BEGIN');
      const w = (await c.query('SELECT seen, last_ping_at, completed_at FROM training_views WHERE video_id = $1 AND user_id = $2 AND version = $3 FOR UPDATE', [video.id, t.uid, video.version])).rows[0];
      if (!w) { await c.query('ROLLBACK'); return bad(res, 404, 'Abra o vídeo de novo'); }
    // Não aceita mais trechos do que o tempo que passou (até 2x de velocidade, com folga).
      const elapsed = Math.max(0, (Date.now() - new Date(w.last_ping_at).getTime()) / 1000);
      const room = Math.floor(elapsed * 2 / BUCKET_S) + 3;
      ask = [...new Set(v.buckets)].filter(i => i < total && w.seen[i] !== '1').sort((a, b) => a - b);
      fresh = ask.slice(0, room);
      const m = mergeSeen(w.seen, fresh, total), pct = percentOf(m.seen, total);
      r = (await c.query(`UPDATE training_views SET seen = $4, percent = $5::int, position = $6, last_ping_at = now(),
        completed_at = coalesce(completed_at, CASE WHEN $5::int >= $7::int THEN now() END)
        WHERE video_id = $1 AND user_id = $2 AND version = $3 RETURNING percent, completed_at`, [video.id, t.uid, video.version, m.seen, pct, Math.min(Math.round(v.position), video.duration_s), DONE_PERCENT])).rows[0];
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    res.json({ percent: r.percent, completed_at: r.completed_at, accepted: fresh.length, refused: ask.length - fresh.length });
  }));

  // ---------- Central (FicouPronto): cadastra os vídeos de cada rede ----------
  const master = [auth, roles('master')];
  app.get('/api/master/networks/:id/training', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const videos = (await q(`SELECT v.*, (SELECT count(*) FROM training_views w WHERE w.video_id = v.id AND w.version = v.version)::int started,
        (SELECT count(*) FROM training_views w WHERE w.video_id = v.id AND w.version = v.version AND w.completed_at IS NOT NULL)::int completed
      FROM training_videos v WHERE v.network_id = $1 OR v.network_id IS NULL ORDER BY v.sort, v.created_at`, [req.params.id])).rows;
    res.set('Cache-Control', 'no-store').json({ r2: !!r2Config(), videos: videos.map(v => ({ ...pub(v), object_key: v.object_key, url: v.url, active: v.active, all_networks: !v.network_id, started: v.started, completed: v.completed })) });
  }));
  app.post('/api/master/networks/:id/training', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(videoBody, req, res); if (!v) return;
    if (!v.object_key && !v.url) return bad(res, 400, 'Informe o arquivo no R2 ou um link https');
    if (!(await q('SELECT 1 FROM store_networks WHERE id = $1', [req.params.id])).rowCount) return bad(res, 404, 'Rede não encontrada');
    const r = (await q(`INSERT INTO training_videos(network_id, title, description, object_key, url, duration_s, chapters, audiences, active, sort)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [v.all_networks ? null : req.params.id, v.title, v.description || null, v.object_key || null, v.url || null, v.duration_s,
      JSON.stringify(v.chapters || []), v.audiences || AUDIENCES, v.active ?? true, v.sort ?? 0])).rows[0];
    await audit(req, 'training_video_create', 'training_video', r.id, null);
    res.status(201).json(pub(r));
  }));
  app.patch('/api/master/training/:id', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(videoBody.partial().extend({ new_version: z.boolean().optional() }).strict(), req, res); if (!v) return;
    const cur = (await q('SELECT * FROM training_videos WHERE id = $1', [req.params.id])).rows[0];
    if (!cur) return bad(res, 404, 'Vídeo não encontrado');
    const n = { ...cur, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) };
    if (!n.object_key && !n.url) return bad(res, 400, 'Informe o arquivo no R2 ou um link https');
    const r = (await q(`UPDATE training_videos SET title=$2, description=$3, object_key=$4, url=$5, duration_s=$6, chapters=$7, audiences=$8, active=$9, sort=$10,
      version = version + CASE WHEN $11 THEN 1 ELSE 0 END, updated_at = now() WHERE id = $1 RETURNING *`,
      [cur.id, n.title, n.description || null, n.object_key || null, n.url || null, n.duration_s, JSON.stringify(n.chapters || []), n.audiences, n.active, n.sort, !!v.new_version])).rows[0];
    await audit(req, v.new_version ? 'training_video_new_version' : 'training_video_update', 'training_video', r.id, null);
    res.json(pub(r));
  }));
  // Link para conferir o vídeo (e ler a duração) antes de liberar.
  app.post('/api/master/training/preview', ...master, route(async (req, res) => {
    const v = valid(z.object({ object_key: z.string().trim().min(1).max(400).optional(), url: z.string().url().startsWith('https://').optional() }).strict(), req, res); if (!v) return;
    const src = v.object_key ? presignR2(v.object_key, { expires: 3600 }) : v.url;
    if (!src) return bad(res, 503, 'R2 não configurado no servidor (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)');
    res.set('Cache-Control', 'no-store').json({ src });
  }));
}
