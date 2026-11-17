// Cobrança real do Neon (planos pagos): lê a API de consumo v2, que só existe a partir do upgrade
// do plano grátis, e converte para dólares pela tabela do plano. Não acorda o banco.
// Doc: https://neon.com/docs/introduction/usage-calculations
// Preços (Launch) podem ser trocados por variáveis: NEON_CU_HOUR_PRICE, NEON_STORAGE_GB_PRICE.
const BASE = 'https://console.neon.tech/api/v2';
const METRICS = ['compute_unit_seconds', 'root_branch_bytes_month', 'child_branch_bytes_month', 'instant_restore_bytes_month', 'public_network_transfer_bytes'];
const DAY = 86400000;
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export function neonPrices(e = process.env) {
  return {
    cu_hour: Number(e.NEON_CU_HOUR_PRICE) || 0.106,
    storage_gb_month: Number(e.NEON_STORAGE_GB_PRICE) || 0.35,
    restore_gb_month: 0.20,
    transfer_gb: 0.10, transfer_free_gb: 500
  };
}

// Custo de uma lista de métricas (valores brutos da API) com a tabela de preços.
export function costOf(m, price = neonPrices()) {
  const cuH = (m.compute_unit_seconds || 0) / 3600;
  const storageGbMo = ((m.root_branch_bytes_month || 0) + (m.child_branch_bytes_month || 0)) / 1e9;
  const restoreGbMo = (m.instant_restore_bytes_month || 0) / 1e9;
  const compute = cuH * price.cu_hour, storage = storageGbMo * price.storage_gb_month + restoreGbMo * price.restore_gb_month;
  return { cu_hours: round(cuH, 3), storage_gb_month: round(storageGbMo + restoreGbMo, 4), transfer_gb: round((m.public_network_transfer_bytes || 0) / 1e9, 3),
    compute_usd: round(compute), storage_usd: round(storage), total_usd: round(compute + storage) };
}

async function getJson(url, key) {
  const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  if (!r.ok) { const err = Error('HTTP ' + r.status + (json?.message ? ' — ' + String(json.message).slice(0, 160) : '')); err.status = r.status; throw err; }
  return json;
}

// Junta a resposta da API (projetos → períodos → dias → métricas) em totais por projeto e por dia.
// Períodos do plano grátis não são cobrados e ficam de fora do custo.
export function summarize(projects, price = neonPrices()) {
  const out = { plan: null, billing_since: null, projects: [], days: {} };
  for (const p of projects || []) {
    const sum = {}, days = {};
    for (const per of p.periods || []) {
      if (per.period_plan && per.period_plan !== 'free') {
        out.plan = per.period_plan;
        if (per.period_start && (!out.billing_since || per.period_start < out.billing_since)) out.billing_since = per.period_start;
      } else continue;
      for (const c of per.consumption || []) {
        const day = String(c.timeframe_start).slice(0, 10), dm = days[day] || (days[day] = {});
        for (const x of c.metrics || []) { sum[x.metric_name] = (sum[x.metric_name] || 0) + Number(x.value || 0); dm[x.metric_name] = (dm[x.metric_name] || 0) + Number(x.value || 0); }
      }
    }
    const cost = costOf(sum, price);
    // Franquia de 500 GB de transferência por projeto: acima disso, US$ 0,10/GB.
    const transfer = Math.max(0, cost.transfer_gb - price.transfer_free_gb) * price.transfer_gb;
    cost.transfer_usd = round(transfer); cost.total_usd = round(cost.total_usd + transfer);
    out.projects.push({ id: p.project_id, ...cost, daily: Object.fromEntries(Object.entries(days).map(([d, m]) => [d, costOf(m, price)])) });
  }
  out.total_usd = round(out.projects.reduce((s, p) => s + p.total_usd, 0));
  return out;
}

const cache = new Map();
// Consumo cobrado entre from e to (datas UTC). Guarda por 30 min para não estourar o limite da API.
export async function neonBilling({ orgId, from, to, key = process.env.NEON_API_KEY, now = new Date(), maxAgeMs = 30 * 60000 } = {}) {
  if (!key) throw Error('falta NEON_API_KEY');
  if (!orgId) throw Error('organização do Neon não identificada');
  const f = new Date(from), t = new Date(to);
  const ck = orgId + '|' + f.toISOString().slice(0, 10) + '|' + t.toISOString().slice(0, 10);
  const hit = cache.get(ck);
  if (hit && now - hit.at < maxAgeMs) return hit.data;
  const url = BASE + '/consumption_history/v2/projects?org_id=' + encodeURIComponent(orgId) + '&from=' + f.toISOString().slice(0, 10) + 'T00:00:00Z&to=' + t.toISOString().slice(0, 10) + 'T00:00:00Z&granularity=daily&limit=100&metrics=' + METRICS.join(',');
  const j = await getJson(url, key);
  const data = summarize(j?.projects || [], neonPrices());
  // Nomes dos projetos (para a central mostrar "nextvision", "radar-licitacoes"…).
  try {
    const names = (await getJson(BASE + '/projects?limit=100&org_id=' + encodeURIComponent(orgId), key))?.projects || [];
    const byId = Object.fromEntries(names.map(p => [p.id, p.name]));
    for (const p of data.projects) p.name = byId[p.id] || p.id;
  } catch { for (const p of data.projects) p.name = p.id; }
  cache.set(ck, { at: now.getTime(), data });
  return data;
}

// Mês corrente (UTC) até amanhã 00:00, com previsão linear pelo ritmo desde o início da cobrança.
export async function neonMonthBilling({ orgId, projectId, now = new Date(), key } = {}) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const to = new Date(Math.min(end.getTime(), Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)));
  const b = await neonBilling({ orgId, from: start, to, key, now });
  if (!b.plan) return { plan: 'free', paid: false };
  const since = new Date(Math.max(start.getTime(), new Date(b.billing_since).getTime()));
  const elapsed = Math.max(3600000, now - since), remaining = Math.max(0, end - now);
  const proj = p => round(p.total_usd + p.total_usd / elapsed * remaining, 2);
  const mine = b.projects.find(p => p.id === projectId) || null;
  return {
    plan: b.plan, paid: true, billing_since: b.billing_since, period_end: end.toISOString(),
    cost_usd: round(b.total_usd, 2), projected_usd: round(b.projects.reduce((s, p) => s + proj(p), 0), 2),
    project: mine ? { id: mine.id, name: mine.name, cost_usd: round(mine.total_usd, 2), projected_usd: proj(mine), cu_hours: mine.cu_hours, compute_usd: round(mine.compute_usd, 2), storage_usd: round(mine.storage_usd, 2) } : null,
    projects: b.projects.map(p => ({ id: p.id, name: p.name, cost_usd: round(p.total_usd, 2), projected_usd: proj(p), cu_hours: p.cu_hours }))
  };
}
export const _test = { DAY };
