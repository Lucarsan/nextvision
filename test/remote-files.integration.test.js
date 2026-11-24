// Arquivos à distância e plano só gestão:
// - central: plano 0 câmera entrega provisionamento sem túnel; sinal de vida guarda o modo e avisa pedidos;
//   listar / enviar / trazer passam pelo PC certo, com validação, permissões e download do arquivo trazido;
// - agente (PowerShell): executa os pedidos de verdade contra a central (pastas do Windows mapeadas para uma pasta temporária)
//   e recusa caminhos protegidos e componentes de endereço não permitido.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createStoreFixture } from './helpers/store-fixture.js';

const MODULE = path.resolve('installer/windows/payload/FicouPronto.psm1');
const ps = (programData, script) => {
  const run = spawnSync(process.env.PWSH_BINARY, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $env:ProgramData='${programData}'; Import-Module '${MODULE}'; ${script}`], { encoding: 'utf8', timeout: 120000 });
  return { status: run.status, out: (run.stdout || '').trim(), err: (run.stderr || '').trim() };
};
// Versão assíncrona: o servidor falso deste processo precisa responder enquanto o PowerShell roda.
const psAsync = async (programData, script) => {
  const child = spawn(process.env.PWSH_BINARY, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $env:ProgramData='${programData}'; Import-Module '${MODULE}'; ${script}`]);
  let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.resume();
  const [status] = await once(child, 'exit'); return { status, out: out.trim() };
};
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

