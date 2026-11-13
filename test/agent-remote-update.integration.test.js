// Atualização remota do agente:
// - central: pedido por computador, entrega no sinal de vida, download só para quem foi pedido, relato do andamento;
// - agente (PowerShell): assinatura/hash do pacote, preparo dos arquivos, atualizador trocando os scripts
//   e desfazendo quando a versão nova não sobe (serviços do Windows simulados).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createStoreFixture } from './helpers/store-fixture.js';
import { buildRelease, agentFiles, publicKeyXml } from '../scripts/agent-release.mjs';

const MODULE = path.resolve('installer/windows/payload/FicouPronto.psm1');
const UPDATER = path.resolve('installer/windows/payload/ficoupronto-updater.ps1');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

// Cópia dos scripts reais com a versão trocada (como o build faria numa versão nova).
function filesAt(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-src-'));
  return agentFiles().map(f => {
    const out = path.join(dir, path.basename(f));
    let text = fs.readFileSync(f, 'utf8');
    if (path.basename(f) === 'FicouPronto.psm1') text = text.replace(/AgentVersion = '[^']+'/, "AgentVersion = '" + version + "'");
    fs.writeFileSync(out, text); return out;
  });
}

function releaseFile(dir, version, files = filesAt(version)) {
  fs.mkdirSync(dir, { recursive: true });
  const env = buildRelease({ privateKey, files, version, notes: 'teste' });
  const file = path.join(dir, version + '.json');
  fs.writeFileSync(file, JSON.stringify(env));
  return { env, file };
}

