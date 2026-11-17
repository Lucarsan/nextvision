// Central → "Custos": quanto cada loja (e cada grupo de lojas do mesmo dono) custa por mês.
//
// Fontes:
//  - Banco (Neon): valor REAL cobrado no mês, pela API de consumo (neon-billing.js), só do projeto do
//    Ficou Pronto. Computação é rateada pelo tempo em que cada loja manteve o banco acordado
//    (slot_share, medido em usage-meter.js); armazenamento, pelo espaço que os dados de cada loja ocupam.
//  - O que não é de nenhuma loja (central, rotinas, monitoramento) fica como "plataforma" e é
//    redistribuído entre as lojas na proporção do uso direto de cada uma (coluna à parte).
//  - Custos fixos cadastrados pela central (ex.: chip por câmera): rateio por câmera, por loja,
//    por uso ou só da plataforma.
// Valores antes dos créditos: é o custo de verdade de cada loja, mesmo que o crédito pague a fatura.
import { neonBilling } from './neon-billing.js';
import { neonProjectId } from './monitoring.js';

const round = (n, d = 2) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;
const ident = s => '"' + String(s).replace(/"/g, '""') + '"';
const RULES = ['per_camera', 'per_store', 'by_usage', 'platform'];

// Espaço ocupado por loja: soma do tamanho das linhas de todas as tabelas com tenant_id. Pesado em
// banco grande; aqui o banco é pequeno. Guardado por 6 h.
let sizeCache = null;
export async function storageByTenant(q, now = Date.now()) {
  if (sizeCache && now - sizeCache.at < 6 * 3600000) return sizeCache.data;
  const tables = (await q(`SELECT c.table_name t FROM information_schema.columns c JOIN information_schema.tables tb ON tb.table_schema=c.table_schema AND tb.table_name=c.table_name AND tb.table_type='BASE TABLE'
    WHERE c.table_schema=current_schema() AND c.column_name='tenant_id' AND c.table_name NOT IN ('tenant_usage_daily','platform_alerts','audit_events') ORDER BY 1`)).rows.map(r => r.t);
  const bytes = {};
  for (const t of tables) {
    const r = await q(`SELECT tenant_id::text id, sum(pg_column_size(x.*))::bigint b FROM ${ident(t)} x WHERE tenant_id IS NOT NULL GROUP BY 1`);
    for (const row of r.rows) bytes[row.id] = (bytes[row.id] || 0) + Number(row.b);
  }
  const total = Number((await q('SELECT pg_database_size(current_database())::bigint b')).rows[0].b);
  sizeCache = { at: now, data: { bytes, total } };
  return sizeCache.data;
}

const monthRange = month => {
  const [y, m] = month.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)), first: `${month}-01`, next: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10) };
};