test('central: plano só gestão e arquivos à distância', { skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 90000 }, async () => {
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-remote-'));
  const f = await createStoreFixture({ env: { REMOTE_FILES_DIR: remoteDir, REMOTE_FILES_MAX_MB: '1' } });
  const { api, request, base } = f;
  try {
    await f.db.query('UPDATE tenants SET camera_limit=0 WHERE id=$1', [f.tenant]);
    const code = await api('/master/tenants/' + f.tenant + '/activation-codes', { method: 'POST', token: f.masterToken }, 201);
    const dev = await api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: 'PC caixa' } }, 201);
    const tk = dev.device_token, D = '/master/tenants/' + f.tenant + '/devices/' + dev.id + '/remote';

    // Só gestão: sem Cloudflare configurada e mesmo assim provisiona (sem túnel, sem câmeras).
    const prov = await api('/connect/provision', { method: 'POST', token: tk }, 200);
    assert.deepEqual(prov.plan, { mode: 'management', camera_limit: 0 });
    assert.equal(prov.tunnel, undefined); assert.equal(prov.media, undefined); assert.deepEqual(prov.cameras, []);
    // Câmera não cabe no plano 0.
    const cam = await f.db.query("INSERT INTO cameras(tenant_id,name) VALUES($1,'x') RETURNING id", [f.tenant]).catch(e => e);
    assert.match(String(cam.message), /camera_limit_reached/);

    const beat = () => api('/connect/heartbeat', { method: 'POST', token: tk, body: { agent_version: '0.6.0', mode: 'management', components: { service: { state: 'ok' } } } });
    assert.equal((await beat()).remote_pending, undefined);
    const media = await api('/master/tenants/' + f.tenant + '/media', { token: f.masterToken });
    assert.equal(media.devices[0].install_mode, 'management');

    // Validação e permissões.
    assert.equal((await request(D + '/list', { method: 'POST', token: f.masterToken, body: { path: 'C:\\a\\..\\b' } })).status, 400);
    assert.equal((await request(D + '/list', { method: 'POST', token: f.masterToken, body: { path: '/etc/passwd' } })).status, 400);
    assert.equal((await request(D + '/list', { method: 'POST', token: f.ownerToken, body: { path: 'C:\\' } })).status, 403);
    assert.equal((await request('/master/tenants/' + f.foreignTenant + '/devices/' + dev.id + '/remote', { token: f.masterToken })).status, 404);
    assert.equal((await request('/connect/remote/next', { token: null })).status, 401);

    // Listar.
    const list = await api(D + '/list', { method: 'POST', token: f.masterToken, body: { path: 'C:\\ProgramData\\FicouPronto' } }, 201);
    assert.equal((await beat()).remote_pending, 1);
    const next = async () => { const r = await fetch(base + '/api/connect/remote/next', { headers: { Authorization: 'Bearer ' + tk } }); return r.status === 204 ? null : r.json(); };
    const j1 = await next(); assert.equal(j1.id, list.id); assert.equal(j1.kind, 'list');
    assert.equal(await next(), null, 'pedido em andamento não é entregue de novo');
    await api('/connect/remote/jobs/' + j1.id + '/result', { method: 'POST', token: tk, body: { ok: true, entries: [{ name: 'logs', type: 'dir' }, { name: 'config.json', type: 'file', size: 120 }] } });
    let jobs = (await api(D, { token: f.masterToken })).jobs;
    assert.equal(jobs[0].status, 'done'); assert.equal(jobs[0].result.entries.length, 2);

    // Enviar ao PC (corpo cru), com limite de tamanho.
    const payload = crypto.randomBytes(200000);
    const push = async (buf, q) => fetch(base + '/api' + D + '/push' + q, { method: 'POST', headers: { Authorization: 'Bearer ' + f.masterToken, 'Content-Type': 'application/octet-stream' }, body: buf });
    assert.equal((await push(payload, '?folder=' + encodeURIComponent('C:\\x') + '&name=' + encodeURIComponent('a/b.txt'))).status, 400);
    assert.equal((await push(crypto.randomBytes(1100000), '?folder=' + encodeURIComponent('C:\\x') + '&name=big.bin')).status, 413);
    const pr = await push(payload, '?folder=' + encodeURIComponent('C:\\ProgramData\\FicouPronto\\recebidos') + '&name=' + encodeURIComponent('relatório.pdf'));
    assert.equal(pr.status, 201); const pj = await pr.json();
    assert.equal(pj.bytes, payload.length); assert.equal(pj.sha256, sha(payload));
    const j2 = await next(); assert.equal(j2.id, pj.id); assert.equal(j2.file_name, 'relatório.pdf'); assert.ok(j2.url);
    const got = Buffer.from(await (await fetch(base + j2.url, { headers: { Authorization: 'Bearer ' + tk } })).arrayBuffer());
    assert.equal(sha(got), sha(payload));
    await api('/connect/remote/jobs/' + j2.id + '/result', { method: 'POST', token: tk, body: { ok: true, saved_path: 'C:\\ProgramData\\FicouPronto\\recebidos\\relatório.pdf' } });
    assert.equal(fs.existsSync(path.join(remoteDir, pj.id + '.bin')), false, 'arquivo temporário apagado depois de entregue');

    // Trazer do PC.
    const pull = await api(D + '/pull', { method: 'POST', token: f.masterToken, body: { path: 'C:\\ProgramData\\FicouPronto\\logs\\agente.log' } }, 201);
    const j3 = await next(); assert.equal(j3.id, pull.id); assert.ok(j3.upload_url); assert.equal(j3.max_bytes, 1048576);
    assert.equal((await request('/connect/remote/jobs/' + j3.id + '/result', { method: 'POST', token: tk, body: { ok: true } })).status, 409);
    const log = Buffer.from('linha 1\r\nlinha 2\r\n');
    const up = await fetch(base + j3.upload_url, { method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/octet-stream' }, body: log });
    assert.equal(up.status, 200);
    jobs = (await api(D, { token: f.masterToken })).jobs;
    const done = jobs.find(j => j.id === pull.id); assert.equal(done.status, 'done'); assert.equal(done.file_ready, true);
    const dl = await fetch(base + '/api' + D + '/jobs/' + pull.id + '/file', { headers: { Authorization: 'Bearer ' + f.masterToken } });
    assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition'), /agente\.log/);
    assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), log.toString());

    // Falha relatada pelo PC e cancelamento.
    const bad = await api(D + '/pull', { method: 'POST', token: f.masterToken, body: { path: 'C:\\nao\\existe.txt' } }, 201);
    const j4 = await next(); assert.equal(j4.id, bad.id);
    await api('/connect/remote/jobs/' + j4.id + '/result', { method: 'POST', token: tk, body: { ok: false, error: 'Arquivo nao encontrado no computador.' } });
    const cancel = await api(D + '/list', { method: 'POST', token: f.masterToken, body: { path: 'C:\\' } }, 201);
    assert.equal((await api(D + '/jobs/' + cancel.id, { method: 'DELETE', token: f.masterToken })).status, 'cancelled');
    assert.equal(await next(), null);
    jobs = (await api(D, { token: f.masterToken })).jobs;
    assert.equal(jobs.find(j => j.id === bad.id).error, 'Arquivo nao encontrado no computador.');

    // Arquivo enviado que sumiu do servidor (reinício): o pedido falha com aviso, não trava a fila.
    const lost = await (await push(payload, '?folder=' + encodeURIComponent('C:\\x') + '&name=y.bin')).json();
    fs.unlinkSync(path.join(remoteDir, lost.id + '.bin'));
    assert.equal(await next(), null);
    assert.match((await api(D, { token: f.masterToken })).jobs.find(j => j.id === lost.id).error, /se perdeu/);

    // Pedido vencido some.
    const old = await api(D + '/list', { method: 'POST', token: f.masterToken, body: { path: 'C:\\' } }, 201);
    await f.db.query("UPDATE device_remote_jobs SET expires_at=now()-interval '1 minute' WHERE id=$1", [old.id]);
    assert.equal(await next(), null);
    assert.equal((await api(D, { token: f.masterToken })).jobs.find(j => j.id === old.id).status, 'expired');

    // Lista de componentes para o instalador leve: só GitHub, com SHA-256, sem o WinSW.
    const comp = await api('/connect/components', { token: tk });
    assert.deepEqual(comp.components.map(c => c.name).sort(), ['cloudflared.exe', 'ffmpeg.zip', 'mediamtx.zip']);
    assert.ok(comp.components.every(c => /^https:\/\/github\.com\//.test(c.url) && /^[a-f0-9]{64}$/.test(c.sha256)));

    // Auditoria das ações da central.
    const audit = await f.db.query("SELECT action FROM audit_events WHERE target_id=$1 AND action LIKE 'remote_%'", [dev.id]);
    for (const a of ['remote_list', 'remote_push', 'remote_pull', 'remote_download']) assert.ok(audit.rows.some(r => r.action === a), a);
  } finally { await f.cleanup(); }
});

