// Monitoramento da plataforma: confere banco (Neon), servidor (Render), domínio, certificados,
// endereço público, computadores/câmeras das lojas, backups, cobranças, suporte e erros do servidor.
// Cada problema vira um alerta com gravidade (info / warn / critical), guardado em platform_alerts.
//
// Avisos:
//  - critical: Telegram + e-mail na hora; repete no Telegram a cada 4 h enquanto aberto (até "Ciente").
//  - warn: Telegram na hora (só no expediente; à noite espera a manhã).
//  - info: só no painel e no resumo diário.
//  - resolvido (de warn/critical já avisado): Telegram.
//  - Resumo diário por e-mail + Telegram na primeira rodada após as 7h.
// Fora do expediente (horário de silêncio) só rodam as verificações que não usam o banco, de hora
// em hora, e só avisam o que for crítico — para o banco continuar dormindo.
//
// Variáveis: NEON_API_KEY, NEON_PROJECT_ID (opcional se a conta tiver 1 projeto), NEON_CU_HOURS_LIMIT
// (100 no grátis; 0 = plano pago, passa a vigiar custo), NEON_MONTHLY_BUDGET_USD, RENDER_API_KEY
// (RENDER_SERVICE_ID o Render já define), TELEGRAM_BOT_TOKEN, MONITOR_DOMAINS, MONITOR_HOSTS.
import tls from 'node:tls';
import { backgroundAllowed, isOpen, localClock } from './quiet-hours.js';
import { emailConfigured, sendEmail } from './reports.js';
import { listReleases, compareVersions } from './agent-releases.js';

const RANK = { info: 0, warn: 1, critical: 2 };
const UA = 'FicouPronto-Monitor/1.0 (+https://ficoupronto.com)';
const DAY = 86400000, HOUR = 3600000;
const TZ = 'America/Fortaleza';
const env = () => process.env;
const fmtDate = d => new Date(d).toLocaleDateString('pt-BR', { timeZone: TZ });
const fmtDay = d => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }); // datas de cobrança/cota (meia-noite UTC)
const fmtDT = d => new Date(d).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const pct = (a, b) => b ? Math.round(a * 1000 / b) / 10 : 0;
const alert = (key, severity, category, title, detail = '', tenant_id = null) => ({ key, severity, category, title, detail, tenant_id });

async function getJson(url, headers = {}, timeout = 15000) {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  if (!r.ok) { const e = Error('HTTP ' + r.status + (json?.message ? ' — ' + String(json.message).slice(0, 160) : '')); e.status = r.status; throw e; }
  return json;
}

// ---------- erros do próprio servidor (contados em memória) ----------
const errors = { http5xx: [], db: [] };
const DB_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '53300', 'XX000']);
export function recordServerError(err) {
  const now = Date.now(); errors.http5xx.push(now);
  if (err && (DB_CODES.has(err.code) || /timeout exceeded|Connection terminated/i.test(err.message || ''))) errors.db.push(now);
  for (const k of Object.keys(errors)) while (errors[k].length && now - errors[k][0] > HOUR) errors[k].shift();
}

