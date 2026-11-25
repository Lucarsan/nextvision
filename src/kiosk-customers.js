// Clientes no quiosque (Audace e outras redes): cadastro completo e aba "Clientes".
// - newCustomerSchema / saveNewCustomer: cadastro feito no caixa junto com a venda (nome, WhatsApp, CPF,
//   nascimento, e-mail, CEP, endereço e se aceita ofertas). Telefone ou CPF já cadastrados na unidade
//   reaproveitam a ficha e só completam o que estava em branco.
// - GET/POST/PATCH /api/store/kiosk/customers: lista, ficha com histórico e edição. Em loja de rede a lista é
//   da rede inteira (uma linha por pessoa, fichas ligadas por link_id) e o histórico soma as compras de todas
//   as unidades, com o nome da unidade em cada venda.
import { z } from 'zod';
import { linkLocal } from './network-customers.js';

const digits = v => typeof v === 'string' ? v.replace(/\D/g, '') : v;
const trim = v => typeof v === 'string' ? v.trim() : v == null ? '' : v;
export const validCpf = c => {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  const d = n => { let s = 0; for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return d(9) === Number(c[9]) && d(10) === Number(c[10]);
};
const okBirth = s => {
  const d = new Date(s + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '1900-01-01' && d.getTime() <= Date.now();
};

export const customerFields = {
  name: z.preprocess(trim, z.string().min(2).max(120)),
  phone: z.preprocess(trim, z.string().max(30)).default(''),
  cpf: z.preprocess(digits, z.union([z.literal(''), z.string().refine(validCpf, 'CPF inválido')])).default(''),
  birth_date: z.preprocess(trim, z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(okBirth, 'Data de nascimento inválida')])).default(''),
  email: z.preprocess(v => trim(v).toLowerCase?.() ?? v, z.union([z.literal(''), z.string().email('E-mail inválido').max(160)])).default(''),
  postal_code: z.preprocess(digits, z.union([z.literal(''), z.string().regex(/^\d{8}$/, 'CEP inválido')])).default(''),
  address: z.preprocess(trim, z.string().max(500)).default(''),
  offers_opt_out: z.boolean().optional()
};
export const newCustomerSchema = z.object(customerFields);

const nul = v => v || null;

// Cria a ficha (ou reaproveita a da mesma pessoa nesta unidade, pelo telefone ou CPF) e liga às outras unidades da rede.
export async function saveNewCustomer(client, tenantId, nc) {
  const phone = digits(nc.phone || ''), cpf = nc.cpf || '';
  const same = (phone || cpf) ? (await client.query(`SELECT id FROM customers WHERE tenant_id=$1 AND deleted_at IS NULL
      AND (($2::text<>'' AND phone_key=fp_phone_key($2::text)) OR ($3::text<>'' AND cpf=$3::text))
      ORDER BY (cpf IS NOT DISTINCT FROM nullif($3::text,'')) DESC, created_at LIMIT 1`, [tenantId, phone, cpf])).rows[0] : null;
  if (same) {
    // Ficha existente: não troca o que já estava preenchido, só completa os campos vazios.
    await client.query(`UPDATE customers SET email=coalesce(email,$2),cpf=coalesce(cpf,$3),birth_date=coalesce(birth_date,$4::date),
        postal_code=coalesce(postal_code,$5),address=coalesce(address,$6),phone=coalesce(phone,$7),offers_opt_out=offers_opt_out OR $8 WHERE id=$1`,
      [same.id, nul(nc.email), nul(cpf), nul(nc.birth_date), nul(nc.postal_code), nul(nc.address), nul(phone), !!nc.offers_opt_out]);
    await linkLocal(client, tenantId, same.id);
    return { id: same.id, created: false };
  }
  const id = (await client.query(`INSERT INTO customers(tenant_id,name,phone,cpf,birth_date,email,postal_code,address,offers_opt_out,source)
      VALUES($1,$2,$3,$4,$5::date,$6,$7,$8,$9,'caixa') RETURNING id`,
    [tenantId, nc.name, nul(phone), nul(cpf), nul(nc.birth_date), nul(nc.email), nul(nc.postal_code), nul(nc.address), !!nc.offers_opt_out])).rows[0].id;
  await linkLocal(client, tenantId, id);
  return { id, created: true };
}

