// Encerramento automático diário (tenants.auto_close_time, hora de Brasília).
// Para quando a equipe esquece de finalizar: no horário, pedidos que já começaram (em andamento
// ou pausados) viram "concluídos", a gravação da etapa é fechada e a câmera é liberada.
// Pedidos na fila (não começados) ficam para o dia seguinte. Roda uma vez por dia por loja.
import { loyaltyBlock } from './loyalty-rules.js';
const dbModule = () => import('./db.js');
export const STORE_TZ = 'America/Sao_Paulo';

export async function autoCloseTick() {
  const { db } = await dbModule();
  const c = await db.connect(); let closed = 0;
  try {
    await c.query('BEGIN');
    const due = (await c.query(`UPDATE tenants t SET auto_close_last_date=(now() AT TIME ZONE '${STORE_TZ}')::date
      WHERE t.auto_close_time IS NOT NULL AND NOT t.demo_mode AND t.status IN ('trial','active')
        AND (now() AT TIME ZONE '${STORE_TZ}')::time >= t.auto_close_time
        AND (t.auto_close_last_date IS NULL OR t.auto_close_last_date < (now() AT TIME ZONE '${STORE_TZ}')::date)
      RETURNING t.id`)).rows;
    for (const { id } of due) {
      const orders = (await c.query(`SELECT id,customer_id,step_index FROM orders WHERE tenant_id=$1 AND deleted_at IS NULL
        AND (status='live' OR (status='paused' AND started_at IS NOT NULL)) FOR UPDATE`, [id])).rows;
      for (const o of orders) {
        await c.query("UPDATE recordings SET status='finalizing',ended_at=COALESCE(ended_at,now()),updated_at=now() WHERE order_id=$1 AND tenant_id=$2 AND status IN ('pending','recording','paused')", [o.id, id]);
        await c.query("UPDATE orders SET status='completed',completed_at=now(),camera_id=NULL WHERE id=$1", [o.id]);
        if (o.customer_id && !(await loyaltyBlock(c, id, { orderId: o.id }))) await c.query('INSERT INTO loyalty_checkins(tenant_id,customer_id,order_id) VALUES($1,$2,$3) ON CONFLICT(order_id) DO NOTHING', [id, o.customer_id, o.id]);
        await c.query("INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,NULL,'auto_complete','order',$2)", [id, o.id]);
        closed++;
      }
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  return closed;
}

let running = false;
export function startAutoCloseLoop(intervalMs = 60000) {
  const timer = setInterval(async () => {
    if (running) return; running = true;
    try { const n = await autoCloseTick(); if (n) console.log('Encerramento automático:', n, 'pedido(s) finalizado(s)'); }
    catch (e) { console.error('Encerramento automático falhou:', e.code || e.message); } finally { running = false; }
  }, intervalMs);
  timer.unref();
  return timer;
}
