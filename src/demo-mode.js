// Modo demonstração (loja marcada pela central com tenants.demo_mode).
// - O link do cliente mostra um vídeo de exemplo em cada etapa (no lugar da câmera).
// - Os pedidos andam sozinhos: começam alguns segundos depois de criados, ficam
//   tenants.demo_step_seconds em cada etapa e, ao concluir, ganham a foto final de exemplo.
// - O operador pode avançar, pausar ou voltar pelo painel a qualquer momento; o relógio
//   recomeça a partir da última ação. Pedido pausado fica parado.
// Nunca ligar numa loja real.
import fs from 'node:fs';
// db.js só é carregado quando o loop roda (as funções puras são testadas sem banco).
const dbModule = () => import('./db.js');

const DEMO_VIDEOS = [
  [/banho|lavag/i, '/demo/pet/banho.mp4'],
  [/secag|seca/i, '/demo/pet/secagem.mp4'],
  [/tosa|finaliza|acabamento|escova/i, '/demo/pet/tosa.mp4']
];
export const START_AFTER_SECONDS = 8;
// Na fila, a demonstração mostra a área de espera e a fila andando antes de começar.
export const DEMO_WAITING_VIDEO = '/demo/pet/espera.mp4';
export const demoWaitSeconds = stepSeconds => Math.max(START_AFTER_SECONDS, Math.round((Number(stepSeconds) || 40) * 0.8));
export const LAST_STEP_SECONDS = 12;

// Vídeo de exemplo para o nome da etapa; etapa sem vídeo (ex.: "Pronto para retirada") → null.
export function demoVideoFor(step) {
  const name = String(step || '');
  for (const [re, url] of DEMO_VIDEOS) if (re.test(name)) return url;
  return null;
}

let finalPhoto = null;
function demoFinalPhoto() {
  if (finalPhoto === null) {
    try { finalPhoto = fs.readFileSync(new URL('../public/demo/pet/final.jpg', import.meta.url)); }
    catch { finalPhoto = false; }
  }
  return finalPhoto || null;
}

// Decide a próxima ação de um pedido da loja demo, ou null para esperar.
// Etapa sem vídeo de exemplo (ex.: "Recepção") também passa rápido.
export function nextDemoAction(o, nowMs = Date.now()) {
  const idle = (nowMs - new Date(o.last_change).getTime()) / 1000;
  if (o.status === 'queued') return idle >= demoWaitSeconds(o.demo_step_seconds) ? 'start' : null;
  if (o.status !== 'live') return null;
  const last = o.step_index >= o.steps_count - 1;
  const short = last || (o.step_name !== undefined && !demoVideoFor(o.step_name));
  if (idle < (short ? LAST_STEP_SECONDS : o.demo_step_seconds)) return null;
  return last ? 'complete' : 'advance';
}