export function registerKioskCustomers(app, { q, db, route, bad, valid, audit, staff, tid, uuid, cashbackFor }) {
  // Unidades cujas clientes esta loja enxerga: a rede inteira, ou só ela mesma.
  const SCOPE = `(SELECT CASE WHEN t.network_id IS NULL THEN ARRAY[t.id] ELSE (SELECT array_agg(o.id) FROM tenants o WHERE o.network_id=t.network_id) END FROM tenants t WHERE t.id=$1)`;
  // Fichas da mesma pessoa dentro do escopo (inclui a própria).
  async function fichas(client, tenantId, id) {
    return (await client.query(`WITH s AS (SELECT ${SCOPE} ids), me AS (SELECT c.id, coalesce(c.link_id,c.id) person FROM customers c, s WHERE c.id=$2 AND c.tenant_id=ANY(s.ids) AND c.deleted_at IS NULL)
      SELECT k.id, k.tenant_id FROM customers k, s, me WHERE k.tenant_id=ANY(s.ids) AND k.deleted_at IS NULL AND (k.id=me.id OR k.link_id=me.person OR k.id=me.person)
      ORDER BY (k.tenant_id=$1) DESC, k.created_at`, [tenantId, id])).rows;
  }

  app.get('/api/store/kiosk/customers', ...staff, route(async (req, res) => {
    const term = String(req.query.q || '').trim().slice(0, 80), d = term.replace(/\D/g, '');
    const offset = Math.max(0, Math.min(100000, parseInt(req.query.offset, 10) || 0));
    const sort = req.query.sort === 'name' ? 'b.name_fold, b.id' : 'a.last_at DESC NULLS LAST, b.name_fold, b.id';
    const r = await q(`WITH s AS (SELECT ${SCOPE} ids),
      base AS (SELECT DISTINCT ON (coalesce(c.link_id,c.id)) c.id, c.tenant_id, c.name, fp_fold(c.name) name_fold, c.phone, c.email,
          to_char(c.birth_date,'YYYY-MM-DD') birth_date, coalesce(c.link_id,c.id) person, c.created_at
        FROM customers c, s WHERE c.tenant_id=ANY(s.ids) AND c.deleted_at IS NULL
          AND ($2='' OR fp_fold(c.name) LIKE '%'||fp_fold($2)||'%' OR lower(coalesce(c.email,'')) LIKE '%'||lower($2)||'%'
            OR (length($3)>=4 AND regexp_replace(coalesce(c.phone,''),'\\D','','g') LIKE '%'||$3||'%') OR (length($3)=11 AND c.cpf=$3))
        ORDER BY coalesce(c.link_id,c.id), (c.tenant_id=$1) DESC, c.created_at),
      a AS (SELECT coalesce(k.link_id,k.id) person, count(*)::int sales, sum(x.total_cents)::bigint spent_cents, max(x.created_at) last_at
        FROM sales x JOIN customers k ON k.id=x.customer_id, s WHERE x.tenant_id=ANY(s.ids) AND x.canceled_at IS NULL GROUP BY 1)
      SELECT b.id, b.name, b.phone, b.email, b.birth_date, b.tenant_id=$1 local, coalesce(t.unit_label,t.name) unit,
        coalesce(a.sales,0) sales, coalesce(a.spent_cents,0) spent_cents, a.last_at, count(*) OVER() total
      FROM base b JOIN tenants t ON t.id=b.tenant_id LEFT JOIN a ON a.person=b.person
      ORDER BY ${sort} LIMIT 50 OFFSET $4`, [tid(req), term, d, offset]);
    res.set('Cache-Control', 'no-store');
    res.json({ total: Number(r.rows[0]?.total || 0), offset, customers: r.rows.map(({ total, ...x }) => ({ ...x, spent_cents: Number(x.spent_cents) })) });
  }));

  app.get('/api/store/kiosk/customers/:id', ...staff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Cliente inválida');
    const list = await fichas({ query: q }, tid(req), req.params.id);
    if (!list.length) return bad(res, 404, 'Cliente não encontrada');
    const ids = list.map(x => x.id), main = list[0];
    const c = (await q(`SELECT c.id,c.name,c.phone,c.cpf,c.email,to_char(c.birth_date,'YYYY-MM-DD') birth_date,c.postal_code,c.address,c.offers_opt_out,
        c.created_at,c.source,c.tenant_id=$2 local,coalesce(t.unit_label,t.name) unit
      FROM customers c JOIN tenants t ON t.id=c.tenant_id WHERE c.id=$1`, [main.id, tid(req)])).rows[0];
    const sales = (await q(`SELECT x.id,x.sale_number,x.total_cents,x.discount_cents,x.cashback_used_cents,x.cashback_earned_cents,x.payment_method,x.payments,
        x.receipt_code,x.created_at,x.canceled_at,x.cancel_reason,coalesce(t.unit_label,t.name) unit,coalesce(sl.name,u.name) seller_name,
        coalesce((SELECT json_agg(json_build_object('name',i.name,'code',i.barcode,'variant',i.variant_name,'quantity',i.quantity,'total_cents',i.total_cents,'gift',i.gift) ORDER BY i.position)
          FROM sale_items i WHERE i.sale_id=x.id),'[]'::json) items
      FROM sales x JOIN tenants t ON t.id=x.tenant_id JOIN users u ON u.id=x.created_by LEFT JOIN users sl ON sl.id=x.seller_id
      WHERE x.customer_id=ANY($1::uuid[]) ORDER BY x.created_at DESC LIMIT 300`, [ids])).rows;
    const ok = sales.filter(x => !x.canceled_at);
    const byUnit = {};
    for (const x of ok) { const u = byUnit[x.unit] ||= { count: 0, total_cents: 0 }; u.count++; u.total_cents += x.total_cents; }
    const spent = ok.reduce((s, x) => s + x.total_cents, 0);
    const cbTenant = list.find(x => x.tenant_id === tid(req)) || main;
    const cashback = await cashbackFor(cbTenant.tenant_id, [cbTenant.id]).then(m => m.get(cbTenant.id)).catch(() => null);
    res.set('Cache-Control', 'no-store');
    res.json({ customer: c, sales,
      totals: { spent_cents: spent, sales: ok.length, ticket_cents: ok.length ? Math.round(spent / ok.length) : 0,
        first_at: ok.length ? ok[ok.length - 1].created_at : null, last_at: ok[0]?.created_at || null, by_unit: byUnit },
      cashback });
  }));

  // Cadastro avulso pela aba Clientes (sem venda).
  app.post('/api/store/kiosk/customers', ...staff, route(async (req, res) => {
    const v = valid(newCustomerSchema, req, res); if (!v) return;
    const c = await db.connect(); let r;
    try { await c.query('BEGIN'); r = await saveNewCustomer(c, tid(req), v); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    if (r.created) await audit(req, 'create', 'customer', r.id);
    res.status(r.created ? 201 : 200).json(r);
  }));

  // Edição: grava em todas as fichas da mesma pessoa na rede (cadastro único).
  app.patch('/api/store/kiosk/customers/:id', ...staff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Cliente inválida');
    const v = valid(z.object({ ...customerFields, offers_opt_out: z.boolean().default(false) }), req, res); if (!v) return;
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const list = await fichas(c, tid(req), req.params.id);
      if (!list.length) { await c.query('ROLLBACK'); return bad(res, 404, 'Cliente não encontrada'); }
      await c.query(`UPDATE customers SET name=$2,phone=$3,cpf=$4,birth_date=$5::date,email=$6,postal_code=$7,address=$8,offers_opt_out=$9 WHERE id=ANY($1::uuid[])`,
        [list.map(x => x.id), v.name, nul(digits(v.phone)), nul(v.cpf), nul(v.birth_date), nul(v.email), nul(v.postal_code), nul(v.address), v.offers_opt_out]);
      // Telefone ou CPF novo pode ligar a ficha a outra unidade.
      const mine = list.find(x => x.tenant_id === tid(req)); if (mine) await linkLocal(c, tid(req), mine.id);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    await audit(req, 'update', 'customer', req.params.id);
    res.json({ ok: true });
  }));
}
