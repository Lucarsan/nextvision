// Arquivos à distância entre a central e os computadores das lojas.
// - A central (só master) pede: listar uma pasta, enviar um arquivo para o PC ou trazer um arquivo do PC.
// - O agente do PC fica sabendo pelo sinal de vida (remote_pending) e busca o pedido em /api/connect/remote/next.
// - O conteúdo passa pelo disco temporário do servidor (não pelo banco) e some em 24 h.
//   Se o servidor reiniciar no meio, o arquivo se perde e o pedido falha com aviso claro: é só repetir.
// - Componentes das câmeras: o instalador leve baixa FFmpeg, MediaMTX e cloudflared do endereço oficial,
//   conferindo o SHA-256 fixado em installer/windows/vendor.lock (mesma lista do instalador completo).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const remoteDir = () => process.env.REMOTE_FILES_DIR || path.join(os.tmpdir(), 'ficoupronto-remote');
export const maxBytes = () => Math.max(1, Number(process.env.REMOTE_FILES_MAX_MB) || 100) * 1024 * 1024;
const fileOf = id => path.join(remoteDir(), id + '.bin');
const exists = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const unlink = f => { try { fs.unlinkSync(f); } catch { /* já não existe */ } };

// Caminho absoluto do Windows (C:\pasta\arquivo). Sem "..", sem caracteres proibidos.
export function validWindowsPath(p) {
  if (typeof p !== 'string' || p.length < 3 || p.length > 400) return false;
  if (!/^[A-Za-z]:\\/.test(p)) return false;
  const rest = p.slice(3);
  if (/[<>:"|?*\x00-\x1f/]/.test(rest)) return false;
  return rest.split('\\').every((s, i, all) => (s === '' ? i === all.length - 1 : s !== '.' && s !== '..' && !/[ .]$/.test(s)));
}
export const validFileName = n => typeof n === 'string' && /^[^<>:"/\\|?*\x00-\x1f]{1,200}$/.test(n) && !/^\.{1,2}$/.test(n) && !/[ .]$/.test(n);

// Componentes baixados pelo instalador leve (o WinSW já vai dentro dele).
export function cameraComponents() {
  const text = fs.readFileSync(path.join(repo, 'installer/windows/vendor.lock'), 'utf8');
  return text.split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(l => { const [name, url, sha256] = l.split('|'); return { name, url, sha256 }; })
    .filter(c => c.name !== 'WinSW-x64.exe' && /^https:\/\/github\.com\//.test(c.url) && /^[a-f0-9]{64}$/.test(c.sha256));
}

class TooLarge extends Error {}
// Grava o corpo da requisição em disco contando bytes e calculando o SHA-256, sem guardar em memória.
async function receive(req, file, limit) {
  const declared = Number(req.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new TooLarge();
  fs.mkdirSync(remoteDir(), { recursive: true, mode: 0o700 });
  const hash = crypto.createHash('sha256'); let bytes = 0;
  const count = new Transform({ transform(chunk, _e, cb) { bytes += chunk.length; if (bytes > limit) return cb(new TooLarge()); hash.update(chunk); cb(null, chunk); } });
  const part = file + '.part';
  try { await pipeline(req, count, fs.createWriteStream(part, { mode: 0o600 })); fs.renameSync(part, file); }
  catch (e) { unlink(part); throw e; }
  return { bytes, sha256: hash.digest('hex') };
}

const entry = z.object({ name: z.string().max(260), type: z.enum(['file', 'dir']), size: z.number().nonnegative().optional(), modified: z.string().max(40).optional() });
const resultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(500).optional(),
  entries: z.array(entry).max(1000).optional(),
  truncated: z.boolean().optional(),
  saved_path: z.string().max(400).optional()
});

const publicJob = j => ({ id: j.id, kind: j.kind, path: j.path, file_name: j.file_name, overwrite: j.overwrite, bytes: j.bytes == null ? null : Number(j.bytes), sha256: j.sha256,
  status: j.status, result: j.result, error: j.error, created_at: j.created_at, picked_at: j.picked_at, finished_at: j.finished_at, expires_at: j.expires_at,
  file_ready: j.kind === 'pull' && j.status === 'done' && exists(fileOf(j.id)) });

export function registerRemoteFiles(app, { q, auth, roles, deviceAuth, route, bad, valid, audit, rateLimit, uuid }) {
  // Pedidos vencidos ou abandonados: marca e apaga o arquivo temporário.
  const sweep = async deviceId => {
    const gone = await q(`UPDATE device_remote_jobs SET status='expired',finished_at=COALESCE(finished_at,now())
      WHERE device_id=$1 AND expires_at<now() AND status IN ('pending','running','done') RETURNING id`, [deviceId]);
    for (const r of gone.rows) unlink(fileOf(r.id));
    await q(`UPDATE device_remote_jobs SET status='failed',finished_at=now(),error='O computador não concluiu em 30 min (desligou ou perdeu a internet). Peça de novo.'
      WHERE device_id=$1 AND status='running' AND picked_at<now()-interval '30 minutes'`, [deviceId]);
  };

  const deviceOf = async (req, res) => {
    if (!uuid.safeParse(req.params.id).success || !uuid.safeParse(req.params.deviceId).success) { bad(res, 400, 'Computador inválido'); return null; }
    const d = await q('SELECT id,tenant_id,name,agent_version FROM shop_devices WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL', [req.params.deviceId, req.params.id]);
    if (!d.rowCount) { bad(res, 404, 'Computador não encontrado'); return null; }
    return d.rows[0];
  };
  const base = '/api/master/tenants/:id/devices/:deviceId/remote';
  const limiter = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

  app.get(base, auth, roles('master'), route(async (req, res) => {
    const d = await deviceOf(req, res); if (!d) return;
    await sweep(d.id);
    const r = await q('SELECT * FROM device_remote_jobs WHERE device_id=$1 ORDER BY created_at DESC LIMIT 40', [d.id]);
    res.set('Cache-Control', 'no-store').json({ device: { id: d.id, name: d.name, agent_version: d.agent_version }, max_bytes: maxBytes(), jobs: r.rows.map(publicJob) });
  }));

  const create = async (req, d, kind, p, extra = {}) => {
    const r = await q(`INSERT INTO device_remote_jobs(tenant_id,device_id,kind,path,file_name,overwrite,bytes,sha256,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [d.tenant_id, d.id, kind, p, extra.file_name || null, extra.overwrite === true, extra.bytes ?? null, extra.sha256 || null, req.user.id]);
    await audit(req, 'remote_' + kind, 'shop_device', d.id, d.tenant_id);
    return r.rows[0];
  };
  const pathBody = z.object({ path: z.string().trim().refine(validWindowsPath, 'Caminho inválido') });

  app.post(base + '/list', auth, roles('master'), limiter, route(async (req, res) => {
    const d = await deviceOf(req, res); if (!d) return;
    const v = valid(pathBody, req, res); if (!v) return;
    res.status(201).json(publicJob(await create(req, d, 'list', v.path)));
  }));

  app.post(base + '/pull', auth, roles('master'), limiter, route(async (req, res) => {
    const d = await deviceOf(req, res); if (!d) return;
    const v = valid(pathBody, req, res); if (!v) return;
    if (v.path.endsWith('\\')) return bad(res, 400, 'Informe o caminho de um arquivo, não de uma pasta');
    res.status(201).json(publicJob(await create(req, d, 'pull', v.path)));
  }));

  // Corpo = bytes do arquivo. ?folder=C:\pasta&name=arquivo.ext[&overwrite=1]
  app.post(base + '/push', auth, roles('master'), limiter, route(async (req, res) => {
    const d = await deviceOf(req, res); if (!d) return;
    const folder = String(req.query.folder || '').trim(), name = String(req.query.name || '').trim();
    if (!validWindowsPath(folder)) return bad(res, 400, 'Pasta de destino inválida');
    if (!validFileName(name)) return bad(res, 400, 'Nome de arquivo inválido');
    const id = crypto.randomUUID(), file = fileOf(id);
    let got;
    try { got = await receive(req, file, maxBytes()); }
    catch (e) { if (e instanceof TooLarge) return bad(res, 413, 'Arquivo maior que ' + Math.round(maxBytes() / 1048576) + ' MB'); throw e; }
    if (!got.bytes) { unlink(file); return bad(res, 400, 'Arquivo vazio'); }
    try {
      const r = await q(`INSERT INTO device_remote_jobs(id,tenant_id,device_id,kind,path,file_name,overwrite,bytes,sha256,created_by)
        VALUES($1,$2,$3,'push',$4,$5,$6,$7,$8,$9) RETURNING *`, [id, d.tenant_id, d.id, folder, name, ['1', 'true'].includes(String(req.query.overwrite)), got.bytes, got.sha256, req.user.id]);
      await audit(req, 'remote_push', 'shop_device', d.id, d.tenant_id);
      res.status(201).json(publicJob(r.rows[0]));
    } catch (e) { unlink(file); throw e; }
  }));

  app.get(base + '/jobs/:jobId/file', auth, roles('master'), route(async (req, res) => {
    const d = await deviceOf(req, res); if (!d) return;
    if (!uuid.safeParse(req.params.jobId).success) return bad(res, 400, 'Pedido inválido');
    const r = await q("SELECT * FROM device_remote_jobs WHERE id=$1 AND device_id=$2 AND kind='pull' AND status='done'", [req.params.jobId, d.id]);
    const job = r.rows[0], file = job && fileOf(job.id);
    if (!job || !exists(file)) return bad(res, 404, 'Arquivo não está mais disponível (vale 24 h e some se o servidor reiniciar). Peça de novo.');
    const name = path.win32.basename(job.path).replace(/["\r\n]/g, '_');
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', 'Content-Length': String(fs.statSync(file).size),
      'Content-Disposition': 'attachment; filename="' + name.replace(/[^\x20-\x7e]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(name) });
    await audit(req, 'remote_download', 'shop_device', d.id, d.tenant_id);
    fs.createReadStream(file).pipe(res);
  }));

  app.delete(base + '/jobs/:jobId', auth, roles('master'), route(async (req, res) => {
    const d = await deviceOf(req, res); if (!d) return;
    if (!uuid.safeParse(req.params.jobId).success) return bad(res, 400, 'Pedido inválido');
    const r = await q(`UPDATE device_remote_jobs SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,finished_at=COALESCE(finished_at,now())
      WHERE id=$1 AND device_id=$2 RETURNING id,status`, [req.params.jobId, d.id]);
    if (!r.rowCount) return bad(res, 404, 'Pedido não encontrado');
    unlink(fileOf(req.params.jobId));
    res.json({ ok: true, status: r.rows[0].status });
  }));

  // ---------- Lado do computador da loja ----------
  app.get('/api/connect/remote/next', deviceAuth, route(async (req, res) => {
    await sweep(req.device.id);
    for (let i = 0; i < 5; i++) {
      const r = await q(`UPDATE device_remote_jobs SET status='running',picked_at=now()
        WHERE id=(SELECT id FROM device_remote_jobs WHERE device_id=$1 AND status='pending' AND expires_at>now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id,kind,path,file_name,overwrite,bytes,sha256`, [req.device.id]);
      if (!r.rowCount) return res.set('Cache-Control', 'no-store').status(204).end();
      const job = r.rows[0];
      if (job.kind === 'push' && !exists(fileOf(job.id))) {
        await q("UPDATE device_remote_jobs SET status='failed',finished_at=now(),error='O arquivo enviado se perdeu no servidor (reinício). Envie de novo.' WHERE id=$1", [job.id]);
        continue;
      }
      return res.set('Cache-Control', 'no-store').json({ ...job, bytes: job.bytes == null ? null : Number(job.bytes), max_bytes: maxBytes(),
        ...(job.kind === 'push' ? { url: '/api/connect/remote/jobs/' + job.id + '/file' } : {}), ...(job.kind === 'pull' ? { upload_url: '/api/connect/remote/jobs/' + job.id + '/upload' } : {}) });
    }
    res.status(204).end();
  }));

  const running = async (req, res, kind) => {
    if (!uuid.safeParse(req.params.id).success) { bad(res, 400, 'Pedido inválido'); return null; }
    const r = await q("SELECT * FROM device_remote_jobs WHERE id=$1 AND device_id=$2 AND status='running'" + (kind ? ' AND kind=$3' : ''), kind ? [req.params.id, req.device.id, kind] : [req.params.id, req.device.id]);
    if (!r.rowCount) { bad(res, 404, 'Pedido não encontrado'); return null; }
    return r.rows[0];
  };

  app.get('/api/connect/remote/jobs/:id/file', deviceAuth, route(async (req, res) => {
    const job = await running(req, res, 'push'); if (!job) return;
    const file = fileOf(job.id);
    if (!exists(file)) return bad(res, 410, 'Arquivo não está mais no servidor');
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', 'Content-Length': String(fs.statSync(file).size) });
    fs.createReadStream(file).pipe(res);
  }));

  app.post('/api/connect/remote/jobs/:id/upload', deviceAuth, route(async (req, res) => {
    const job = await running(req, res, 'pull'); if (!job) return;
    let got;
    try { got = await receive(req, fileOf(job.id), maxBytes()); }
    catch (e) {
      if (!(e instanceof TooLarge)) throw e;
      const msg = 'Arquivo maior que ' + Math.round(maxBytes() / 1048576) + ' MB';
      await q("UPDATE device_remote_jobs SET status='failed',finished_at=now(),error=$2 WHERE id=$1", [job.id, msg]);
      return bad(res, 413, msg);
    }
    await q("UPDATE device_remote_jobs SET status='done',finished_at=now(),bytes=$2,sha256=$3,result=$4 WHERE id=$1", [job.id, got.bytes, got.sha256, { received: true }]);
    res.json({ ok: true, bytes: got.bytes, sha256: got.sha256 });
  }));

  app.post('/api/connect/remote/jobs/:id/result', deviceAuth, route(async (req, res) => {
    const job = await running(req, res, null); if (!job) return;
    const v = valid(resultSchema, req, res); if (!v) return;
    if (v.ok && job.kind === 'pull') return bad(res, 409, 'Envie o arquivo em /upload');
    const result = v.ok ? (job.kind === 'list' ? { entries: v.entries || [], truncated: v.truncated === true } : { saved_path: v.saved_path || null }) : null;
    await q('UPDATE device_remote_jobs SET status=$2,finished_at=now(),result=$3,error=$4 WHERE id=$1', [job.id, v.ok ? 'done' : 'failed', result, v.ok ? null : (v.error || 'falhou no computador')]);
    if (job.kind === 'push') unlink(fileOf(job.id));
    res.json({ ok: true });
  }));

  app.get('/api/connect/components', deviceAuth, route(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ components: cameraComponents() });
  }));
}
