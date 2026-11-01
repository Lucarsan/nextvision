// Backup de cada loja no computador da loja.
// - Uma vez por dia o agente Windows pede GET /api/connect/backup e guarda o arquivo .fpbak numa pasta
//   acessível só a SYSTEM e Administradores (C:\ProgramData\FicouPronto\backups).
// - O arquivo é cifrado aqui (AES-256-GCM) com uma chave que nunca sai do servidor: na loja ele é ilegível.
//   Só a central (master) abre, exporta ou restaura um backup.
// - Chave: STORE_BACKUP_KEY (64 hex). Sem ela, deriva do JWT_SECRET (como o secret-box). Trocar o
//   JWT_SECRET sem definir STORE_BACKUP_KEY torna os backups antigos ilegíveis: guarde a chave.
//
// Formato .fpbak: "FPBK1\n" | 4 bytes (tamanho do cabeçalho) | cabeçalho JSON | iv(12) | tag(16) | gzip(JSON) cifrado.
// O cabeçalho (loja, data, id) não é secreto, mas é autenticado junto com os dados.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import express from 'express';
import { z } from 'zod';

const MAGIC = Buffer.from('FPBK1\n');
const masterKey = () => {
  const configured = process.env.STORE_BACKUP_KEY || '';
  if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
  const base = process.env.JWT_SECRET || '';
  if (base.length < 32) throw Error('Configure JWT_SECRET ou STORE_BACKUP_KEY');
  return Buffer.from(crypto.hkdfSync('sha256', base, 'nextvision', 'store-backup-master-v1', 32));
};
// Uma chave por loja: um arquivo de uma loja nunca abre como sendo de outra.
const tenantKey = tenantId => Buffer.from(crypto.hkdfSync('sha256', masterKey(), 'ficoupronto-backup', 'tenant:' + tenantId, 32));

export function sealBackup(header, payload) {
  const head = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4); len.writeUInt32BE(head.length);
  const aad = Buffer.concat([MAGIC, len, head]);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tenantKey(header.tenant_id), iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 6 })), cipher.final()]);
  return Buffer.concat([aad, iv, cipher.getAuthTag(), data]);
}

export function openBackup(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length + 4 + 28 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw Object.assign(Error('Não é um arquivo de backup do Ficou Pronto'), { status: 400 });
  const len = buf.readUInt32BE(MAGIC.length);
  if (len > 4096 || MAGIC.length + 4 + len + 28 > buf.length) throw Object.assign(Error('Arquivo de backup corrompido'), { status: 400 });
  const aad = buf.subarray(0, MAGIC.length + 4 + len);
  let header;
  try { header = JSON.parse(aad.subarray(MAGIC.length + 4).toString('utf8')); } catch { throw Object.assign(Error('Arquivo de backup corrompido'), { status: 400 }); }
  if (!z.string().uuid().safeParse(header.tenant_id).success) throw Object.assign(Error('Arquivo de backup corrompido'), { status: 400 });
  const at = aad.length;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', tenantKey(header.tenant_id), buf.subarray(at, at + 12));
    decipher.setAAD(aad); decipher.setAuthTag(buf.subarray(at + 12, at + 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(at + 28)), decipher.final()]);
    return { header, payload: JSON.parse(zlib.gunzipSync(plain).toString('utf8')) };
  } catch { throw Object.assign(Error('Backup alterado, corrompido ou cifrado com outra chave'), { status: 422 }); }
}