// ---------- verificações sem banco ----------
export async function checkNeon(now = new Date()) {
  const e = env(), items = [];
  if (!e.NEON_API_KEY) return { items: [alert('neon.config', 'info', 'banco', 'Consumo do banco não monitorado', 'Falta a chave NEON_API_KEY no Render. Sem ela, só o tamanho do banco é conferido.')], metrics: { configured: false } };
  const H = { Authorization: 'Bearer ' + e.NEON_API_KEY };
  const base = 'https://console.neon.tech/api/v2';
  let id = e.NEON_PROJECT_ID;
  if (!id) id = state.neonProject || null;
  if (!id) {
    // Chave pessoal em conta com organização: o Neon exige org_id para listar projetos.
    let projects = [];
    try { projects = (await getJson(base + '/projects?limit=10', H))?.projects || []; }
    catch (err) {
      if (err.status !== 400) throw err;
      const orgs = (await getJson(base + '/users/me/organizations', H))?.organizations || [];
      for (const o of orgs) projects.push(...((await getJson(base + '/projects?limit=10&org_id=' + encodeURIComponent(o.id), H))?.projects || []));
    }
    id = projects.length === 1 ? projects[0].id : null;
    if (id) state.neonProject = id;
  }
  if (!id) return { items: [alert('neon.config', 'warn', 'banco', 'Projeto do Neon não identificado', 'Defina NEON_PROJECT_ID no Render (a chave não mostrou exatamente um projeto).')], metrics: { configured: false, error: 'projeto não identificado (defina NEON_PROJECT_ID)' } };
  const p = (await getJson(base + '/projects/' + id, H))?.project || {};
  const cu = Number(p.default_endpoint_settings?.autoscaling_limit_max_cu) || 0.25;
  const usedH = Math.round((Number(p.active_time) || 0) * cu / 36) / 100; // CU-hora
  const start = new Date(p.consumption_period_start || Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(p.quota_reset_at || p.consumption_period_end || Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  // Ritmo: pela leitura diária mais antiga com 24 h+ dentro do período (reflete mudanças recentes);
  // sem leituras ainda, média do período.
  const samples = (state.neonSamples || []).filter(x => x.at >= start.getTime() && now - x.at >= DAY && x.h <= usedH);
  const ref = samples.sort((a, b) => a.at - b.at)[0];
  const ratePerMs = ref ? (usedH - ref.h) / (now - ref.at) : usedH / Math.max(HOUR, now - start);
  const projected = Math.round((usedH + ratePerMs * Math.max(0, end - now)) * 10) / 10;
  const limit = e.NEON_CU_HOURS_LIMIT === undefined || e.NEON_CU_HOURS_LIMIT === '' ? 100 : Number(e.NEON_CU_HOURS_LIMIT);
  const storage = Number(p.synthetic_storage_size) || 0, storageLimit = Number(p.branch_logical_size_limit_bytes) || 1073741824;
  const metrics = { configured: true, project: id, rate_basis: ref ? 'recent' : 'period', cu_hours_per_day: Math.round(ratePerMs * DAY * 100) / 100, cu_hours: usedH, limit, percent: limit ? pct(usedH, limit) : null, projected, period_end: end.toISOString(), storage_bytes: storage, storage_limit_bytes: storageLimit, compute_last_active_at: p.compute_last_active_at || null };
  if (limit > 0) {
    const p100 = metrics.percent, left = limit - usedH;
    const runOut = ratePerMs > 0 ? new Date(now.getTime() + left / ratePerMs) : null;
    metrics.runs_out_at = runOut && runOut < end ? runOut.toISOString() : null;
    if (p100 >= 70 || (runOut && runOut < end)) {
      const daysLeft = runOut ? (runOut - now) / DAY : 99;
      const sev = p100 >= 85 || daysLeft <= 3 ? 'critical' : 'warn';
      const when = runOut && runOut < end ? ' No ritmo atual (' + metrics.cu_hours_per_day + ' CU-h/dia) acaba por volta de ' + fmtDate(runOut) + '; a cota renova em ' + fmtDay(end) + '. Ao acabar, o banco PARA e o sistema sai do ar.' : '';
      items.push(alert('neon.compute', sev, 'banco', 'Banco: ' + p100 + '% da cota mensal usada', usedH + ' de ' + limit + ' CU-hora.' + when + ' Solução: plano Launch do Neon (paga por uso).'));
    }
  } else {
    const price = Number(e.NEON_CU_HOUR_PRICE) || 0.106, budget = Number(e.NEON_MONTHLY_BUDGET_USD) || 15;
    metrics.cost_usd = Math.round(usedH * price * 100) / 100; metrics.projected_cost_usd = Math.round(projected * price * 100) / 100; metrics.budget_usd = budget;
    if (metrics.projected_cost_usd > budget) items.push(alert('neon.cost', metrics.projected_cost_usd > budget * 1.5 ? 'critical' : 'warn', 'banco', 'Banco: custo previsto US$ ' + metrics.projected_cost_usd + ' no mês', 'Orçamento: US$ ' + budget + '. Já gasto: US$ ' + metrics.cost_usd + '. Veja o que mantém o banco acordado.'));
  }
  const sp = pct(storage, storageLimit);
  if (sp >= 70) items.push(alert('neon.storage', sp >= 90 ? 'critical' : 'warn', 'banco', 'Banco: ' + sp + '% do espaço usado', Math.round(storage / 1048576) + ' MB de ' + Math.round(storageLimit / 1048576) + ' MB. Cheio, o banco para de aceitar dados.'));
  return { items, metrics };
}

export async function checkRender() {
  const e = env();
  if (!e.RENDER_API_KEY) return { items: [alert('render.config', 'info', 'servidor', 'Servidor (Render) não monitorado', 'Falta a chave RENDER_API_KEY no Render: sem ela não dá para avisar de publicação com falha ou serviço suspenso.')], metrics: { configured: false } };
  const H = { Authorization: 'Bearer ' + e.RENDER_API_KEY }, base = 'https://api.render.com/v1', items = [];
  const id = e.RENDER_SERVICE_ID;
  if (!id) return { items: [alert('render.config', 'info', 'servidor', 'Serviço do Render não identificado', 'RENDER_SERVICE_ID não está definido (só existe rodando no Render).')], metrics: { configured: false } };
  const svc = await getJson(base + '/services/' + id, H);
  const deploys = await getJson(base + '/services/' + id + '/deploys?limit=5', H);
  const list = (deploys || []).map(d => d.deploy || d);
  const last = list[0] || {}, live = list.find(d => d.status === 'live');
  const plan = svc?.serviceDetails?.plan || '';
  const metrics = { configured: true, name: svc?.name, plan, suspended: svc?.suspended, last_deploy: { status: last.status, at: last.finishedAt || last.createdAt, commit: (last.commit?.id || '').slice(0, 7), message: (last.commit?.message || '').split('\n')[0].slice(0, 120) }, live_commit: (live?.commit?.id || '').slice(0, 7) };
  if (svc?.suspended && svc.suspended !== 'not_suspended') items.push(alert('render.suspended', 'critical', 'servidor', 'Servidor suspenso no Render', 'O site está fora do ar. Motivo: ' + (svc.suspenders || []).join(', ')));
  if (/failed/.test(last.status || '')) items.push(alert('render.deploy', 'critical', 'servidor', 'Publicação falhou no Render', 'A última versão (' + metrics.last_deploy.commit + ' — ' + metrics.last_deploy.message + ') não entrou no ar; o site segue na anterior (' + metrics.live_commit + ').'));
  if (plan === 'free') {
    let freeServices = 1;
    try { const all = await getJson(base + '/services?limit=50', H); freeServices = (all || []).map(s => s.service || s).filter(s => s.serviceDetails?.plan === 'free' && s.suspended === 'not_suspended' && s.type === 'web_service').length || 1; } catch { /* sem lista: assume só este */ }
    metrics.free_services = freeServices;
    items.push(alert('render.free', freeServices > 1 ? 'warn' : 'info', 'servidor', 'Servidor no plano grátis do Render',
      'O plano grátis tem 750 h/mês somando todos os serviços grátis da conta (hoje: ' + freeServices + '). O FicouPronto fica ligado o mês todo (~730 h), porque os computadores das lojas mandam sinal de vida. ' + (freeServices > 1 ? 'Com outros serviços grátis ativos, as horas podem acabar e o Render suspende tudo até o mês seguinte. ' : '') + 'Para lojas pagantes, o plano Starter (US$ 7/mês) não tem esse limite nem demora para acordar.'));
  }
  return { items, metrics };
}

// Servidor RDAP oficial de cada terminação (.com → Verisign, .br → Registro.br), pela lista da IANA.
let rdapBootstrap = { at: 0, services: [] };
async function rdapServer(domain) {
  const tld = domain.split('.').pop().toLowerCase();
  if (Date.now() - rdapBootstrap.at > DAY) {
    const j = await getJson('https://data.iana.org/rdap/dns.json', { 'User-Agent': UA });
    rdapBootstrap = { at: Date.now(), services: j?.services || [] };
  }
  const svc = rdapBootstrap.services.find(([tlds]) => tlds.includes(tld));
  if (!svc) throw Error('sem servidor RDAP para .' + tld);
  return svc[1][0].replace(/\/?$/, '/');
}
export async function checkDomain(domain, now = new Date()) {
  const j = await getJson((await rdapServer(domain)) + 'domain/' + encodeURIComponent(domain), { 'User-Agent': UA, Accept: 'application/rdap+json' });
  const exp = (j?.events || []).find(x => x.eventAction === 'expiration')?.eventDate;
  const status = (j?.status || []).join(', ');
  const registrar = ((j?.entities || []).find(x => (x.roles || []).includes('registrar'))?.vcardArray?.[1] || []).find(v => v[0] === 'fn')?.[3] || '';
  const days = exp ? Math.floor((new Date(exp) - now) / DAY) : null;
  const items = [];
  if (/redemption|pending delete|client hold|server hold/i.test(status)) items.push(alert('domain.status.' + domain, 'critical', 'domínio', 'Domínio ' + domain + ' bloqueado ou vencido', 'Situação no registro: ' + status + '. O site e os links das lojas param de funcionar.'));
  else if (days != null && days <= 60) items.push(alert('domain.expiry.' + domain, days <= 7 ? 'critical' : days <= 30 ? 'warn' : 'info', 'domínio', 'Domínio ' + domain + ' vence em ' + days + ' dia(s)', 'Vencimento: ' + fmtDate(exp) + (registrar ? ' · Registrado em ' + registrar : '') + '. Confira se a renovação automática e o cartão estão em dia.'));
  return { items, metrics: { domain, expires_at: exp || null, days, registrar, status } };
}

export function checkCertificate(host, now = new Date()) {
  return new Promise(resolve => {
    const done = (items, metrics) => { try { socket.destroy(); } catch { /* fechado */ } resolve({ items, metrics }); };
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate(); const to = cert?.valid_to ? new Date(cert.valid_to) : null;
      const days = to ? Math.floor((to - now) / DAY) : null, items = [];
      if (!socket.authorized) items.push(alert('tls.invalid.' + host, 'critical', 'certificado', 'Certificado inválido em ' + host, 'Navegadores mostram "não seguro": ' + (socket.authorizationError || 'erro')));
      else if (days != null && days <= 20) items.push(alert('tls.expiry.' + host, days <= 7 ? 'critical' : 'warn', 'certificado', 'Certificado de ' + host + ' vence em ' + days + ' dia(s)', 'Normalmente a Cloudflare/Render renovam sozinhas; se chegou aqui, a renovação está falhando.'));
      done(items, { host, valid_to: to?.toISOString() || null, days });
    });
    socket.on('timeout', () => done([alert('tls.down.' + host, 'critical', 'site', host + ' não responde', 'Sem conexão segura na porta 443.')], { host, error: 'timeout' }));
    socket.on('error', err => done([alert('tls.down.' + host, 'critical', 'site', host + ' não responde', 'Erro: ' + (err.code || err.message))], { host, error: err.code || err.message }));
  });
}