function pwsh(programData, script) {
  const run = spawnSync(process.env.PWSH_BINARY, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $env:ProgramData='${programData}'; ${script}`], { encoding: 'utf8', timeout: 120000 });
  return { status: run.status, out: (run.stdout || '').trim(), err: (run.stderr || '').trim() };
}

test('central: pede, entrega e acompanha a atualização do agente', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 60000
}, async () => {
  const relDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-rel-'));
  const { file } = releaseFile(relDir, '0.5.2');
  const saved = { ...process.env };
  process.env.AGENT_RELEASES_DIR = relDir;
  const f = await createStoreFixture();
  const { api } = f;
  const get = (url, tk) => fetch(f.base + url, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} });
  try {
    const activate = async (tenant, name) => {
      const code = await api('/master/tenants/' + tenant + '/activation-codes', { method: 'POST', token: f.masterToken }, 201);
      return (await api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: name } }, 201)).device_token;
    };
    const token = await activate(f.tenant, 'PC balcão');
    const other = await activate(f.tenant, 'PC fundos');
    const beat = (tk, version, extra = {}) => api('/connect/heartbeat', { method: 'POST', token: tk, body: { agent_version: version, components: { network: { state: 'ok', detail: 'Wi-Fi "LOJA" - PC 192.168.15.10 - roteador 192.168.15.1' } }, ...extra } });

    const rel = await api('/master/agent-releases', { token: f.masterToken });
    assert.equal(rel.releases[0].version, '0.5.2');
    assert.equal(rel.first_updatable, '0.5.1');

    // Agente antigo (sem atualizador): a central recusa o pedido e não oferece nada.
    assert.equal((await beat(token, '0.5.0')).update, undefined);
    const media0 = await api('/master/tenants/' + f.tenant + '/media', { token: f.masterToken });
    const dev = media0.devices.find(d => d.name === 'PC balcão');
    assert.match(media0.devices.find(d => d.name === 'PC balcão').health.components.network.detail, /LOJA/);
    await api('/master/tenants/' + f.tenant + '/devices/' + dev.id + '/agent-update', { method: 'POST', token: f.masterToken, body: { version: '0.5.2' } }, 409);

    await beat(token, '0.5.1'); await beat(other, '0.5.1');
    assert.equal((await beat(token, '0.5.1')).update, undefined, 'sem pedido, nada é oferecido');
    await api('/master/tenants/' + f.tenant + '/devices/' + dev.id + '/agent-update', { method: 'POST', token: f.masterToken, body: { version: '9.9.9' } }, 404);
    // Lojista não pede atualização.
    await api('/master/tenants/' + f.tenant + '/devices/' + dev.id + '/agent-update', { method: 'POST', token: f.ownerToken, body: { version: '0.5.2' } }, 403);
    const req1 = await api('/master/tenants/' + f.tenant + '/devices/' + dev.id + '/agent-update', { method: 'POST', token: f.masterToken, body: { version: '0.5.2' } });

    const offer = (await beat(token, '0.5.1')).update;
    assert.deepEqual(offer, { version: '0.5.2', request_id: req1.agent_update_request, url: '/api/connect/agent-release/0.5.2' });
    assert.equal((await beat(other, '0.5.1')).update, undefined, 'só o computador pedido recebe');

    const dl = await get(offer.url, token);
    assert.equal(dl.status, 200);
    assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), fs.readFileSync(file, 'utf8'));
    assert.equal((await get(offer.url, other)).status, 403);
    assert.equal((await get(offer.url)).status, 401);

    // Andamento relatado pelo PC; depois de concluída, nada mais é oferecido.
    await beat(token, '0.5.1', { update: { version: '0.5.2', request_id: offer.request_id, state: 'waiting', detail: 'aguardando terminar o atendimento com camera' } });
    let row = (await api('/master/tenants/' + f.tenant + '/media', { token: f.masterToken })).devices.find(d => d.id === dev.id);
    assert.equal(row.agent_update_status.state, 'waiting');
    assert.equal((await beat(token, '0.5.2', { update: { version: '0.5.2', request_id: offer.request_id, state: 'done', detail: 'ok' } })).update, undefined);
    row = (await api('/master/tenants/' + f.tenant + '/media', { token: f.masterToken })).devices.find(d => d.id === dev.id);
    assert.equal(row.agent_version, '0.5.2'); assert.equal(row.agent_update_status.state, 'done');
    await api('/master/tenants/' + f.tenant + '/devices/' + dev.id + '/agent-update', { method: 'POST', token: f.masterToken, body: { version: '0.5.2' } }, 409);

    // Cancelar um pedido para o outro computador.
    const odev = row && (await api('/master/tenants/' + f.tenant + '/media', { token: f.masterToken })).devices.find(d => d.name === 'PC fundos');
    await api('/master/tenants/' + f.tenant + '/devices/' + odev.id + '/agent-update', { method: 'POST', token: f.masterToken, body: { version: '0.5.2' } });
    assert.ok((await beat(other, '0.5.1')).update);
    await api('/master/tenants/' + f.tenant + '/devices/' + odev.id + '/agent-update', { method: 'DELETE', token: f.masterToken });
    assert.equal((await beat(other, '0.5.1')).update, undefined);
  } finally {
    await f.cleanup();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('agente: confere o pacote e o atualizador troca ou desfaz', {
  skip: process.env.PWSH_BINARY ? false : 'Set PWSH_BINARY', timeout: 180000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-upd-'));
  const programData = path.join(root, 'ProgramData');
  fs.mkdirSync(path.join(programData, 'FicouPronto', 'logs'), { recursive: true });
  const keyXml = publicKeyXml(publicKey);
  const { file } = releaseFile(path.join(root, 'rel'), '0.5.2');
  const load = `Import-Module '${MODULE}' -Force; $e = Get-Content -Raw '${file}' | ConvertFrom-Json`;

  // Assinatura certa: aceita e prepara os arquivos com o mesmo conteúdo.
  let r = pwsh(programData, `${load}; $m = Test-FpAgentRelease $e '0.5.2' '${keyXml}'; $d = Save-FpAgentReleaseStage $m; (Get-ChildItem $d | Measure-Object).Count`);
  assert.equal(r.status, 0, r.err);
  assert.equal(Number(r.out), agentFiles().length);
  const stage = path.join(programData, 'FicouPronto', 'atualizacoes', '0.5.2', 'arquivos');
  for (const f of agentFiles()) if (path.basename(f) !== 'FicouPronto.psm1') assert.deepEqual(fs.readFileSync(path.join(stage, path.basename(f))), fs.readFileSync(f));
  assert.match(fs.readFileSync(path.join(stage, 'FicouPronto.psm1'), 'utf8'), /AgentVersion = '0\.5\.2'/);

  // Recusas: chave que o agente confia (outra), versão diferente, conteúdo alterado.
  r = pwsh(programData, `${load}; Test-FpAgentRelease $e '0.5.2'`); assert.notEqual(r.status, 0); assert.match(r.err + r.out, /assinatura invalida/);
  r = pwsh(programData, `${load}; Test-FpAgentRelease $e '0.5.3' '${keyXml}'`); assert.notEqual(r.status, 0); assert.match(r.err + r.out, /diferente da pedida/);
  const wrong = releaseFile(path.join(root, 'rel2'), '0.5.3', filesAt('0.5.2')).file;
  r = pwsh(programData, `Import-Module '${MODULE}' -Force; Test-FpAgentRelease (Get-Content -Raw '${wrong}' | ConvertFrom-Json) '0.5.3' '${keyXml}'`);
  assert.notEqual(r.status, 0); assert.match(r.err + r.out, /versao do modulo diferente/);
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tampered = JSON.parse(Buffer.from(env.payload, 'base64').toString()); tampered.files[0].content = Buffer.from('Write-Output 1').toString('base64');
  fs.writeFileSync(path.join(root, 't.json'), JSON.stringify({ ...env, payload: Buffer.from(JSON.stringify(tampered)).toString('base64') }));
  r = pwsh(programData, `Import-Module '${MODULE}' -Force; Test-FpAgentRelease (Get-Content -Raw '${path.join(root, 't.json')}' | ConvertFrom-Json) '0.5.2' '${keyXml}'`);
  assert.notEqual(r.status, 0); assert.match(r.err + r.out, /assinatura invalida/);

  // Atualizador com serviços simulados: "Start-Service" faz o agente instalado escrever status.json
  // com a versão do FicouPronto.psm1 que está na pasta; se houver quebrado.ps1, o agente "não sobe".
  const install = path.join(root, 'Program Files', 'FicouPronto');
  const agentDir = path.join(install, 'agent');
  const resetAgent = () => {
    fs.rmSync(agentDir, { recursive: true, force: true }); fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'FicouPronto.psm1'), "$script:AgentVersion = '0.5.1'\n");
    fs.writeFileSync(path.join(agentDir, 'ficoupronto-agent.ps1'), '# antigo\n');
    fs.writeFileSync(path.join(programData, 'FicouPronto', 'status.json'), JSON.stringify({ observed_at: new Date().toISOString(), version: '0.5.1', cameras: [{ id: 'c1', state: 'ok' }] }));
  };
  const mocks = `
    $global:svc = 'Running'
    function global:Get-Service { param($Name, $ErrorAction) [pscustomobject]@{ Name = $Name; Status = $global:svc } }
    function global:Stop-Service { param($Name, [switch]$Force, $ErrorAction) $global:svc = 'Stopped' }
    function global:Start-Service {
      param($Name, $ErrorAction)
      $global:svc = 'Running'
      $dir = '${agentDir}'
      if (Test-Path (Join-Path $dir 'quebrado.ps1')) { return }
      $v = [regex]::Match((Get-Content -Raw (Join-Path $dir 'FicouPronto.psm1')), "AgentVersion = '([^']+)'").Groups[1].Value
      $st = @{ observed_at = [datetime]::UtcNow.ToString('o'); version = $v; cameras = @(@{ id = 'c1'; state = 'ok' }) }
      [IO.File]::WriteAllText((Join-Path $env:ProgramData 'FicouPronto\\status.json'), ($st | ConvertTo-Json -Compress))
    }`;
  const runUpdater = (version, rid) => pwsh(programData, `${mocks}; & '${UPDATER}' -Version ${version} -RequestId ${rid} -InstallDir '${install}' -VerifySeconds 8`);
  const state = () => JSON.parse(fs.readFileSync(path.join(programData, 'FicouPronto', 'atualizacoes', 'estado.json'), 'utf8'));

  // 1) Troca bem-sucedida: scripts novos na pasta, estado "done".
  resetAgent();
  const rid = crypto.randomUUID();
  r = runUpdater('0.5.2', rid);
  assert.equal(r.status, 0, r.err + r.out);
  let s = state(); assert.equal(s.state, 'done'); assert.equal(s.version, '0.5.2'); assert.equal(s.request_id, rid); assert.equal(s.from, '0.5.1');
  assert.deepEqual(fs.readFileSync(path.join(agentDir, 'ficoupronto-agent.ps1')), fs.readFileSync(path.join(stage, 'ficoupronto-agent.ps1')));

  // 2) Versão nova não sobe: volta exatamente aos scripts anteriores, estado "rolled_back".
  resetAgent();
  fs.writeFileSync(path.join(stage, 'quebrado.ps1'), '# nao sobe\n');
  r = runUpdater('0.5.2', rid);
  assert.equal(r.status, 1);
  s = state(); assert.equal(s.state, 'rolled_back'); assert.match(s.detail, /voltou para 0\.5\.1/);
  assert.deepEqual(fs.readdirSync(agentDir).sort(), ['FicouPronto.psm1', 'ficoupronto-agent.ps1']);
  assert.equal(fs.readFileSync(path.join(agentDir, 'ficoupronto-agent.ps1'), 'utf8'), '# antigo\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(programData, 'FicouPronto', 'status.json'), 'utf8')).version, '0.5.1');

  // 3) Pacote não preparado: nada é tocado.
  resetAgent();
  r = runUpdater('0.6.0', rid);
  assert.equal(r.status, 1); s = state(); assert.equal(s.state, 'failed'); assert.match(s.detail, /nao preparado/);
  assert.equal(fs.readFileSync(path.join(agentDir, 'ficoupronto-agent.ps1'), 'utf8'), '# antigo\n');
});

test('central: painel mostra a rede do PC e pede a atualização', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const relDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-rel-'));
  releaseFile(relDir, '0.5.2');
  const saved = { ...process.env };
  process.env.AGENT_RELEASES_DIR = relDir;
  const f = await createStoreFixture(); let browser;
  try {
    const code = await f.api('/master/tenants/' + f.tenant + '/activation-codes', { method: 'POST', token: f.masterToken }, 201);
    const token = (await f.api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: 'pc balcao' } }, 201)).device_token;
    await f.api('/connect/heartbeat', { method: 'POST', token, body: { agent_version: '0.5.1', components: { network: { state: 'ok', detail: 'Wi-Fi "ALEPETS" - PC 192.168.15.10 - roteador 192.168.15.1' } }, cameras: [] } });
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.masterToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(f.base + '/central.html');
    await page.locator('.ct-nav-btn[data-page="Dispositivos"]').click();
    await page.locator('#deviceTenant').selectOption(f.tenant);
    await page.waitForFunction(() => /Atualizar para 0\.5\.2/.test(document.body.innerText));
    let text = await page.locator('body').innerText();
    assert.match(text, /Rede: OK \(Wi-Fi "ALEPETS" - PC 192\.168\.15\.10 - roteador 192\.168\.15\.1\)/);
    if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/central-atualizacao-agente.png', fullPage: true });
    await page.locator('[data-upd-go]').click();
    await page.waitForFunction(() => /Pedida: 0\.5\.2/.test(document.body.innerText));
    const beat = await f.api('/connect/heartbeat', { method: 'POST', token, body: { agent_version: '0.5.1', cameras: [] } });
    assert.equal(beat.update.version, '0.5.2');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await f.cleanup();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
