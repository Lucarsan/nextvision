// Senha do admin da loja e preços em lote.
// - A senha é a mesma da página "Valor do estoque" (STOCK_VALUE_LOGIN / STOCK_VALUE_PASSWORD_HASH no Render).
//   Quem digita recebe uma liberação de 15 minutos, presa à loja e ao usuário logado.
// - Pedem a senha: editar ou excluir produto já cadastrado, reajuste de preços em lote e preço por época do mês.
// - Reajuste em lote: sobe (ou desce) N% de todos os produtos ou dos escolhidos; fica registrado e pode ser desfeito.
// - Preço por época do mês: entre os dias X e Y, os produtos escolhidos mudam N%; fora do período o preço volta.
//   O sistema confere as regras ao abrir o caixa, ao buscar produtos e antes de cada venda (no máximo uma vez a cada
//   5 minutos por loja, ou logo depois de mexer nas regras).
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

const TZ = process.env.STORE_TIMEZONE || 'America/Fortaleza';
const ADMIN_MINUTES = 15;
const sameText = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

export async function checkAdminPassword(login, password) {
  const name = process.env.STOCK_VALUE_LOGIN || 'admin', hash = process.env.STOCK_VALUE_PASSWORD_HASH || '';
  if (!hash) return { ok: false, status: 503, error: 'A senha do admin ainda não foi configurada.' };
  const okLogin = sameText(String(login || '').trim().toLowerCase(), name.toLowerCase());
  const okPass = await bcrypt.compare(String(password || ''), hash);
  return okLogin && okPass ? { ok: true } : { ok: false, status: 401, error: 'Login ou senha do admin incorretos.' };
}

// Arredonda o preço novo: 'none' (centavos), '0.10', '0.50' ou '1.00' (para o múltiplo mais próximo).
export function newPrice(cents, percent, rounding = 'none') {
  const raw = cents * (1 + Number(percent) / 100);
  const step = { none: 1, '0.10': 10, '0.50': 50, '1.00': 100 }[rounding] || 1;
  return Math.max(0, Math.min(100000000, Math.round(raw / step) * step));
}
// Dia dentro do período do mês. "25 a 5" atravessa a virada do mês. Dia 31 vale como último dia em meses menores.
export function inWindow(day, lastDay, from, to) {
  const f = Math.min(from, lastDay), t = Math.min(to, lastDay);
  return f <= t ? day >= f && day <= t : day >= f || day <= t;
}

