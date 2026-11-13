// Filtros da fidelidade (Alê Pet's, 10/11/2026): "a cada 10 banhos ganha uma hidratação, mas banho em dia de
// promoção (quarta) não conta".
// - loyalty_off_weekdays: dias da semana em que nada conta (0=domingo … 6=sábado), no fuso da loja.
// - loyalty_service_ids: serviços do cadastro que contam. Vazio = qualquer atendimento/compra conta (como antes).
// Devolve o motivo de NÃO contar ('off', 'weekday', 'service') ou null quando conta.
import { weekdayNow } from './store-sales.js';

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Nome do ponto do cartão nas mensagens ("0 de 10 banhos"): quando todos os serviços que contam começam com a
// mesma palavra (ex.: BANHO P, BANHO E TOSA), usa essa palavra; senão, "compra(s)".
export async function loyaltyUnit(c, tenantId) {
  const t = (await c.query('SELECT loyalty_service_ids FROM tenants WHERE id=$1', [tenantId])).rows[0];
  const ids = t?.loyalty_service_ids || [];
  if (ids.length) {
    const names = (await c.query('SELECT name FROM service_catalog WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [tenantId, ids])).rows;
    const first = [...new Set(names.map(r => norm(r.name).split(' ')[0]).filter(Boolean))];
    if (first.length === 1 && /^[a-z]{3,}[aeiou]$/.test(first[0])) return { one: first[0], many: first[0] + 's' };
  }
  return { one: 'compra', many: 'compras' };
}

// at: momento do atendimento (padrão: agora), para o dia da semana.
export async function loyaltyBlock(c, tenantId, { items, orderId, at } = {}) {
  const t = (await c.query('SELECT loyalty_enabled,loyalty_off_weekdays,loyalty_service_ids FROM tenants WHERE id=$1', [tenantId])).rows[0];
  if (!t?.loyalty_enabled) return 'off';
  if ((t.loyalty_off_weekdays || []).map(Number).includes(weekdayNow(at ? new Date(at) : undefined))) return 'weekday';
  const ids = t.loyalty_service_ids || [];
  if (!ids.length) return null;
  const names = (await c.query('SELECT name FROM service_catalog WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [tenantId, ids])).rows.map(r => norm(r.name)).filter(Boolean);
  const idSet = new Set(ids.map(String)), nameSet = new Set(names);
  const hit = list => (list || []).some(x => (x.catalog_id && idSet.has(String(x.catalog_id))) || nameSet.has(norm(x.service || x.name)));
  if (items) return hit(items) ? null : 'service';
  if (!orderId) return 'service';
  // Pedido: serviços das vendas pagas ligadas a ele, das vendas "a receber" e, por último, o texto "serviço" do pedido.
  const sold = await c.query(`SELECT i.catalog_id,i.name FROM sale_items i JOIN sales s ON s.id=i.sale_id
    WHERE s.tenant_id=$1 AND s.order_id=$2 AND s.canceled_at IS NULL`, [tenantId, orderId]);
  if (hit(sold.rows)) return null;
  const pend = await c.query(`SELECT payload->'items' items FROM pending_sales WHERE tenant_id=$1 AND order_id=$2 AND canceled_at IS NULL`, [tenantId, orderId]);
  if (pend.rows.some(r => hit(Array.isArray(r.items) ? r.items : []))) return null;
  const o = (await c.query("SELECT details->>'service' service FROM orders WHERE id=$1 AND tenant_id=$2", [orderId, tenantId])).rows[0];
  const text = norm(o?.service);
  if (text && names.some(n => text.includes(n))) return null;
  return 'service';
}