let orgCache = null;
async function neonForMonth(month, now) {
  const key = process.env.NEON_API_KEY, projectId = neonProjectId();
  if (!key) return { available: false, reason: 'Falta a chave NEON_API_KEY no Render.' };
  if (!projectId) return { available: false, reason: 'Projeto do Neon ainda não identificado (abra o Monitoramento uma vez ou defina NEON_PROJECT_ID).' };
  try {
    if (!orgCache || orgCache.project !== projectId) {
      const r = await fetch('https://console.neon.tech/api/v2/projects/' + encodeURIComponent(projectId), { headers: { Accept: 'application/json', Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw Error('HTTP ' + r.status);
      orgCache = { project: projectId, org: (await r.json())?.project?.org_id };
    }
    const { from, to } = monthRange(month);
    const end = new Date(Math.min(to.getTime(), Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)));
    if (end <= from) return { available: true, plan: null, compute_usd: 0, storage_usd: 0, total_usd: 0 };
    const b = await neonBilling({ orgId: orgCache.org, from, to: end, key, now });
    const p = b.projects.find(x => x.id === projectId);
    return { available: true, plan: b.plan, billing_since: b.billing_since, project: p?.name || projectId,
      compute_usd: round(p?.compute_usd, 4), storage_usd: round(p?.storage_usd, 4), total_usd: round(p?.total_usd, 4), cu_hours: p?.cu_hours || 0,
      other_projects: b.projects.filter(x => x.id !== projectId).map(x => ({ name: x.name, total_usd: round(x.total_usd, 2) })) };
  } catch (err) {
    if (err.status === 403 || /HTTP 40[23]/.test(err.message)) return { available: false, reason: 'O Neon só informa cobrança no plano pago.' };
    return { available: false, reason: 'Não consegui consultar o Neon: ' + String(err.message).slice(0, 120) };
  }
}

// Rateio puro (testável sem banco nem rede).
export function allocate({ stores, usage, storage, neon, items, usdBrl }) {
  const byId = new Map(stores.map(s => [s.id, { ...s, usage: { requests: 0, bytes_out: 0, db_queries: 0, db_ms: 0, active_slots: 0, slot_share: 0 }, storage_bytes: storage.bytes[s.id] || 0 }]));
  const platform = { requests: 0, bytes_out: 0, db_queries: 0, db_ms: 0, active_slots: 0, slot_share: 0 };
  for (const u of usage) {
    const target = u.subject === 'platform' ? platform : byId.get(u.subject)?.usage;
    if (!target) { for (const k in platform) platform[k] += Number(u[k]) || 0; continue; } // loja apagada: vira plataforma
    for (const k in target) target[k] += Number(u[k]) || 0;
  }
  const list = [...byId.values()];
  const storeSlots = list.reduce((a, s) => a + s.usage.slot_share, 0), allSlots = storeSlots + platform.slot_share;
  const storeBytes = list.reduce((a, s) => a + s.storage_bytes, 0);
  const totalBytes = Math.max(storage.total || 0, storeBytes);
  const camerasTotal = list.reduce((a, s) => a + (s.cameras || 0), 0);
  const fx = c => (c === 'USD' ? 1 : 1 / usdBrl);
  const fixed = (items || []).map(it => ({ ...it, usd: (Number(it.amount) || 0) * fx(it.currency) }));
  let platformFixed = 0;
  for (const s of list) {
    const cShare = allSlots ? s.usage.slot_share / allSlots : 0;
    const sShare = totalBytes ? s.storage_bytes / totalBytes : 0;
    const direct = neon.available ? (neon.compute_usd || 0) * cShare + (neon.storage_usd || 0) * sShare : 0;
    // Parte da plataforma (central, rotinas) dividida pelo uso direto de cada loja.
    const useShare = storeSlots ? s.usage.slot_share / storeSlots : (list.length ? 1 / list.length : 0);
    const platformNeon = neon.available ? ((neon.compute_usd || 0) * (allSlots ? platform.slot_share / allSlots : 0) + (neon.storage_usd || 0) * Math.max(0, 1 - storeBytes / (totalBytes || 1))) * useShare : 0;
    let fixedUsd = 0;
    for (const it of fixed) {
      if (it.rule === 'per_camera') fixedUsd += camerasTotal ? it.usd * (s.cameras || 0) / camerasTotal : 0;
      else if (it.rule === 'per_store') fixedUsd += list.length ? it.usd / list.length : 0;
      else if (it.rule === 'by_usage') fixedUsd += it.usd * useShare;
    }
    Object.assign(s, { compute_share: round(cShare * 100, 1), storage_share: round(sShare * 100, 1),
      neon_usd: round(direct, 4), platform_usd: round(platformNeon, 4), fixed_usd: round(fixedUsd, 4) });
    s.total_usd = round(s.neon_usd + s.platform_usd + s.fixed_usd, 4); s.total_brl = round(s.total_usd * usdBrl, 2);
  }
  for (const it of fixed) if (it.rule === 'platform' || (it.rule === 'per_camera' && !camerasTotal) || !list.length) platformFixed += it.usd;
  const groups = new Map();
  for (const s of list) {
    const g = s.billing_group || s.name, gk = s.billing_group ? 'g:' + s.billing_group.toLowerCase() : 's:' + s.id;
    const cur = groups.get(gk) || { key: gk, name: g, grouped: !!s.billing_group, stores: [], total_usd: 0, total_brl: 0, cameras: 0 };
    cur.stores.push({ id: s.id, name: s.name }); cur.total_usd = round(cur.total_usd + s.total_usd, 4); cur.total_brl = round(cur.total_brl + s.total_brl, 2); cur.cameras += s.cameras || 0;
    groups.set(gk, cur);
  }
  const charged = round(list.reduce((a, s) => a + s.total_usd, 0) + platformFixed, 4);
  return { stores: list.sort((a, b) => b.total_usd - a.total_usd), groups: [...groups.values()].sort((a, b) => b.total_usd - a.total_usd),
    platform: { usage: platform, fixed_usd: round(platformFixed, 4) }, totals: { neon_usd: neon.available ? round(neon.total_usd, 4) : null, fixed_usd: round(fixed.reduce((a, it) => a + it.usd, 0), 4), allocated_usd: charged } };
}

export function registerCosts(app, { q, auth, roles, route, bad, valid, z, uuid }) {
  const master = [auth, roles('master')];
  app.get('/api/master/costs', ...master, route(async (req, res) => {
    const now = new Date();
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? String(req.query.month) : new Date(now.getTime() - 3 * 3600000).toISOString().slice(0, 7);
    const { first, next } = monthRange(month);
    const [settings, storesR, usageR, sinceR] = await Promise.all([
      q('SELECT usd_brl,cost_items FROM platform_settings WHERE id=true'),
      q(`SELECT t.id::text id,t.name,t.status,t.billing_group,(SELECT count(*)::int FROM cameras c WHERE c.tenant_id=t.id AND c.deleted_at IS NULL) cameras
         FROM tenants t WHERE t.status IN ('trial','active') OR EXISTS(SELECT 1 FROM tenant_usage_daily u WHERE u.tenant_id=t.id AND u.day>=$1 AND u.day<$2) ORDER BY lower(t.name)`, [first, next]),
      q('SELECT subject,sum(requests)::bigint requests,sum(bytes_out)::bigint bytes_out,sum(db_queries)::bigint db_queries,sum(db_ms) db_ms,sum(active_slots)::bigint active_slots,sum(slot_share) slot_share FROM tenant_usage_daily WHERE day>=$1 AND day<$2 GROUP BY 1', [first, next]),
      q('SELECT min(day) d FROM tenant_usage_daily')]);
    const s = settings.rows[0] || {}, usdBrl = Number(s.usd_brl) || 5.5;
    const [neon, storage] = await Promise.all([neonForMonth(month, now), storageByTenant(q).catch(() => ({ bytes: {}, total: 0 }))]);
    const out = allocate({ stores: storesR.rows, usage: usageR.rows, storage, neon, items: s.cost_items || [], usdBrl });
    res.set('Cache-Control', 'no-store').json({ month, usd_brl: usdBrl, cost_items: s.cost_items || [], neon, measuring_since: sinceR.rows[0]?.d || null, storage_total_bytes: storage.total, ...out });
  }));
  const item = z.object({ name: z.string().trim().min(1).max(60), amount: z.number().min(0).max(1e6), currency: z.enum(['BRL', 'USD']), rule: z.enum(RULES) }).strict();
  app.put('/api/master/costs/settings', ...master, route(async (req, res) => {
    const v = valid(z.object({ usd_brl: z.number().gt(0).lt(100), cost_items: z.array(item).max(30) }).strict(), req, res); if (!v) return;
    const r = await q('UPDATE platform_settings SET usd_brl=$1,cost_items=$2 WHERE id=true RETURNING usd_brl,cost_items', [v.usd_brl, JSON.stringify(v.cost_items)]);
    res.json(r.rows[0]);
  }));
  app.patch('/api/master/tenants/:id/billing-group', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ billing_group: z.string().trim().max(80) }).strict(), req, res); if (!v) return;
    const r = await q('UPDATE tenants SET billing_group=$1 WHERE id=$2 RETURNING id,billing_group', [v.billing_group || null, req.params.id]);
    if (!r.rowCount) return bad(res, 404, 'Loja não encontrada');
    res.json(r.rows[0]);
  }));
}