export function registerStoreAdmin(app, { q, db, route, bad, valid, audit, guard, tid, uuid }) {
  const secret = process.env.JWT_SECRET;
  const attempts = rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Muitas tentativas. Tente de novo em 15 minutos.' } });

  app.post('/api/store/admin/unlock', ...guard, attempts, route(async (req, res) => {
    const v = valid(z.object({ login: z.string().max(100), password: z.string().max(200) }).strict(), req, res); if (!v) return;
    const r = await checkAdminPassword(v.login, v.password);
    if (!r.ok) { await audit(req, 'denied', 'store_admin', tid(req)); return bad(res, r.status, r.error); }
    const token = jwt.sign({ adm: 1, t: tid(req), u: req.user.id }, secret, { algorithm: 'HS256', expiresIn: ADMIN_MINUTES * 60 });
    await audit(req, 'unlock', 'store_admin', tid(req));
    res.set('Cache-Control', 'no-store');
    res.json({ admin_token: token, expires_at: new Date(Date.now() + ADMIN_MINUTES * 60000).toISOString() });
  }));
  // Rotas que pedem a senha do admin: cabeçalho X-Admin-Token com a liberação recebida acima.
  const adminOnly = (req, res, next) => {
    try {
      const p = jwt.verify(String(req.get('x-admin-token') || ''), secret, { algorithms: ['HS256'] });
      if (p.adm === 1 && p.t === tid(req) && p.u === req.user.id) return next();
    } catch { /* cai no aviso abaixo */ }
    res.status(401).json({ error: 'Esta ação pede a senha do admin.', admin_required: true });
  };

  // ---------- Preço por época do mês ----------
  const lastSync = new Map(); // tenant -> horário da última conferência
  async function syncPriceRules(tenant, force = false) {
    const now = Date.now();
    if (!force && now - (lastSync.get(tenant) || 0) < 5 * 60000) return;
    lastSync.set(tenant, now);
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fp-price-rules:'||$1))", [tenant]);
      const d = (await c.query(`SELECT extract(day FROM (now() AT TIME ZONE $1))::int today_d,
          extract(day FROM (date_trunc('month', now() AT TIME ZONE $1) + interval '1 month - 1 day'))::int last_d`, [TZ])).rows[0];
      const rules = (await c.query('SELECT id,percent,rounding,day_from,day_to,product_ids FROM price_rules WHERE tenant_id=$1 AND deleted_at IS NULL AND active ORDER BY created_at', [tenant])).rows
        .filter(r => inWindow(d.today_d, d.last_d, r.day_from, r.day_to));
      const want = new Map(); // product -> regra (a mais antiga ganha)
      for (const r of rules) for (const p of r.product_ids) if (!want.has(p)) want.set(p, r);
      const applied = (await c.query('SELECT product_id,rule_id,base_cents,applied_cents FROM price_rule_applied WHERE tenant_id=$1', [tenant])).rows;
      // Voltar ao preço normal: regra acabou, foi desligada ou mudou. Se alguém mudou o preço na mão no meio, fica o da mão.
      for (const a of applied) {
        const r = want.get(a.product_id);
        if (r && r.id === a.rule_id && newPrice(a.base_cents, r.percent, r.rounding) === a.applied_cents) { want.delete(a.product_id); continue; }
        await c.query('UPDATE products SET price_cents=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3 AND price_cents=$4', [a.base_cents, a.product_id, tenant, a.applied_cents]);
        await c.query('DELETE FROM price_rule_applied WHERE product_id=$1', [a.product_id]);
      }
      for (const [pid, r] of want) {
        const p = (await c.query("SELECT price_cents FROM products WHERE id=$1 AND tenant_id=$2 AND active AND kind='product'", [pid, tenant])).rows[0];
        if (!p) continue;
        const price = newPrice(p.price_cents, r.percent, r.rounding);
        await c.query('UPDATE products SET price_cents=$1,updated_at=now() WHERE id=$2', [price, pid]);
        await c.query('INSERT INTO price_rule_applied(product_id,rule_id,tenant_id,base_cents,applied_cents) VALUES($1,$2,$3,$4,$5)', [pid, r.id, tenant, p.price_cents, price]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); lastSync.delete(tenant); throw e; } finally { c.release(); }
  }
  // Confere as regras antes das rotas que leem preço (caixa, busca, leitor, venda). Erro aqui não trava a venda.
  const pricesFresh = async (req, res, next) => { try { await syncPriceRules(tid(req)); } catch (e) { console.error('price rules sync failed', e.code || e.name); } next(); };
  for (const path of ['/api/store/cash', '/api/store/products', '/api/store/products/barcode/:code', '/api/store/sales/quick-items']) app.get(path, ...guard, pricesFresh);
  app.post('/api/store/sales', ...guard, pricesFresh);

  const pct = z.number().min(-90).max(500).refine(n => n !== 0, 'Informe o percentual');
  const rounding = z.enum(['none', '0.10', '0.50', '1.00']).default('none');

  // ---------- Reajuste em lote ----------
  // preview=true só calcula (para mostrar antes de confirmar). Produto com preço de época ativo: muda o preço normal
  // (o de época é recalculado em seguida).
  app.post('/api/store/products/reprice', ...guard, adminOnly, route(async (req, res) => {
    const v = valid(z.object({ percent: pct, rounding, scope: z.enum(['all', 'selected']), product_ids: z.array(uuid).max(2000).optional(), preview: z.boolean().default(false), note: z.string().trim().max(200).optional() }).strict(), req, res); if (!v) return;
    if (v.scope === 'selected' && !v.product_ids?.length) return bad(res, 400, 'Escolha os produtos');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fp-price-rules:'||$1))", [tid(req)]);
      const rows = (await c.query(`SELECT p.id,p.name,p.price_cents,a.base_cents,a.applied_cents,a.rule_id FROM products p LEFT JOIN price_rule_applied a ON a.product_id=p.id
        WHERE p.tenant_id=$1 AND p.active AND p.kind='product' AND p.price_cents>0 AND ($2='all' OR p.id=ANY($3::uuid[])) ORDER BY p.name FOR UPDATE OF p`, [tid(req), v.scope, v.product_ids || []])).rows;
      if (!rows.length) { await c.query('ROLLBACK'); return bad(res, 400, 'Nenhum produto com preço para reajustar'); }
      const items = rows.map(r => { const base = r.base_cents ?? r.price_cents; return { id: r.id, name: r.name, old_cents: base, new_cents: newPrice(base, v.percent, v.rounding), seasonal: !!r.rule_id }; });
      if (v.preview) { await c.query('ROLLBACK'); return res.json({ preview: true, count: items.length, items: items.slice(0, 500) }); }
      const b = (await c.query('INSERT INTO price_batches(tenant_id,percent,rounding,scope,products_count,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [tid(req), v.percent, v.rounding, v.scope, items.length, v.note || null, req.user.id])).rows[0];
      for (const it of items) {
        await c.query('INSERT INTO price_batch_items(batch_id,product_id,old_cents,new_cents) VALUES($1,$2,$3,$4)', [b.id, it.id, it.old_cents, it.new_cents]);
        if (it.seasonal) await c.query('UPDATE price_rule_applied SET base_cents=$1 WHERE product_id=$2', [it.new_cents, it.id]);
        else await c.query('UPDATE products SET price_cents=$1,updated_at=now() WHERE id=$2', [it.new_cents, it.id]);
      }
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'reprice', 'price_batch', b.id]);
      await c.query('COMMIT');
      await syncPriceRules(tid(req), true).catch(() => {});
      res.status(201).json({ batch: b, count: items.length, items: items.slice(0, 500) });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));
  app.get('/api/store/price-batches', ...guard, route(async (req, res) => {
    const r = await q(`SELECT b.id,b.percent::float percent,b.rounding,b.scope,b.products_count,b.note,b.created_at,b.undone_at,u.name created_by_name,uu.name undone_by_name
      FROM price_batches b LEFT JOIN users u ON u.id=b.created_by LEFT JOIN users uu ON uu.id=b.undone_by WHERE b.tenant_id=$1 ORDER BY b.created_at DESC LIMIT 30`, [tid(req)]);
    res.set('Cache-Control', 'no-store'); res.json(r.rows);
  }));
  // Desfazer: volta ao preço anterior só os produtos que ainda estão com o preço do reajuste (os mudados depois ficam).
  app.post('/api/store/price-batches/:id/undo', ...guard, adminOnly, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Reajuste inválido');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fp-price-rules:'||$1))", [tid(req)]);
      const b = (await c.query('SELECT id FROM price_batches WHERE id=$1 AND tenant_id=$2 AND undone_at IS NULL FOR UPDATE', [req.params.id, tid(req)])).rows[0];
      if (!b) { await c.query('ROLLBACK'); return bad(res, 409, 'Reajuste não encontrado ou já desfeito'); }
      const a = await c.query(`UPDATE price_rule_applied a SET base_cents=i.old_cents FROM price_batch_items i WHERE i.batch_id=$1 AND a.product_id=i.product_id AND a.base_cents=i.new_cents RETURNING a.product_id`, [b.id]);
      const p = await c.query(`UPDATE products p SET price_cents=i.old_cents,updated_at=now() FROM price_batch_items i
        WHERE i.batch_id=$1 AND p.id=i.product_id AND p.tenant_id=$2 AND p.price_cents=i.new_cents AND NOT EXISTS (SELECT 1 FROM price_rule_applied a WHERE a.product_id=p.id) RETURNING p.id`, [b.id, tid(req)]);
      await c.query('UPDATE price_batches SET undone_at=now(),undone_by=$1 WHERE id=$2', [req.user.id, b.id]);
      await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)', [tid(req), req.user.id, 'undo', 'price_batch', b.id]);
      await c.query('COMMIT');
      await syncPriceRules(tid(req), true).catch(() => {});
      res.json({ undone: true, restored: a.rowCount + p.rowCount });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }));

  // ---------- Regras por época do mês ----------
  const ruleBody = z.object({ name: z.string().trim().min(1).max(80), percent: pct, rounding, day_from: z.number().int().min(1).max(31), day_to: z.number().int().min(1).max(31),
    product_ids: z.array(uuid).min(1).max(2000), active: z.boolean().default(true) }).strict();
  const ruleFields = `r.id,r.name,r.percent::float percent,r.rounding,r.day_from,r.day_to,r.product_ids,r.active,r.created_at,
    (SELECT coalesce(json_agg(json_build_object('id',p.id,'name',p.name,'price_cents',p.price_cents,'base_cents',a.base_cents,'applied',a.rule_id=r.id) ORDER BY p.name),'[]'::json)
       FROM products p LEFT JOIN price_rule_applied a ON a.product_id=p.id WHERE p.id=ANY(r.product_ids) AND p.active) products`;
  app.get('/api/store/price-rules', ...guard, route(async (req, res) => {
    await syncPriceRules(tid(req)).catch(() => {});
    const r = await q(`SELECT ${ruleFields} FROM price_rules r WHERE r.tenant_id=$1 AND r.deleted_at IS NULL ORDER BY r.day_from,r.name`, [tid(req)]);
    const d = (await q(`SELECT extract(day FROM (now() AT TIME ZONE $1))::int today_d,extract(day FROM (date_trunc('month', now() AT TIME ZONE $1) + interval '1 month - 1 day'))::int last_d`, [TZ])).rows[0];
    res.set('Cache-Control', 'no-store'); res.json({ today: d.today_d, rules: r.rows.map(x => ({ ...x, in_window: inWindow(d.today_d, d.last_d, x.day_from, x.day_to) })) });
  }));
  const checkProducts = async (req, ids) => (await q("SELECT count(*)::int n FROM products WHERE tenant_id=$1 AND active AND kind='product' AND id=ANY($2::uuid[])", [tid(req), ids])).rows[0].n === new Set(ids).size;
  app.post('/api/store/price-rules', ...guard, adminOnly, route(async (req, res) => {
    const v = valid(ruleBody, req, res); if (!v) return;
    if (!(await checkProducts(req, v.product_ids))) return bad(res, 400, 'Produto não encontrado. Atualize a lista.');
    const r = await q(`INSERT INTO price_rules(tenant_id,name,percent,rounding,day_from,day_to,product_ids,active,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [tid(req), v.name, v.percent, v.rounding, v.day_from, v.day_to, [...new Set(v.product_ids)], v.active, req.user.id]);
    await audit(req, 'create', 'price_rule', r.rows[0].id); await syncPriceRules(tid(req), true);
    res.status(201).json((await q(`SELECT ${ruleFields} FROM price_rules r WHERE r.id=$1`, [r.rows[0].id])).rows[0]);
  }));
  app.patch('/api/store/price-rules/:id', ...guard, adminOnly, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Regra inválida');
    const v = valid(ruleBody.partial().strict(), req, res); if (!v) return;
    if (v.product_ids && !(await checkProducts(req, v.product_ids))) return bad(res, 400, 'Produto não encontrado. Atualize a lista.');
    const r = await q(`UPDATE price_rules SET name=COALESCE($3,name),percent=COALESCE($4,percent),rounding=COALESCE($5,rounding),day_from=COALESCE($6,day_from),day_to=COALESCE($7,day_to),
        product_ids=COALESCE($8,product_ids),active=COALESCE($9,active) WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL RETURNING id`,
      [req.params.id, tid(req), v.name ?? null, v.percent ?? null, v.rounding ?? null, v.day_from ?? null, v.day_to ?? null, v.product_ids ? [...new Set(v.product_ids)] : null, v.active ?? null]);
    if (!r.rowCount) return bad(res, 404, 'Regra não encontrada');
    await audit(req, 'update', 'price_rule', req.params.id); await syncPriceRules(tid(req), true);
    res.json((await q(`SELECT ${ruleFields} FROM price_rules r WHERE r.id=$1`, [req.params.id])).rows[0]);
  }));
  app.delete('/api/store/price-rules/:id', ...guard, adminOnly, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Regra inválida');
    const r = await q('UPDATE price_rules SET deleted_at=now(),active=false WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL RETURNING id', [req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'Regra não encontrada');
    await audit(req, 'delete', 'price_rule', req.params.id); await syncPriceRules(tid(req), true);
    res.json({ deleted: true });
  }));

  return { adminOnly, syncPriceRules };
}