// Tabelas da loja: todas com tenant_id (inclusive as que surgirem depois). Colunas geradas ficam de fora.
async function tenantTables(q) {
  const r = await q(`SELECT c.table_name t,array_agg(c.column_name::text ORDER BY c.ordinal_position) FILTER (WHERE c.is_generated='NEVER') cols,
      coalesce(array_agg(c.column_name::text) FILTER (WHERE c.is_generated<>'NEVER'),'{}') gen
    FROM information_schema.columns c JOIN information_schema.tables tb ON tb.table_schema=c.table_schema AND tb.table_name=c.table_name AND tb.table_type='BASE TABLE'
    WHERE c.table_schema=current_schema() GROUP BY 1 HAVING bool_or(c.column_name='tenant_id') ORDER BY 1`);
  return r.rows.map(x => ({ name: x.t, cols: x.cols, gen: x.gen }));
}
const ident = s => '"' + String(s).replace(/"/g, '""') + '"';

export async function buildBackup(q, tenantId, meta = {}) {
  const tenant = (await q('SELECT * FROM tenants WHERE id=$1', [tenantId])).rows[0];
  if (!tenant) throw Object.assign(Error('Loja não encontrada'), { status: 404 });
  const schema = (await q('SELECT max(name) m FROM nextvision_schema_migrations')).rows[0].m;
  const tables = {}; let rows = 0;
  for (const t of await tenantTables(q)) {
    const r = await q(`SELECT coalesce(jsonb_agg(to_jsonb(x) - $2::text[]),'[]'::jsonb) rows FROM ${ident(t.name)} x WHERE x.tenant_id=$1`, [tenantId, t.gen]);
    tables[t.name] = r.rows[0].rows; rows += tables[t.name].length;
  }
  const created_at = new Date().toISOString();
  const header = { format: 1, tenant_id: tenantId, slug: tenant.slug, created_at, backup_id: meta.backup_id || crypto.randomUUID() };
  const file = sealBackup(header, { format: 1, tenant_id: tenantId, created_at, schema, tenant, tables });
  return { file, header, rows, sha256: crypto.createHash('sha256').update(file).digest('hex') };
}

const summary = ({ header, payload }) => ({
  tenant_id: header.tenant_id, slug: header.slug, created_at: header.created_at, backup_id: header.backup_id, schema: payload.schema,
  store_name: payload.tenant?.name, tables: Object.fromEntries(Object.entries(payload.tables).map(([k, v]) => [k, v.length]).filter(([, n]) => n > 0)),
  rows: Object.values(payload.tables).reduce((a, v) => a + v.length, 0)
});

// Restauração: só devolve o que FALTA (linhas cujo id não existe mais). Nada que já está no banco é alterado.
// As tabelas são tentadas em várias passadas (dependências entre elas resolvem na ordem certa).
export async function restoreBackup(db, opened) {
  const { payload } = opened, tenantId = payload.tenant_id;
  const c = await db.connect(); const inserted = {}, failed = {};
  try {
    await c.query('BEGIN');
    const tq = (sql, p) => c.query(sql, p);
    const cols = new Map((await tenantTables(tq)).map(t => [t.name, t.cols]));
    const tenantCols = (await c.query(`SELECT array_agg(column_name::text) a FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tenants' AND is_generated='NEVER'`)).rows[0].a;
    const restoreTable = async (name, rows, columns) => {
      const use = columns.filter(col => rows.some(r => col in r));
      const sql = `INSERT INTO ${ident(name)}(${use.map(ident).join(',')}) OVERRIDING SYSTEM VALUE SELECT ${use.map(ident).join(',')} FROM jsonb_populate_recordset(NULL::${ident(name)},$1::jsonb) ON CONFLICT DO NOTHING`;
      return (await c.query(sql, [JSON.stringify(rows)])).rowCount;
    };
    if (payload.tenant) inserted.tenants = await restoreTable('tenants', [payload.tenant], tenantCols);
    let pending = Object.entries(payload.tables).filter(([name, rows]) => rows.length && cols.has(name));
    for (const [name] of Object.entries(payload.tables)) if (!cols.has(name)) failed[name] = 'tabela não existe mais nesta versão';
    for (let pass = 0; pass < 8 && pending.length; pass++) {
      const next = [];
      for (const [name, rows] of pending) {
        await c.query('SAVEPOINT t');
        try { inserted[name] = (inserted[name] || 0) + await restoreTable(name, rows, cols.get(name)); await c.query('RELEASE SAVEPOINT t'); delete failed[name]; }
        catch (e) { await c.query('ROLLBACK TO SAVEPOINT t'); failed[name] = e.code === '23503' ? 'depende de dados que não foram restaurados' : (e.code || 'erro'); next.push([name, rows]); }
      }
      if (next.length === pending.length) break;
      pending = next;
    }
    await c.query('COMMIT');
    return { tenant_id: tenantId, inserted: Object.fromEntries(Object.entries(inserted).filter(([, n]) => n > 0)), failed };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

export function registerStoreBackup(app, { q, db, auth, roles, deviceAuth, route, bad, valid, audit, rateLimit, uuid }) {
  // Agente da loja: no máximo um backup por hora por computador.
  app.get('/api/connect/backup', rateLimit({ windowMs: 60000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false }), deviceAuth, route(async (req, res) => {
    const recent = await q("SELECT 1 FROM store_backups WHERE device_id=$1 AND created_at>now()-interval '1 hour'", [req.device.id]);
    if (recent.rowCount) return bad(res, 429, 'Backup já gerado na última hora');
    const id = crypto.randomUUID();
    const b = await buildBackup(q, req.device.tenant_id, { backup_id: id });
    await q('INSERT INTO store_backups(id,tenant_id,device_id,bytes,sha256,rows_count) VALUES($1,$2,$3,$4,$5,$6)', [id, req.device.tenant_id, req.device.id, b.file.length, b.sha256, b.rows]);
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', 'X-Backup-Id': id, 'X-Backup-Sha256': b.sha256,
      'Content-Disposition': `attachment; filename="ficoupronto-${b.header.created_at.slice(0, 10)}.fpbak"` });
    res.send(b.file);
  }));
  // O agente confirma que gravou o arquivo inteiro (mesmo tamanho e SHA-256).
  app.post('/api/connect/backup/:id/saved', deviceAuth, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Backup inválido');
    const v = valid(z.object({ bytes: z.number().int().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), req, res); if (!v) return;
    const r = await q('UPDATE store_backups SET saved_at=now() WHERE id=$1 AND device_id=$2 AND bytes=$3 AND sha256=$4 RETURNING id', [req.params.id, req.device.id, v.bytes, v.sha256]);
    if (!r.rowCount) return bad(res, 409, 'O arquivo gravado não confere com o backup gerado');
    res.json({ saved: true });
  }));

  // Central: histórico por loja, abrir, exportar e restaurar um arquivo .fpbak.
  const master = [auth, roles('master')];
  app.get('/api/master/tenants/:id/backups', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Loja inválida');
    const r = await q(`SELECT b.id,b.created_at,b.saved_at,b.bytes,b.rows_count,d.name device_name FROM store_backups b LEFT JOIN shop_devices d ON d.id=b.device_id
      WHERE b.tenant_id=$1 ORDER BY b.created_at DESC LIMIT 60`, [req.params.id]);
    res.json(r.rows);
  }));
  const raw = express.raw({ type: () => true, limit: '300mb' });
  const readFile = (req, res) => { try { return openBackup(req.body); } catch (e) { bad(res, e.status || 400, e.message); return null; } };
  app.post('/api/master/backups/inspect', ...master, raw, route(async (req, res) => {
    const o = readFile(req, res); if (!o) return;
    res.json(summary(o));
  }));
  app.post('/api/master/backups/export', ...master, raw, route(async (req, res) => {
    const o = readFile(req, res); if (!o) return;
    await audit(req, 'export', 'store_backup', o.header.backup_id);
    res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="backup-${o.header.slug || 'loja'}-${o.header.created_at.slice(0, 10)}.json"` });
    res.type('application/json').send(JSON.stringify(o.payload, null, 1));
  }));
  // Restaurar exige confirmar a loja (?tenant=<id>): evita restaurar o arquivo errado por engano.
  app.post('/api/master/backups/restore', ...master, raw, route(async (req, res) => {
    const o = readFile(req, res); if (!o) return;
    if (req.query.tenant !== o.header.tenant_id) return bad(res, 400, 'Confirme a loja do backup para restaurar');
    await audit(req, 'restore', 'store_backup', o.header.backup_id);
    res.json({ ...(await restoreBackup(db, o)), backup: summary(o) });
  }));
}