async function checkPublicSite() {
  const base = (env().PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) return { items: [], metrics: {} };
  const t0 = Date.now();
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(15000) });
    const ms = Date.now() - t0;
    if (!r.ok) return { items: [alert('site.public', 'critical', 'site', 'Endereço público respondendo com erro ' + r.status, base + ' — o servidor está de pé, mas quem acessa pelo endereço recebe erro (DNS/Cloudflare).')], metrics: { url: base, status: r.status, ms } };
    return { items: ms > 8000 ? [alert('site.slow', 'warn', 'site', 'Site lento: ' + Math.round(ms / 100) / 10 + ' s para responder', base)] : [], metrics: { url: base, status: r.status, ms } };
  } catch (err) { return { items: [alert('site.public', 'critical', 'site', 'Endereço público não responde', base + ' — ' + (err.name === 'TimeoutError' ? 'tempo esgotado' : err.message))], metrics: { url: base, error: err.message } }; }
}

function checkProcess() {
  const rss = process.memoryUsage().rss, items = [];
  const limitMb = Number(env().MEMORY_LIMIT_MB) || 512, mb = Math.round(rss / 1048576);
  if (mb > limitMb * 0.85) items.push(alert('server.memory', mb > limitMb * 0.95 ? 'critical' : 'warn', 'servidor', 'Servidor com pouca memória: ' + mb + ' de ' + limitMb + ' MB', 'Perto do limite o Render reinicia o servidor (cai por alguns segundos).'));
  if (errors.db.length >= 5) items.push(alert('server.db_errors', 'critical', 'banco', 'Falhas de conexão com o banco: ' + errors.db.length + ' na última hora', 'Pode ser o banco suspenso (cota) ou instabilidade do Neon.'));
  if (errors.http5xx.length >= 20) items.push(alert('server.errors', 'warn', 'servidor', errors.http5xx.length + ' erros internos na última hora', 'Lojas/clientes estão vendo "Erro interno". Veja os logs no Render.'));
  return { items, metrics: { memory_mb: mb, memory_limit_mb: limitMb, uptime_s: Math.round(process.uptime()), errors_1h: errors.http5xx.length, db_errors_1h: errors.db.length, commit: (env().RENDER_GIT_COMMIT || '').slice(0, 7) } };
}