test('agente: executa listar, receber e enviar arquivo contra a central', {
  skip: process.env.TEST_DATABASE_URL && process.env.PWSH_BINARY ? false : 'Set TEST_DATABASE_URL and PWSH_BINARY', timeout: 120000
}, async () => {
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-remote-'));
  const pcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-pc-'));
  const f = await createStoreFixture({ env: { REMOTE_FILES_DIR: remoteDir } });
  const { api, base } = f;
  try {
    const code = await api('/master/tenants/' + f.tenant + '/activation-codes', { method: 'POST', token: f.masterToken }, 201);
    const dev = await api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: 'PC fundos' } }, 201);
    const tk = dev.device_token, D = '/master/tenants/' + f.tenant + '/devices/' + dev.id + '/remote';
    // "C:\..." no PC simulado = pasta temporária.
    const map = `{ param($p) Join-Path '${pcRoot}' (($p.Substring(3)) -replace '\\\\','/') }`;
    const runNext = () => ps(path.join(pcRoot, 'pd'), `$r = Invoke-FpApi -Base '${base}' -Path '/api/connect/remote/next' -Token '${tk}'; if ($r.Data) { Invoke-FpRemoteJob -Base '${base}' -Token '${tk}' -Job $r.Data -MapPath ${map} } else { 'nenhum' }`);
    fs.mkdirSync(path.join(pcRoot, 'Loja', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(pcRoot, 'Loja', 'docs', 'nota.txt'), 'nota fiscal 123');
    fs.mkdirSync(path.join(pcRoot, 'Loja', 'docs', 'sub'));

    await api(D + '/list', { method: 'POST', token: f.masterToken, body: { path: 'C:\\Loja\\docs' } }, 201);
    let r = runNext(); assert.equal(r.status, 0, r.err); assert.match(r.out, /listou 2/);
    let job = (await api(D, { token: f.masterToken })).jobs[0];
    assert.equal(job.status, 'done');
    assert.deepEqual(job.result.entries.map(e => e.name + ':' + e.type).sort(), ['nota.txt:file', 'sub:dir']);
    assert.equal(job.result.entries.find(e => e.name === 'nota.txt').size, 15);

    const payload = crypto.randomBytes(300000);
    const push = q => fetch(base + '/api' + D + '/push' + q, { method: 'POST', headers: { Authorization: 'Bearer ' + f.masterToken, 'Content-Type': 'application/octet-stream' }, body: payload });
    assert.equal((await push('?folder=' + encodeURIComponent('C:\\Loja\\novos') + '&name=manual.pdf')).status, 201);
    r = runNext(); assert.equal(r.status, 0, r.err); assert.match(r.out, /recebeu C:\\Loja\\novos\\manual\.pdf/);
    assert.equal(sha(fs.readFileSync(path.join(pcRoot, 'Loja', 'novos', 'manual.pdf'))), sha(payload));
    // Mesmo nome sem "substituir": guarda como "manual (2).pdf".
    await push('?folder=' + encodeURIComponent('C:\\Loja\\novos') + '&name=manual.pdf');
    r = runNext(); assert.match(r.out, /manual \(2\)\.pdf/);
    assert.ok(fs.existsSync(path.join(pcRoot, 'Loja', 'novos', 'manual (2).pdf')));
    assert.deepEqual(fs.readdirSync(path.join(pcRoot, 'Loja', 'novos')).filter(n => n.endsWith('.fp-part')), []);

    await api(D + '/pull', { method: 'POST', token: f.masterToken, body: { path: 'C:\\Loja\\docs\\nota.txt' } }, 201);
    r = runNext(); assert.equal(r.status, 0, r.err); assert.match(r.out, /enviou/);
    job = (await api(D, { token: f.masterToken })).jobs[0];
    assert.equal(job.file_ready, true);
    const dl = await fetch(base + '/api' + D + '/jobs/' + job.id + '/file', { headers: { Authorization: 'Bearer ' + f.masterToken } });
    assert.equal(await dl.text(), 'nota fiscal 123');

    await api(D + '/pull', { method: 'POST', token: f.masterToken, body: { path: 'C:\\Loja\\docs\\falta.txt' } }, 201);
    r = runNext(); assert.match(r.out, /falhou: Arquivo nao encontrado/);
    assert.equal((await api(D, { token: f.masterToken })).jobs[0].status, 'failed');
    assert.equal(runNext().out, 'nenhum');
  } finally { await f.cleanup(); }
});

