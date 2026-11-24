// Importação de planilhas na central (master): peças e clientes de uma loja.
// Primeiro uso: Audace Joias (planilhas exportadas do sistema antigo, "Vendas e NF-e").
// A planilha vai em binário (.xlsx). Com ?dry_run=1 só confere e mostra o resumo, sem gravar.
// Peças: casa pelo código da loja; atualiza nome, preço, estoque, família e NCM.
// Clientes: casa pelo CPF; sem CPF, pelo telefone + nome; senão cria.
import express from 'express';
import ExcelJS from 'exceljs';

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const text = v => (v == null ? '' : (typeof v === 'object' && v.text != null ? String(v.text) : (typeof v === 'object' && v.result != null ? String(v.result) : String(v)))).trim();
const digits = v => text(v).replace(/\D/g, '');

const PRODUCT_COLS = { code: ['codigo'], name: ['descricao'], family: ['familia de produto', 'familia'], ncm: ['codigo ncm', 'ncm'], price: ['preco unitario de venda', 'preco de venda', 'preco'], stock: ['estoque disponivel', 'estoque'], status: ['situacao'] };
const CUSTOMER_COLS = { doc: ['cnpj / cpf', 'cpf', 'cpf/cnpj'], name: ['razao social / nome completo', 'nome completo', 'nome'], short: ['nome fantasia / nome abreviado'], phone: ['telefone', 'celular'], email: ['e-mail', 'email'], status: ['situacao'] };

async function readSheet(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) throw Object.assign(new Error('Planilha vazia'), { status: 400 });
  const rows = [];
  ws.eachRow({ includeEmpty: false }, row => { const vals = row.values.slice(1).map(text); rows.push(vals); });
  return rows;
}

function locate(rows, spec) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const h = rows[i].map(norm), map = {};
    for (const [k, names] of Object.entries(spec)) { const idx = h.findIndex(x => names.includes(x)); if (idx >= 0) map[k] = idx; }
    if (map.name != null && (map.code != null || map.doc != null || map.phone != null)) return { header: i, map };
  }
  return null;
}

export function detectKind(rows) {
  const p = locate(rows, PRODUCT_COLS); if (p && p.map.code != null && p.map.price != null) return { kind: 'products', ...p };
  const c = locate(rows, CUSTOMER_COLS); if (c) return { kind: 'customers', ...c };
  return null;
}

const money = v => { const t = text(v).replace(/[R$\s]/g, ''); const n = Number(/,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t); return Number.isFinite(n) ? Math.round(n * 100) : null; };

export function parseProducts(rows, { header, map }) {
  const out = [], skipped = [], seen = new Map();
  for (let i = header + 1; i < rows.length; i++) {
    const r = rows[i], line = i + 1, get = k => (map[k] == null ? '' : r[map[k]] ?? '');
    const code = text(get('code')), name = text(get('name')).replace(/\s+/g, ' ').slice(0, 120);
    if (!code && !name) continue;
    if (!/^[!-~]{1,64}$/.test(code)) { skipped.push({ line, code, name, reason: 'código vazio ou com espaço' }); continue; }
    if (name.length < 2) { skipped.push({ line, code, name, reason: 'sem descrição' }); continue; }
    const price = money(get('price'));
    if (price == null || price < 0 || price > 100000000) { skipped.push({ line, code, name, reason: 'preço inválido' }); continue; }
    if (seen.has(code)) { skipped.push({ line, code, name, reason: 'código repetido (ficou a linha ' + seen.get(code) + ')' }); continue; }
    seen.set(code, line);
    const ncm = digits(get('ncm')), stockRaw = Number(text(get('stock')).replace(',', '.'));
    out.push({ code, name, price_cents: price, family: text(get('family')).slice(0, 80) || null, ncm: /^\d{8}$/.test(ncm) ? ncm : null,
      stock_qty: Number.isFinite(stockRaw) ? Math.max(-999999, Math.min(999999, Math.trunc(stockRaw))) : null,
      active: map.status == null ? true : norm(get('status')) !== 'inativo' });
  }
  return { items: out, skipped };
}

export function parseCustomers(rows, { header, map }) {
  const out = [], skipped = [], seenDoc = new Set();
  for (let i = header + 1; i < rows.length; i++) {
    const r = rows[i], line = i + 1, get = k => (map[k] == null ? '' : r[map[k]] ?? '');
    const name = (text(get('name')) || text(get('short'))).replace(/\s+/g, ' ').slice(0, 120);
    if (!name && !digits(get('doc')) && !digits(get('phone'))) continue;
    if (name.length < 2) { skipped.push({ line, name, reason: 'sem nome' }); continue; }
    if (map.status != null && norm(get('status')) === 'inativo') { skipped.push({ line, name, reason: 'inativo na planilha' }); continue; }
    const doc = digits(get('doc')), cpf = doc.length === 11 ? doc : null;
    if (cpf && seenDoc.has(cpf)) { skipped.push({ line, name, reason: 'CPF repetido' }); continue; }
    if (cpf) seenDoc.add(cpf);
    let phone = digits(get('phone')); if (phone.startsWith('55') && phone.length > 11) phone = phone.slice(2);
    const email = text(get('email')).toLowerCase();
    out.push({ name, cpf, phone: phone.length >= 10 && phone.length <= 11 ? phone : null, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200 ? email : null });
  }
  return { items: out, skipped };
}