async function apply(o, action) {
  const { db } = await dbModule();
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const cur = (await c.query('SELECT status,step_index FROM orders WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE', [o.id, o.tenant_id])).rows[0];
    // O operador mexeu no meio do caminho: deixa para a próxima rodada.
    if (!cur || cur.status !== o.status || cur.step_index !== o.step_index) { await c.query('ROLLBACK'); return false; }
    if (action === 'start') await c.query("UPDATE orders SET status='live',started_at=COALESCE(started_at,now()),camera_id=NULL WHERE id=$1", [o.id]);
    else if (action === 'advance') await c.query('UPDATE orders SET step_index=step_index+1 WHERE id=$1', [o.id]);
    else if (action === 'complete') {
      await c.query("UPDATE orders SET status='completed',completed_at=now() WHERE id=$1", [o.id]);
      if (o.customer_id) await c.query('INSERT INTO loyalty_checkins(tenant_id,customer_id,order_id) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM tenants WHERE id=$1 AND loyalty_enabled=true) ON CONFLICT(order_id) DO NOTHING', [o.tenant_id, o.customer_id, o.id]);
      const photo = demoFinalPhoto();
      if (photo) await c.query("INSERT INTO order_photos(tenant_id,order_id,mime_type,image_data,kind) SELECT $1,$2,'image/jpeg',$3,'final' WHERE NOT EXISTS(SELECT 1 FROM order_photos WHERE order_id=$2 AND kind='final')", [o.tenant_id, o.id, photo]);
    }
    await c.query("INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,NULL,$2,'order',$3)", [o.tenant_id, 'demo_' + action, o.id]);
    await c.query('COMMIT');
    return true;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

export async function demoTick(nowMs = Date.now()) {
  const { q } = await dbModule();
  const r = await q(`SELECT o.id,o.tenant_id,o.status,o.step_index,o.customer_id,jsonb_array_length(o.process_snapshot->'steps') steps_count,o.process_snapshot->'steps'->>o.step_index step_name,t.demo_step_seconds,
    GREATEST(o.created_at,COALESCE((SELECT max(a.created_at) FROM audit_events a WHERE a.target_type='order' AND a.target_id=o.id::text),o.created_at)) last_change
    FROM orders o JOIN tenants t ON t.id=o.tenant_id
    WHERE t.demo_mode AND t.status IN ('trial','active') AND o.deleted_at IS NULL AND o.status IN ('queued','live')`);
  let moved = 0;
  for (const o of r.rows) { const action = nextDemoAction(o, nowMs); if (action && await apply(o, action)) moved++; }
  return moved;
}

let running = false;
export function startDemoLoop(intervalMs = 4000) {
  const timer = setInterval(async () => {
    if (running) return; running = true;
    try { await demoTick(); } catch (e) { console.error('Modo demonstração falhou:', e.code || e.message); } finally { running = false; }
  }, intervalMs);
  timer.unref();
  return timer;
}

// Pedido-vitrine da loja demo: um link fixo (/demo/<loja>) que mostra o processo inteiro
// e pode recomeçar do zero quantas vezes for preciso. Marcado com a referência "DEMO".
export const SHOWCASE_REF = 'DEMO';
export async function restartShowcase(slug) {
  const { db } = await dbModule();
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const t = (await c.query("SELECT t.id FROM tenant_slugs s JOIN tenants t ON t.id=s.tenant_id WHERE s.slug=$1 AND t.demo_mode AND t.status IN ('trial','active')", [slug])).rows[0];
    if (!t) { await c.query('ROLLBACK'); return null; }
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['nextvision-demo-showcase:' + t.id]);
    let o = (await c.query('SELECT id,share_code FROM orders WHERE tenant_id=$1 AND external_reference=$2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [t.id, SHOWCASE_REF])).rows[0];
    if (!o) {
      // Processo com mais etapas que têm vídeo de exemplo (ex.: "Banho e tosa").
      const procs = (await c.query('SELECT id,steps FROM processes WHERE tenant_id=$1 AND archived_at IS NULL ORDER BY created_at', [t.id])).rows;
      if (!procs.length) { await c.query('ROLLBACK'); return null; }
      const score = p => (p.steps || []).filter(s => demoVideoFor(s)).length * 10 - (p.steps || []).filter(s => !demoVideoFor(s)).length;
      const proc = procs.sort((a, b) => score(b) - score(a))[0];
      let cust = (await c.query("SELECT id FROM customers WHERE tenant_id=$1 AND name='Tutor da demonstração' AND deleted_at IS NULL LIMIT 1", [t.id])).rows[0];
      if (!cust) cust = (await c.query("INSERT INTO customers(tenant_id,name) VALUES($1,'Tutor da demonstração') RETURNING id", [t.id])).rows[0];
      const crypto = await import('node:crypto');
      o = (await c.query("INSERT INTO orders(tenant_id,customer_id,process_id,public_token_hash,external_reference,details) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,share_code",
        [t.id, cust.id, proc.id, crypto.randomBytes(32).toString('hex'), SHOWCASE_REF, JSON.stringify({ item_type: 'pet', pet_name: 'Thor', species: 'Cão', breed: 'Yorkshire', size: 'P', service: 'Banho e tosa' })])).rows[0];
    } else {
      await c.query("UPDATE orders SET status='queued',step_index=0,started_at=NULL,completed_at=NULL,camera_id=NULL WHERE id=$1", [o.id]);
      await c.query("DELETE FROM order_photos WHERE order_id=$1 AND kind='final'", [o.id]);
      await c.query('DELETE FROM loyalty_checkins WHERE order_id=$1 AND redemption_id IS NULL', [o.id]);
    }
    await c.query("INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,NULL,'demo_restart','order',$2)", [t.id, o.id]);
    await c.query('COMMIT');
    return o;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
