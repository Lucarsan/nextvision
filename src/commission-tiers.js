// Comissão por faixa (rede): a maior faixa cujo mínimo foi alcançado define o percentual sobre o total do mês.
export function tierFor(tiers, monthCents) {
  const list = (Array.isArray(tiers) ? tiers : []).filter(t => Number.isFinite(t?.min_cents) && Number.isFinite(t?.percent)).sort((a, b) => a.min_cents - b.min_cents);
  if (!list.length) return null;
  let cur = null, next = null;
  for (const t of list) { if (monthCents >= t.min_cents) cur = t; else { next = t; break; } }
  const pct = cur ? cur.percent : 0;
  return { percent: pct, estimated_cents: Math.round(monthCents * pct / 100), next: next ? { percent: next.percent, min_cents: next.min_cents, missing_cents: next.min_cents - monthCents } : null, tiers: list };
}
export async function tiersForTenant(client, tenantId) {
  const r = await client.query('SELECT n.commission_tiers FROM tenants t JOIN store_networks n ON n.id = t.network_id WHERE t.id = $1', [tenantId]);
  return r.rows[0]?.commission_tiers || [];
}