export function registerCatalogImport(app, { q, db: pool, auth, roles, route, bad, audit, uuid }) {
  const raw = express.raw({ type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], limit: '15mb' });
  app.post('/api/master/tenants/:id/import', auth, roles('master'), raw, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Loja inválida');
    const t = await q('SELECT id,name FROM tenants WHERE id=$1', [req.params.id]);
    if (!t.rowCount) return bad(res, 404, 'Loja não encontrada');
    if (!Buffer.isBuffer(req.body) || !req.body.length) return bad(res, 400, 'Envie o arquivo .xlsx');
    let rows; try { rows = await readSheet(req.body); } catch (e) { return bad(res, 400, e.status ? e.message : 'Não consegui ler a planilha (precisa ser .xlsx)'); }
    const found = detectKind(rows);
    if (!found) return bad(res, 400, 'Não reconheci as colunas. Peças precisam de Código, Descrição e Preço; clientes, de Nome e CPF ou Telefone.');
    const dry = req.query.dry_run === '1';
    const tid = t.rows[0].id;
    if (found.kind === 'products') {
      const { items, skipped } = parseProducts(rows, found);
      const existing = await q('SELECT code FROM products WHERE tenant_id=$1 AND code IS NOT NULL AND active', [tid]);
      const have = new Set(existing.rows.map(r => r.code));
      const summary = { kind: 'products', store: t.rows[0].name, total: items.length, new: items.filter(x => !have.has(x.code)).length, update: items.filter(x => have.has(x.code)).length,
        inactive: items.filter(x => !x.active).length, negative_stock: items.filter(x => (x.stock_qty ?? 0) < 0).length, no_ncm: items.filter(x => !x.ncm).length, skipped };
      if (dry) return res.json({ dry_run: true, ...summary });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const x of items) {
          const upd = await client.query(`UPDATE products SET name=$3,price_cents=$4,family=$5,ncm=$6,stock_qty=$7,active=$8,barcode=COALESCE(barcode,$2),imported_at=now(),updated_at=now()
            WHERE tenant_id=$1 AND code=$2 AND kind='product' AND (active OR NOT $8) RETURNING id`, [tid, x.code, x.name, x.price_cents, x.family, x.ncm, x.stock_qty, x.active]);
          if (upd.rowCount) continue;
          if (!x.active) continue;
          const taken = await client.query('SELECT 1 FROM products WHERE tenant_id=$1 AND barcode=$2 AND active', [tid, x.code]);
          await client.query(`INSERT INTO products(tenant_id,name,barcode,code,price_cents,family,ncm,fiscal_origin,stock_qty,kind,imported_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,'product',now())`, [tid, x.name, taken.rowCount ? null : x.code, x.code, x.price_cents, x.family, x.ncm, x.stock_qty]);
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
      await audit(req, 'import_products', 'tenant', tid);
      return res.json({ dry_run: false, ...summary });
    }
    const { items, skipped } = parseCustomers(rows, found);
    const ex = await q('SELECT id,cpf,phone_key,lower(name) lname FROM customers WHERE tenant_id=$1 AND deleted_at IS NULL', [tid]);
    const byCpf = new Map(ex.rows.filter(r => r.cpf).map(r => [r.cpf, r.id]));
    const keys = await q('SELECT k, fp_phone_key(k) pk FROM unnest($1::text[]) k', [[...new Set(items.map(x => x.phone).filter(Boolean))]]);
    const pk = new Map(keys.rows.map(r => [r.k, r.pk]));
    const byPhone = new Map(ex.rows.filter(r => r.phone_key).map(r => [r.phone_key + '|' + r.lname, r.id]));
    const match = x => (x.cpf && byCpf.get(x.cpf)) || (x.phone && pk.get(x.phone) && byPhone.get(pk.get(x.phone) + '|' + x.name.toLowerCase())) || null;
    const summary = { kind: 'customers', store: t.rows[0].name, total: items.length, new: items.filter(x => !match(x)).length, update: items.filter(x => match(x)).length,
      with_cpf: items.filter(x => x.cpf).length, with_phone: items.filter(x => x.phone).length, with_email: items.filter(x => x.email).length, skipped };
    if (dry) return res.json({ dry_run: true, ...summary });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const x of items) {
        const id = match(x);
        if (id) await client.query('UPDATE customers SET name=$2,cpf=COALESCE($3,cpf),phone=COALESCE($4,phone),email=COALESCE($5,email) WHERE id=$1', [id, x.name, x.cpf, x.phone, x.email]);
        else await client.query("INSERT INTO customers(tenant_id,name,cpf,phone,email,source) VALUES($1,$2,$3,$4,$5,'import')", [tid, x.name, x.cpf, x.phone, x.email]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    await audit(req, 'import_customers', 'tenant', tid);
    res.json({ dry_run: false, ...summary });
  }));
}