test('agente: caminhos protegidos e componentes só de endereço permitido', { skip: process.env.PWSH_BINARY ? false : 'Set PWSH_BINARY', timeout: 60000 }, async () => {
  const check = ps('C:\\ProgramData', `foreach ($t in @(
      @('C:\\ProgramData\\FicouPronto\\secrets\\agent.dat','read'), @('C:\\ProgramData\\FicouPronto\\logs\\agente.log','read'),
      @('C:\\ProgramData\\FicouPronto\\config.json','write'), @('C:\\ProgramData\\FicouPronto\\services\\FicouPronto.Agente.xml','write'),
      @('C:\\ProgramData\\FicouPronto\\atualizacoes\\x','write'), @('C:\\ProgramData\\FicouPronto\\recebidos\\x.txt','write'),
      @('C:\\PROGRA~1\\FicouPronto\\agent\\x.ps1','write'), @('C:\\a\\..\\b','read'), @('C:\\a\\b.','write'), @('C:\\a:b','read'))) {
    try { [void](Test-FpRemotePath $t[0] $t[1]); 'OK ' + $t[0] } catch { 'NO ' + $t[0] } }`);
  assert.equal(check.status, 0, check.err);
  assert.deepEqual(check.out.split(/\r?\n/), [
    'NO C:\\ProgramData\\FicouPronto\\secrets\\agent.dat', 'OK C:\\ProgramData\\FicouPronto\\logs\\agente.log',
    'NO C:\\ProgramData\\FicouPronto\\config.json', 'NO C:\\ProgramData\\FicouPronto\\services\\FicouPronto.Agente.xml',
    'NO C:\\ProgramData\\FicouPronto\\atualizacoes\\x', 'OK C:\\ProgramData\\FicouPronto\\recebidos\\x.txt',
    'NO C:\\PROGRA~1\\FicouPronto\\agent\\x.ps1', 'NO C:\\a\\..\\b', 'NO C:\\a\\b.', 'NO C:\\a:b']);

  // Central (falsa) mandando baixar de outro endereço: recusa antes de baixar.
  const evil = http.createServer((_q, res) => res.end(JSON.stringify({ components: [
    { name: 'cloudflared.exe', url: 'https://evil.example/cloudflared.exe', sha256: 'a'.repeat(64) },
    { name: 'mediamtx.zip', url: 'https://github.com/bluenviron/mediamtx/releases/download/x.zip', sha256: 'a'.repeat(64) },
    { name: 'ffmpeg.zip', url: 'https://github.com/GyanD/codexffmpeg/releases/download/x.zip', sha256: 'a'.repeat(64) }] })));
  evil.listen(0, '127.0.0.1'); await once(evil, 'listening');
  try {
    const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-comp-'));
    const r = await psAsync(pd, `try { Install-FpCameraComponents -Base 'http://127.0.0.1:${evil.address().port}' -Token 'x' -BinDir '${path.join(pd, 'bin')}'; 'instalou' } catch { $_.Exception.Message }`);
    assert.match(r.out, /Endereco nao permitido para cloudflared\.exe/);
    assert.equal(fs.existsSync(path.join(pd, 'bin', 'cloudflared.exe')), false);
  } finally { evil.close(); }
});
