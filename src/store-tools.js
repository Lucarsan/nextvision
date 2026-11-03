// Links úteis da loja (menu "Links úteis" e atalhos do topo do painel).
// - Links: acessos rápidos do operador (sites de fornecedores, sistemas, consultas), com categorias, fixados e contagem de cliques.
// - Dívidas: uma lista por pessoa que deve à loja (o que levou, quando, valor e quanto já pagou).
// - Recibos: os dados do emissor e a logo ficam guardados na loja; o recibo em si é montado e impresso no navegador.
// - Atalhos: botões do topo do painel (padrão: Caixa, Links úteis, Mensagens), iguais para todos os computadores da loja.
// Liga junto com "Caixa e mensagens" (tenants.sales_enabled).
import crypto from 'node:crypto';
import { z } from 'zod';

const VIEWS = ['cash', 'links', 'messages', 'stock', 'orders', 'new_order', 'customers', 'queues', 'processes', 'cameras', 'settings', 'plan', 'support', 'home'];
export const DEFAULT_SHORTCUTS = [{ type: 'view', view: 'cash' }, { type: 'view', view: 'links' }, { type: 'view', view: 'messages' }];
const MAX_SHORTCUTS = 8;
const cents = z.number().int().min(0).max(100000000);
const text = n => z.string().trim().max(n);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
// Só http(s): nada de javascript:, data: etc. "site.com.br" vira https://site.com.br.
export function cleanUrl(v) {
  let s = String(v || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try { const u = new URL(s); if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) return null; return u.toString(); } catch { return null; }
}
const urlField = z.string().max(2000).transform((v, ctx) => { const u = cleanUrl(v); if (!u) { ctx.addIssue({ code: 'custom', message: 'Endereço inválido' }); return z.NEVER; } return u; });
// Comparação de duplicados: sem protocolo, sem "www.", sem barra no fim, sem maiúsculas.
export const urlKey = u => String(u || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/#?]+$/, '');
const categories = z.array(text(40).min(1)).max(12).transform(a => [...new Set(a)]);

const linkBody = z.object({ name: text(120).min(1), url: urlField, categories: categories.optional(), keywords: text(300).optional(), pinned: z.boolean().optional() }).strict();
const debtorBody = z.object({ name: text(120).min(1), phone: text(30).optional() }).strict();
const itemBody = z.object({ who: text(120).optional(), description: text(300).optional(), day: day.optional(), amount_cents: cents.optional(), paid_cents: cents.optional(), done: z.boolean().optional() }).strict();
const shortcut = z.discriminatedUnion('type', [
  z.object({ type: z.literal('view'), view: z.enum(VIEWS) }).strict(),
  z.object({ type: z.literal('link'), link_id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('url'), label: text(40).min(1), url: urlField }).strict()
]);
const LOGO = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const issuerBody = z.object({
  name: text(120).optional(), doc: text(20).optional(), phone: text(20).optional(), city: text(80).optional(),
  logo: z.string().max(360000).refine(v => v === '' || LOGO.test(v), 'Logo inválida').optional()
}).strict();

export function registerStoreTools(app, { q, db, auth, roles, route, bad, valid, audit }) {
  const tid = req => req.user.tenant_id;
  const enabled = route(async (req, res, next) => {
    const r = await q('SELECT sales_enabled FROM tenants WHERE id=$1', [tid(req)]);
    if (!r.rows[0]?.sales_enabled) return bad(res, 403, 'Links úteis não estão habilitados para esta loja');
    next();
  });
  const guard = [auth, roles('owner', 'operator'), enabled];
  // Operador novato pode consultar, anotar e marcar pagamento, mas não apaga nem importa.
  const full = [...guard, (req, res, next) => req.user.access_level === 'basic' ? bad(res, 403, 'Seu acesso (operador novato) não permite apagar. Peça a um operador livre ou ao dono.') : next()];
  const id = () => crypto.randomUUID();
  const isId = v => z.string().uuid().safeParse(v).success;
  const linkCols = 'id,name,url,categories,keywords,pinned,position,clicks,last_opened_at,created_at';

  // ---------- Atalhos do topo e emissor do recibo ----------
  app.get('/api/store/tools/settings', ...guard, route(async (req, res) => {
    const t = (await q('SELECT quick_shortcuts,receipt_issuer FROM tenants WHERE id=$1', [tid(req)])).rows[0];
    res.json({ shortcuts: t.quick_shortcuts || DEFAULT_SHORTCUTS, receipt_issuer: t.receipt_issuer || {} });
  }));
  app.put('/api/store/tools/shortcuts', ...guard, route(async (req, res) => {
    const v = valid(z.object({ shortcuts: z.array(shortcut).max(MAX_SHORTCUTS) }).strict(), req, res); if (!v) return;
    const links = v.shortcuts.filter(s => s.type === 'link').map(s => s.link_id);
    if (links.length) {
      const ok = await q('SELECT count(*)::int n FROM store_links WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [tid(req), [...new Set(links)]]);
      if (ok.rows[0].n !== new Set(links).size) return bad(res, 404, 'Link não encontrado');
    }
    await q('UPDATE tenants SET quick_shortcuts=$2 WHERE id=$1', [tid(req), JSON.stringify(v.shortcuts)]);
    res.json({ shortcuts: v.shortcuts });
  }));
  app.put('/api/store/tools/receipt-issuer', ...guard, route(async (req, res) => {
    const v = valid(issuerBody, req, res); if (!v) return;
    const r = await q("UPDATE tenants SET receipt_issuer=COALESCE(receipt_issuer,'{}'::jsonb)||$2::jsonb WHERE id=$1 RETURNING receipt_issuer", [tid(req), JSON.stringify(v)]);
    res.json(r.rows[0].receipt_issuer);
  }));

  // ---------- Links ----------
  app.get('/api/store/tools/links', ...guard, route(async (req, res) => {
    res.json((await q(`SELECT ${linkCols} FROM store_links WHERE tenant_id=$1 ORDER BY position,created_at`, [tid(req)])).rows);
  }));
  app.post('/api/store/tools/links', ...guard, route(async (req, res) => {
    const v = valid(linkBody, req, res); if (!v) return;
    const all = (await q('SELECT url FROM store_links WHERE tenant_id=$1', [tid(req)])).rows;
    if (all.some(l => urlKey(l.url) === urlKey(v.url)) && req.query.allow_duplicate !== '1') return bad(res, 409, 'Este link já está cadastrado');
    const r = await q(`INSERT INTO store_links(id,tenant_id,name,url,categories,keywords,pinned,position)
      VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE((SELECT max(position)+1 FROM store_links WHERE tenant_id=$2),0)) RETURNING ${linkCols}`,
      [id(), tid(req), v.name, v.url, v.categories || [], v.keywords || '', !!v.pinned]);
    res.status(201).json(r.rows[0]);
  }));
  app.patch('/api/store/tools/links/:id', ...guard, route(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, 404, 'Link não encontrado');
    const v = valid(linkBody.partial(), req, res); if (!v) return;
    const r = await q(`UPDATE store_links SET name=COALESCE($3,name),url=COALESCE($4,url),categories=COALESCE($5,categories),keywords=COALESCE($6,keywords),pinned=COALESCE($7,pinned),updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING ${linkCols}`, [tid(req), req.params.id, v.name ?? null, v.url ?? null, v.categories ?? null, v.keywords ?? null, v.pinned ?? null]);
    if (!r.rowCount) return bad(res, 404, 'Link não encontrado');
    res.json(r.rows[0]);
  }));
  app.post('/api/store/tools/links/:id/open', ...guard, route(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, 404, 'Link não encontrado');
    const r = await q('UPDATE store_links SET clicks=clicks+1,last_opened_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING clicks,last_opened_at', [tid(req), req.params.id]);
    if (!r.rowCount) return bad(res, 404, 'Link não encontrado');
    res.json(r.rows[0]);
  }));
  app.delete('/api/store/tools/links/:id', ...full, route(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, 404, 'Link não encontrado');
    const r = await q('DELETE FROM store_links WHERE tenant_id=$1 AND id=$2', [tid(req), req.params.id]);
    if (!r.rowCount) return bad(res, 404, 'Link não encontrado');
    // Some também dos atalhos do topo.
    await q(`UPDATE tenants SET quick_shortcuts=(SELECT COALESCE(jsonb_agg(s),'[]'::jsonb) FROM jsonb_array_elements(quick_shortcuts) s WHERE s->>'link_id' IS DISTINCT FROM $2)
      WHERE id=$1 AND quick_shortcuts IS NOT NULL`, [tid(req), req.params.id]);
    await audit(req, 'store_link.delete', 'store_link', req.params.id);
    res.json({ ok: true });
  }));
  // Ordem manual (arrastar): recebe todos os ids na ordem nova.
  const reorder = table => route(async (req, res) => {
    const v = valid(z.object({ ids: z.array(z.string().uuid()).max(2000) }).strict(), req, res); if (!v) return;
    await q(`UPDATE ${table} t SET position=o.n FROM unnest($2::uuid[]) WITH ORDINALITY o(id,n) WHERE t.tenant_id=$1 AND t.id=o.id`, [tid(req), v.ids]);
    res.json({ ok: true });
  });
  app.put('/api/store/tools/links/order', ...guard, reorder('store_links'));

  // ---------- Dívidas ----------
  const itemCols = 'id,debtor_id,who,description,to_char(day,\'YYYY-MM-DD\') AS day,amount_cents,paid_cents,done,position';
  async function debtors(tenant, only) {
    const people = (await q(`SELECT id,name,phone,position,created_at,updated_at FROM store_debtors WHERE tenant_id=$1 ${only ? 'AND id=$2' : ''} ORDER BY position,created_at`, only ? [tenant, only] : [tenant])).rows;
    const items = (await q(`SELECT ${itemCols} FROM store_debt_items WHERE tenant_id=$1 ${only ? 'AND debtor_id=$2' : ''} ORDER BY position,created_at`, only ? [tenant, only] : [tenant])).rows;
    const by = new Map(people.map(p => [p.id, Object.assign(p, { items: [] })]));
    for (const i of items) by.get(i.debtor_id)?.items.push(i);
    for (const p of people) {
      const total = p.items.reduce((a, i) => a + i.amount_cents, 0), paid = p.items.reduce((a, i) => a + i.paid_cents, 0);
      Object.assign(p, { total_cents: total, paid_cents: paid, balance_cents: total - paid, open_items: p.items.filter(i => i.amount_cents - i.paid_cents > 0).length });
    }
    return people;
  }
  const one = async (req, res, debtorId) => { const p = (await debtors(tid(req), debtorId))[0]; if (!p) return bad(res, 404, 'Lista não encontrada'); res.json(p); };
  app.get('/api/store/tools/debts', ...guard, route(async (req, res) => res.json(await debtors(tid(req)))));
  app.post('/api/store/tools/debts', ...guard, route(async (req, res) => {
    const v = valid(debtorBody, req, res); if (!v) return;
    const nid = id();
    await q(`INSERT INTO store_debtors(id,tenant_id,name,phone,position) VALUES($1,$2,$3,$4,COALESCE((SELECT min(position)-1 FROM store_debtors WHERE tenant_id=$2),0))`, [nid, tid(req), v.name, v.phone || '']);
    res.status(201); return one(req, res, nid);
  }));
  app.patch('/api/store/tools/debts/:id', ...guard, route(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, 404, 'Lista não encontrada');
    const v = valid(debtorBody.partial(), req, res); if (!v) return;
    const r = await q('UPDATE store_debtors SET name=COALESCE($3,name),phone=COALESCE($4,phone),updated_at=now() WHERE tenant_id=$1 AND id=$2', [tid(req), req.params.id, v.name ?? null, v.phone ?? null]);
    if (!r.rowCount) return bad(res, 404, 'Lista não encontrada');
    return one(req, res, req.params.id);
  }));
  app.delete('/api/store/tools/debts/:id', ...full, route(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, 404, 'Lista não encontrada');
    const r = await q('DELETE FROM store_debtors WHERE tenant_id=$1 AND id=$2', [tid(req), req.params.id]);
    if (!r.rowCount) return bad(res, 404, 'Lista não encontrada');
    await audit(req, 'store_debt.delete', 'store_debtor', req.params.id);
    res.json({ ok: true });
  }));
  // Limpar a lista (apaga os itens, mantém a pessoa).
  app.post('/api/store/tools/debts/:id/clear', ...full, route(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, 404, 'Lista não encontrada');
    const r = await q('SELECT 1 FROM store_debtors WHERE tenant_id=$1 AND id=$2', [tid(req), req.params.id]);
    if (!r.rowCount) return bad(res, 404, 'Lista não encontrada');
    await q('DELETE FROM store_debt_items WHERE tenant_id=$1 AND debtor_id=$2', [tid(req), req.params.id]);
    await q('UPDATE store_debtors SET updated_at=now() WHERE id=$1', [req.params.id]);
    await audit(req, 'store_debt.clear', 'store_debtor', req.params.id);
    return one(req, res, req.params.id);
  }));
  app.put('/api/store/tools/debts/order', ...guard, reorder('store_debtors'));
  app.post('/api/store/tools/debts/:id/items', ...guard, route(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, 404, 'Lista não encontrada');
    const v = valid(itemBody, req, res); if (!v) return;
    const r = await q('SELECT 1 FROM store_debtors WHERE tenant_id=$1 AND id=$2', [tid(req), req.params.id]);
    if (!r.rowCount) return bad(res, 404, 'Lista não encontrada');
    const row = await q(`INSERT INTO store_debt_items(id,tenant_id,debtor_id,who,description,day,amount_cents,paid_cents,done,position)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE((SELECT max(position)+1 FROM store_debt_items WHERE debtor_id=$3),0)) RETURNING ${itemCols}`,
      [id(), tid(req), req.params.id, v.who || '', v.description || '', v.day || null, v.amount_cents || 0, v.paid_cents || 0, !!v.done]);
    await q('UPDATE store_debtors SET updated_at=now() WHERE id=$1', [req.params.id]);
    res.status(201).json(row.rows[0]);
  }));
  app.patch('/api/store/tools/debt-items/:id', ...guard, route(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, 404, 'Item não encontrado');
    const v = valid(itemBody, req, res); if (!v) return;
    const has = k => Object.prototype.hasOwnProperty.call(v, k);
    const r = await q(`UPDATE store_debt_items SET who=COALESCE($3,who),description=COALESCE($4,description),day=CASE WHEN $5 THEN $6::date ELSE day END,
        amount_cents=COALESCE($7,amount_cents),paid_cents=COALESCE($8,paid_cents),done=COALESCE($9,done),updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING ${itemCols}`,
      [tid(req), req.params.id, v.who ?? null, v.description ?? null, has('day'), v.day ?? null, v.amount_cents ?? null, v.paid_cents ?? null, v.done ?? null]);
    if (!r.rowCount) return bad(res, 404, 'Item não encontrado');
    await q('UPDATE store_debtors SET updated_at=now() WHERE id=$1', [r.rows[0].debtor_id]);
    res.json(r.rows[0]);
  }));
  app.delete('/api/store/tools/debt-items/:id', ...full, route(async (req, res) => {
    if (!isId(req.params.id)) return bad(res, 404, 'Item não encontrado');
    const r = await q('DELETE FROM store_debt_items WHERE tenant_id=$1 AND id=$2 RETURNING debtor_id', [tid(req), req.params.id]);
    if (!r.rowCount) return bad(res, 404, 'Item não encontrado');
    await q('UPDATE store_debtors SET updated_at=now() WHERE id=$1', [r.rows[0].debtor_id]);
    res.json({ ok: true });
  }));

  // ---------- Trazer do painel antigo (backup "elitech-backup" ou leitura direta) ----------
  // Acrescenta: links com o mesmo endereço e listas com o mesmo nome já existentes são pulados.
  const importBody = z.object({
    links: z.array(z.object({ name: text(120), url: z.string().max(2000), categories: z.array(text(40)).max(12).optional(), keywords: text(300).optional(), pinned: z.boolean().optional(), clicks: z.number().int().min(0).max(1e9).optional() })).max(2000).optional(),
    debtors: z.array(z.object({ name: text(120), phone: text(30).optional(), items: z.array(itemBody).max(500).optional() })).max(1000).optional()
  }).strict();
  app.post('/api/store/tools/import', ...full, route(async (req, res) => {
    const v = valid(importBody, req, res); if (!v) return;
    const t = tid(req), out = { links_added: 0, links_skipped: 0, debtors_added: 0, debtors_skipped: 0, items_added: 0 };
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE', [t]);
      const seen = new Set((await client.query('SELECT url FROM store_links WHERE tenant_id=$1', [t])).rows.map(r => urlKey(r.url)));
      let pos = (await client.query('SELECT COALESCE(max(position)+1,0) n FROM store_links WHERE tenant_id=$1', [t])).rows[0].n;
      for (const l of v.links || []) {
        const url = cleanUrl(l.url), key = urlKey(url);
        if (!url || !l.name || seen.has(key)) { out.links_skipped++; continue; }
        seen.add(key);
        const cats = [...new Set((l.categories || []).filter(Boolean))];
        await client.query('INSERT INTO store_links(id,tenant_id,name,url,categories,keywords,pinned,position,clicks) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id(), t, l.name, url, cats, l.keywords || '', !!l.pinned, pos++, l.clicks || 0]);
        out.links_added++;
      }
      const names = new Set((await client.query('SELECT lower(name) n FROM store_debtors WHERE tenant_id=$1', [t])).rows.map(r => r.n));
      let dpos = (await client.query('SELECT COALESCE(max(position)+1,0) n FROM store_debtors WHERE tenant_id=$1', [t])).rows[0].n;
      for (const d of v.debtors || []) {
        if (!d.name || names.has(d.name.toLowerCase())) { out.debtors_skipped++; continue; }
        names.add(d.name.toLowerCase());
        const did = id();
        await client.query('INSERT INTO store_debtors(id,tenant_id,name,phone,position) VALUES($1,$2,$3,$4,$5)', [did, t, d.name, d.phone || '', dpos++]);
        out.debtors_added++;
        let ipos = 0;
        for (const i of d.items || []) {
          if (!i.who && !i.description && !i.amount_cents && !i.paid_cents) continue;
          await client.query('INSERT INTO store_debt_items(id,tenant_id,debtor_id,who,description,day,amount_cents,paid_cents,done,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [id(), t, did, i.who || '', i.description || '', i.day || null, i.amount_cents || 0, i.paid_cents || 0, !!i.done, ipos++]);
          out.items_added++;
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    await audit(req, 'store_tools.import', 'tenant', t);
    res.json(out);
  }));
}