function configItems() {
  const e = env(), items = [];
  if (!e.TELEGRAM_BOT_TOKEN) items.push(alert('alerts.telegram', 'warn', 'avisos', 'Avisos pelo Telegram não configurados', 'Crie o bot e coloque TELEGRAM_BOT_TOKEN no Render; depois conecte em Monitoramento.'));
  if (!emailConfigured()) items.push(alert('alerts.email', 'info', 'avisos', 'Envio de e-mail não configurado', 'Faltam RESEND_API_KEY e EMAIL_FROM no Render (também usados nos relatórios das lojas).'));
  if (!e.STORE_BACKUP_KEY) items.push(alert('config.backup_key', 'warn', 'configuração', 'Backup das lojas sem chave', 'STORE_BACKUP_KEY não definida: os backups no PC das lojas não são gerados.'));
  return items;
}

const domainCache = new Map();
// Lista de verificações que não tocam no banco (podem rodar a noite toda).
async function externalChecks(now) {
  const e = env();
  const domains = (e.MONITOR_DOMAINS ?? 'ficoupronto.com').split(',').map(s => s.trim()).filter(Boolean);
  const hosts = [...new Set([...(e.MONITOR_HOSTS || '').split(','), (e.PUBLIC_BASE_URL || '').replace(/^https:\/\//, '').replace(/[/:].*$/, '')].map(s => s.trim()).filter(Boolean))];
  const failed = new Set();
  // Falha passageira de uma API não pode "resolver" os alertas dela: a categoria fica de fora da rodada.
  const safe = (category, fn) => fn().catch(err => { failed.add(category); return { items: [alert('check.' + category, 'info', 'verificação', 'Não foi possível conferir: ' + category, err.message)], metrics: { error: err.message } }; });
  const domainCached = d => { const c = domainCache.get(d); if (c && now - c.at < 12 * HOUR) return Promise.resolve(c.r); return checkDomain(d, now).then(r => { domainCache.set(d, { at: now.getTime(), r }); return r; }); };
  const [neon, render, site, ...rest] = await Promise.all([safe('banco', () => checkNeon(now)), safe('servidor', () => checkRender()), safe('site', () => checkPublicSite()),
    ...domains.map(d => safe('domínio', () => domainCached(d))), ...hosts.map(h => checkCertificate(h, now))]);
  const proc = checkProcess();
  const doms = rest.slice(0, domains.length), certs = rest.slice(domains.length);
  return {
    failed,
    items: [...neon.items, ...render.items, ...site.items, ...doms.flatMap(x => x.items), ...certs.flatMap(x => x.items), ...proc.items, ...configItems()],
    metrics: { neon: neon.metrics, render: render.metrics, site: site.metrics, domains: doms.map(x => x.metrics), certificates: certs.map(x => x.metrics), server: proc.metrics }
  };
}

// ---------- verificações com banco ----------
const DISK = /([\d.,]+)\s*GB/i;
export async function dbChecks(q, now = new Date(), { awakeMinutes = 999 } = {}) {
  const items = [], metrics = {};
  const size = (await q('SELECT pg_database_size(current_database())::bigint b')).rows[0].b;
  metrics.db_size_mb = Math.round(Number(size) / 1048576);
  const devs = (await q(`SELECT d.id,d.name,d.tenant_id,t.name store,d.last_seen_at,d.health,d.health_at,d.agent_version,d.agent_update_status
    FROM shop_devices d JOIN tenants t ON t.id=d.tenant_id
    WHERE d.enabled AND d.revoked_at IS NULL AND t.status IN ('trial','active')`)).rows;
  const open = isOpen(now);
  const latest = (listReleases() || []).map(r => r.version).sort(compareVersions).pop() || null;
  let online = 0;
  for (const d of devs) {
    const who = d.store + ' · ' + d.name;
    const age = d.last_seen_at ? (now - new Date(d.last_seen_at)) / 60000 : null;
    if (age != null && age <= 15) online++;
    // Só depois de 15 min acordado: de manhã o "visto por último" ainda é o da véspera.
    if (open && awakeMinutes >= 15 && age != null && age > 15) items.push(alert('device.offline.' + d.id, 'critical', 'lojas', 'Computador da loja sem sinal: ' + who, 'Último sinal: ' + fmtDT(d.last_seen_at) + '. Sem ele não há vídeo nem gravação nessa loja. Ver: PC desligado, sem internet ou serviço parado.', d.tenant_id));
    const fresh = d.health_at && now - new Date(d.health_at) < 15 * 60000;
    if (!fresh || !d.health) continue;
    const c = d.health.components || {};
    for (const [k, label] of [['tunnel', 'túnel do vídeo'], ['relay', 'servidor de vídeo local'], ['publisher', 'envio das câmeras'], ['network', 'rede']]) {
      if (c[k]?.state === 'down') items.push(alert('device.' + k + '.' + d.id, k === 'publisher' || k === 'tunnel' ? 'critical' : 'warn', 'lojas', who + ': ' + label + ' parado', c[k].detail || 'O agente tenta se recuperar sozinho; se continuar, acesso remoto.', d.tenant_id));
      else if (c[k]?.state === 'degraded') items.push(alert('device.' + k + '.' + d.id, 'warn', 'lojas', who + ': ' + label + ' instável', c[k].detail || '', d.tenant_id));
    }
    for (const cam of d.health.cameras || []) if (cam.state && cam.state !== 'ok') items.push(alert('camera.' + cam.id, 'warn', 'lojas', who + ': câmera sem imagem', cam.detail || cam.state, d.tenant_id));
    const gb = Number(String(c.disk?.detail || '').match(DISK)?.[1]?.replace(',', '.'));
    if (Number.isFinite(gb) && gb < 5) items.push(alert('device.disk.' + d.id, gb < 2 ? 'critical' : 'warn', 'lojas', who + ': disco quase cheio (' + gb + ' GB livres)', 'Com o disco cheio, as gravações param.', d.tenant_id));
    if (c.backup && c.backup.state && !['ok', 'unknown'].includes(c.backup.state)) items.push(alert('device.backup.' + d.id, 'warn', 'lojas', who + ': backup da loja com problema', c.backup.detail || c.backup.state, d.tenant_id));
    if (Math.abs(Number(d.health.clock_skew_ms) || 0) > 5 * 60000) items.push(alert('device.clock.' + d.id, 'warn', 'lojas', who + ': relógio do PC errado', 'Diferença de ' + Math.round(Math.abs(d.health.clock_skew_ms) / 60000) + ' min; atrapalha gravações e horários.', d.tenant_id));
    const ust = d.agent_update_status?.state;
    if (['failed', 'rolled_back'].includes(ust)) items.push(alert('device.update.' + d.id, 'warn', 'lojas', who + ': atualização do agente ' + (ust === 'failed' ? 'falhou' : 'foi desfeita'), d.agent_update_status.detail || '', d.tenant_id));
    else if (latest && d.agent_version && compareVersions(d.agent_version, latest) < 0) items.push(alert('device.version.' + d.id, 'info', 'lojas', who + ': agente ' + d.agent_version + ' (atual: ' + latest + ')', 'Atualize pela central em Dispositivos, fora do horário de atendimento.', d.tenant_id));
  }
  metrics.devices = { total: devs.length, online, latest_agent: latest };
  const inv = (await q(`SELECT i.tenant_id,t.name,count(*)::int n,min(i.due_date) due,sum(i.amount_cents)::int cents FROM invoices i JOIN tenants t ON t.id=i.tenant_id
    WHERE i.status IN ('open','overdue') AND i.due_date < (now() AT TIME ZONE '${TZ}')::date GROUP BY 1,2`)).rows;
  for (const r of inv) items.push(alert('billing.overdue.' + r.tenant_id, 'warn', 'cobrança', r.name + ': ' + r.n + ' fatura(s) vencida(s)', 'Desde ' + fmtDate(r.due) + ' · R$ ' + (r.cents / 100).toFixed(2).replace('.', ','), r.tenant_id));
  const tickets = (await q(`SELECT s.number,s.subject,s.created_at,t.name,s.tenant_id FROM support_tickets s JOIN tenants t ON t.id=s.tenant_id WHERE s.status='open' ORDER BY s.created_at`)).rows;
  for (const s of tickets) { const h = (now - new Date(s.created_at)) / HOUR; items.push(alert('support.' + s.number, h > 24 ? 'warn' : 'info', 'suporte', 'Chamado #' + s.number + ' de ' + s.name + (h > 24 ? ' sem resposta há ' + Math.floor(h) + ' h' : ' aberto'), s.subject, s.tenant_id)); }
  const rep = (await q(`SELECT r.kind,r.error,t.name,r.tenant_id FROM report_runs r JOIN tenants t ON t.id=r.tenant_id WHERE r.status='error' AND r.updated_at > now() - interval '3 days'`)).rows;
  for (const r of rep) items.push(alert('reports.' + r.tenant_id + '.' + r.kind, 'warn', 'relatórios', 'Relatório ' + r.kind + ' de ' + r.name + ' não foi enviado', r.error || '', r.tenant_id));
  const plans = (await q(`SELECT t.id,t.name,t.camera_limit,(SELECT count(*)::int FROM cameras c WHERE c.tenant_id=t.id AND c.deleted_at IS NULL) cams FROM tenants t WHERE t.status IN ('trial','active')`)).rows;
  for (const t of plans) if (t.camera_limit && t.cams >= t.camera_limit) items.push(alert('plan.limit.' + t.id, 'info', 'lojas', t.name + ': usando todas as câmeras do plano (' + t.cams + '/' + t.camera_limit + ')', 'Oportunidade de ampliação.', t.id));
  return { items, metrics };
}

// ---------- motor ----------
const CATEGORIES_EXTERNAL = ['banco', 'servidor', 'site', 'domínio', 'certificado', 'avisos', 'configuração', 'verificação'];
const state = { snapshot: null, extAt: 0, ext: null, dbAt: 0, awakeSince: null, sentAtNight: new Map(), running: null };

async function telegram(text) {
  const token = env().TELEGRAM_BOT_TOKEN, chat = state.chatId;
  if (!token || !chat) return false;
  const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error('Telegram respondeu ' + r.status);
  return true;
}
const ICON = { critical: '🔴', warn: '🟠', info: '🔵' };
const line = a => ICON[a.severity] + ' ' + a.title + (a.detail ? '\n' + a.detail : '');
const panelUrl = () => (env().PUBLIC_BASE_URL || '').replace(/\/$/, '') + '/central.html#monitoramento';

async function settings(q) {
  const s = (await q('SELECT alert_email,telegram_chat_id,alert_digest_date,neon_usage_samples FROM platform_settings WHERE id=true')).rows[0] || {};
  state.chatId = s.telegram_chat_id || null; state.neonSamples = Array.isArray(s.neon_usage_samples) ? s.neon_usage_samples : [];
  let to = s.alert_email || env().ALERT_EMAIL || '';
  if (!to) to = (await q("SELECT email FROM users WHERE role='master' AND active ORDER BY created_at LIMIT 1")).rows[0]?.email || '';
  state.alertEmail = to; return { ...s, to };
}

export async function runMonitoring(q, { now = new Date(), withDb = true, forceExternal = false, notify = true } = {}) {
  if (state.running) return state.running;
  state.running = (async () => {
    if (withDb && !state.neonSamples) await settings(q);
    if (forceExternal || !state.ext || now - state.extAt > (withDb ? 25 : 55) * 60000) { state.ext = await externalChecks(now); state.extAt = now.getTime(); }
    let items = [...state.ext.items], metrics = { ...state.ext.metrics }, scopes = new Set(CATEGORIES_EXTERNAL.filter(c => !state.ext.failed?.has(c)));
    if (!withDb) {
      // Noite: sem banco. Só o que é crítico vai pro Telegram, lembrado em memória para não repetir.
      if (notify && state.chatId) for (const a of items.filter(x => x.severity === 'critical')) {
        const prev = state.sentAtNight.get(a.key);
        if (!prev || now - prev > 4 * HOUR) { try { await telegram(line(a) + '\n\n' + panelUrl()); state.sentAtNight.set(a.key, now.getTime()); } catch (e) { console.error('Monitoramento: Telegram', e.message); } }
      }
      state.snapshot = { at: now.toISOString(), metrics, items, partial: true };
      return state.snapshot;
    }
    const s = await settings(q);
    await saveNeonSample(q, metrics.neon, now);
    const awakeMinutes = state.awakeSince ? (now - state.awakeSince) / 60000 : 0;
    const db = await dbChecks(q, now, { awakeMinutes });
    items = [...items, ...db.items]; metrics = { ...metrics, ...db.metrics };
    for (const c of ['lojas', 'cobrança', 'suporte', 'relatórios']) scopes.add(c);
    const notes = await persist(q, items, scopes, now, notify);
    if (notify) await deliver(notes, now);
    if (notify) await digest(q, s, items, metrics, now);
    state.dbAt = now.getTime();
    state.snapshot = { at: now.toISOString(), metrics, items, partial: false };
    return state.snapshot;
  })().finally(() => { state.running = null; });
  return state.running;
}

async function saveNeonSample(q, neon, now) {
  if (!neon?.configured || typeof neon.cu_hours !== 'number') return;
  const list = state.neonSamples || [], last = list[list.length - 1];
  if (last && now - last.at < 20 * HOUR) return;
  const next = [...list, { at: now.getTime(), h: neon.cu_hours }].filter(x => now - x.at < 40 * DAY).slice(-40);
  await q('UPDATE platform_settings SET neon_usage_samples=$1 WHERE id=true', [JSON.stringify(next)]); state.neonSamples = next;
}

async function persist(q, items, scopes, now, notify) {
  const open = (await q("SELECT key,severity,category,notified_at,notified_severity,acknowledged_at FROM platform_alerts WHERE status='open'")).rows;
  const byKey = new Map(open.map(r => [r.key, r])), seen = new Set(), notes = [];
  const day = isOpen(now);
  for (const a of items) {
    seen.add(a.key);
    const prev = byKey.get(a.key);
    await q(`INSERT INTO platform_alerts(key,severity,category,title,detail,tenant_id) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(key) DO UPDATE SET severity=$2,category=$3,title=$4,detail=$5,tenant_id=$6,last_seen_at=now(),
        status='open',resolved_at=NULL,first_seen_at=CASE WHEN platform_alerts.status='resolved' THEN now() ELSE platform_alerts.first_seen_at END,
        notified_at=CASE WHEN platform_alerts.status='resolved' THEN NULL ELSE platform_alerts.notified_at END,
        notified_severity=CASE WHEN platform_alerts.status='resolved' THEN NULL ELSE platform_alerts.notified_severity END,
        acknowledged_at=CASE WHEN platform_alerts.status='resolved' OR $2<>platform_alerts.severity THEN NULL ELSE platform_alerts.acknowledged_at END`,
      [a.key, a.severity, a.category, a.title.slice(0, 300), a.detail.slice(0, 1000), a.tenant_id]);
    if (!notify || a.severity === 'info') continue;
    const night = state.sentAtNight.get(a.key);
    const lastAt = prev?.notified_at ? new Date(prev.notified_at).getTime() : night || 0;
    const escalated = !prev?.notified_severity ? !night : RANK[a.severity] > RANK[prev.notified_severity];
    const repeat = a.severity === 'critical' && !prev?.acknowledged_at && lastAt && now - lastAt > 4 * HOUR;
    if (night && !prev?.notified_at) { await q('UPDATE platform_alerts SET notified_at=$2,notified_severity=$3 WHERE key=$1', [a.key, new Date(night), a.severity]); state.sentAtNight.delete(a.key); }
    if ((escalated || repeat) && (a.severity === 'critical' || day)) notes.push({ type: escalated ? 'new' : 'repeat', alert: a });
  }
  for (const r of open) {
    if (seen.has(r.key) || !scopes.has(r.category)) continue;
    const t = await q("UPDATE platform_alerts SET status='resolved',resolved_at=now() WHERE key=$1 AND status='open' RETURNING title,severity,notified_at", [r.key]);
    const row = t.rows[0];
    if (notify && row?.notified_at && row.severity !== 'info') notes.push({ type: 'resolved', alert: { key: r.key, title: row.title, severity: row.severity } });
  }
  return notes;
}

async function deliver(notes, now) {
  if (!notes.length) return;
  const fresh = notes.filter(n => n.type !== 'resolved'), solved = notes.filter(n => n.type === 'resolved');
  const parts = [];
  if (fresh.length) parts.push(fresh.map(n => (n.type === 'repeat' ? '⏰ Ainda aberto: ' : '') + line(n.alert)).join('\n\n'));
  if (solved.length) parts.push(solved.map(n => '✅ Resolvido: ' + n.alert.title).join('\n'));
  const text = 'Ficou Pronto — monitoramento\n\n' + parts.join('\n\n') + '\n\n' + panelUrl();
  try { await telegram(text); } catch (e) { console.error('Monitoramento: Telegram', e.message); }
  const crit = fresh.filter(n => n.alert.severity === 'critical' && n.type === 'new');
  if (crit.length && emailConfigured() && state.alertEmail) {
    try { await sendEmail(state.alertEmail, '🔴 Ficou Pronto: ' + crit[0].alert.title + (crit.length > 1 ? ' (+' + (crit.length - 1) + ')' : ''), mailHtml('Problema crítico', crit.map(n => n.alert))); } catch (e) { console.error('Monitoramento: e-mail', e.message); }
  }
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLOR = { critical: '#b42318', warn: '#b45309', info: '#1d4ed8' };
function mailHtml(title, alerts, extra = '') {
  return '<div style="font-family:Arial,sans-serif;max-width:640px"><h2 style="margin:0 0 12px">' + esc(title) + '</h2>' + extra
    + alerts.map(a => '<div style="border-left:4px solid ' + COLOR[a.severity] + ';padding:8px 12px;margin:8px 0;background:#fafafa"><strong>' + esc(a.title) + '</strong><br><span style="color:#4b5563">' + esc(a.detail) + '</span></div>').join('')
    + '<p><a href="' + esc(panelUrl()) + '">Abrir o monitoramento na central</a></p></div>';
}

async function digest(q, s, items, metrics, now) {
  // Uma vez por dia, na primeira rodada do expediente a partir das 7h.
  if (!isOpen(now) || localClock(now).minutes < 7 * 60) return;
  const today = now.toLocaleDateString('sv-SE', { timeZone: TZ });
  const claimed = await q('UPDATE platform_settings SET alert_digest_date=$1 WHERE id=true AND (alert_digest_date IS NULL OR alert_digest_date < $1) RETURNING 1', [today]);
  if (!claimed.rowCount) return;
  const n = metrics.neon || {}, sorted = [...items].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const head = [n.configured ? 'Banco: ' + n.cu_hours + (n.limit ? ' de ' + n.limit + ' CU-h (' + n.percent + '%)' : ' CU-h') + ' · previsão do mês ' + n.projected : null,
    metrics.devices ? 'Computadores das lojas: ' + metrics.devices.online + '/' + metrics.devices.total + ' com sinal' : null,
    ...(metrics.domains || []).filter(d => d.days != null).map(d => 'Domínio ' + d.domain + ': vence em ' + d.days + ' dias')].filter(Boolean);
  const count = k => sorted.filter(a => a.severity === k).length;
  const text = '☀️ Resumo do dia — Ficou Pronto\n' + head.join('\n') + '\n\n' + (sorted.length ? sorted.slice(0, 12).map(a => ICON[a.severity] + ' ' + a.title).join('\n') + (sorted.length > 12 ? '\n… e mais ' + (sorted.length - 12) : '') : '✅ Nenhum alerta aberto') + '\n\n' + panelUrl();
  try { await telegram(text); } catch (e) { console.error('Monitoramento: Telegram', e.message); }
  if (emailConfigured() && s.to) {
    try { await sendEmail(s.to, 'Resumo do dia: ' + (count('critical') ? count('critical') + ' crítico(s), ' : '') + count('warn') + ' atenção · Ficou Pronto', mailHtml('Resumo do dia', sorted, '<p>' + head.map(esc).join('<br>') + '</p>')); } catch (e) { console.error('Monitoramento: e-mail', e.message); }
  }
}

export const monitoringSnapshot = () => state.snapshot;

export function startMonitoring(q) {
  if (env().MONITORING === 'off') return;
  const tick = async () => {
    const now = new Date(), allowed = backgroundAllowed(now);
    if (allowed && !state.awakeSince) state.awakeSince = now.getTime();
    if (!allowed) state.awakeSince = null;
    try {
      if (allowed && now - state.dbAt >= 10 * 60000) await runMonitoring(q, { now });
      else if (!allowed && now - state.extAt >= 60 * 60000) await runMonitoring(q, { now, withDb: false });
    } catch (e) { console.error('Monitoramento falhou:', e.code || e.message); }
  };
  setTimeout(tick, 90000).unref(); setInterval(tick, 5 * 60000).unref();
}

// ---------- rotas da central ----------
export function registerMonitoring(app, { q, auth, roles, route, bad, valid, z }) {
  const master = [auth, roles('master')];
  const view = async () => {
    const [alerts, resolved, s] = await Promise.all([
      q("SELECT a.key,a.severity,a.category,a.title,a.detail,a.first_seen_at,a.last_seen_at,a.notified_at,a.acknowledged_at,t.name store FROM platform_alerts a LEFT JOIN tenants t ON t.id=a.tenant_id WHERE a.status='open' ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, a.first_seen_at"),
      q("SELECT key,severity,title,resolved_at,first_seen_at FROM platform_alerts WHERE status='resolved' AND resolved_at > now() - interval '7 days' AND severity<>'info' ORDER BY resolved_at DESC LIMIT 30"),
      settings(q)]);
    const snap = state.snapshot;
    return { checked_at: snap?.at || null, metrics: snap?.metrics || {}, alerts: alerts.rows, resolved: resolved.rows,
      channels: { telegram: { token: !!env().TELEGRAM_BOT_TOKEN, linked: !!s.telegram_chat_id }, email: { configured: emailConfigured(), to: s.to || '' } } };
  };
  app.get('/api/master/monitoring', ...master, route(async (_req, res) => {
    if (!state.snapshot || state.snapshot.partial) await runMonitoring(q, { notify: false });
    res.set('Cache-Control', 'no-store').json(await view());
  }));
  app.post('/api/master/monitoring/run', ...master, route(async (_req, res) => { await runMonitoring(q, { forceExternal: true }); res.json(await view()); }));
  app.get('/api/master/monitoring/summary', ...master, route(async (_req, res) => {
    const r = await q("SELECT severity,count(*)::int n FROM platform_alerts WHERE status='open' AND acknowledged_at IS NULL GROUP BY 1");
    const out = { critical: 0, warn: 0, info: 0 }; for (const x of r.rows) out[x.severity] = x.n;
    res.set('Cache-Control', 'no-store').json(out);
  }));
  app.post('/api/master/monitoring/ack', ...master, route(async (req, res) => {
    const v = valid(z.object({ key: z.string().min(1).max(200) }), req, res); if (!v) return;
    const r = await q("UPDATE platform_alerts SET acknowledged_at=now() WHERE key=$1 AND status='open' RETURNING key", [v.key]);
    if (!r.rowCount) return bad(res, 404, 'Alerta não encontrado'); res.json({ ok: true });
  }));
  app.patch('/api/master/monitoring/settings', ...master, route(async (req, res) => {
    const v = valid(z.object({ alert_email: z.union([z.literal(''), z.string().email().max(200)]) }), req, res); if (!v) return;
    await q('UPDATE platform_settings SET alert_email=$1 WHERE id=true', [v.alert_email || null]); res.json({ ok: true });
  }));
  // Vincula o Telegram: a pessoa manda qualquer mensagem ao bot e clica em "Conectar".
  app.post('/api/master/monitoring/telegram/link', ...master, route(async (_req, res) => {
    const token = env().TELEGRAM_BOT_TOKEN; if (!token) return bad(res, 400, 'Coloque TELEGRAM_BOT_TOKEN no Render primeiro.');
    const r = await fetch('https://api.telegram.org/bot' + token + '/getUpdates', { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return bad(res, 400, 'O Telegram recusou o token (' + r.status + '). Confira o TELEGRAM_BOT_TOKEN.');
    const ups = (await r.json()).result || [];
    const chat = ups.map(u => (u.message || u.channel_post || u.my_chat_member)?.chat).filter(Boolean).pop();
    if (!chat) return bad(res, 400, 'Nenhuma mensagem encontrada. Abra o bot no Telegram, toque em Iniciar (ou mande "oi") e tente de novo.');
    await q('UPDATE platform_settings SET telegram_chat_id=$1 WHERE id=true', [String(chat.id)]); state.chatId = String(chat.id);
    await telegram('✅ Avisos do Ficou Pronto conectados. Você vai receber aqui os alertas do monitoramento.');
    res.json({ ok: true, chat: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id) });
  }));
  app.post('/api/master/monitoring/test', ...master, route(async (_req, res) => {
    const s = await settings(q), out = {};
    try { out.telegram = await telegram('🔔 Teste de aviso do Ficou Pronto — está funcionando.') ? 'enviado' : 'não configurado'; } catch (e) { out.telegram = 'falhou: ' + e.message; }
    if (emailConfigured() && s.to) { try { await sendEmail(s.to, '🔔 Teste de aviso — Ficou Pronto', mailHtml('Teste de aviso', [], '<p>Se você recebeu este e-mail, os avisos por e-mail estão funcionando.</p>')); out.email = 'enviado para ' + s.to; } catch (e) { out.email = 'falhou: ' + e.message; } }
    else out.email = 'não configurado';
    res.json(out);
  }));
}
