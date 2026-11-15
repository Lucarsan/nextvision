// Central: "Monitoramento" — saúde da plataforma (banco, servidor, domínio, lojas) e alertas.
// Também mostra uma faixa no topo da central quando há alertas abertos, em qualquer página.
// Usa os utilitários globais do app.js: api, el, safe, msg, render, show.
(() => {
  const TZ = 'America/Fortaleza';
  const SEV = { critical: ['bad', 'Crítico'], warn: ['warn', 'Atenção'], info: ['muted', 'Info'] };
  const chip = (k, t) => '<span class="ct-chip ' + k + '">' + safe(t) + '</span>';
  const dt = d => d ? new Date(d).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const day = d => d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: TZ }) : '—';
  const kpi = (label, value, note = '', kind = '') => '<div class="ct-kpi"><span>' + safe(label) + '</span><strong style="font-size:30px">' + safe(value) + '</strong><em class="' + kind + '">' + safe(note) + '</em></div>';
  const bar = (p, kind) => '<div style="height:8px;border-radius:99px;background:#F3F4F6;overflow:hidden;margin-top:6px"><div style="height:100%;width:' + Math.min(100, Math.max(2, p || 0)) + '%;background:' + (kind === 'bad' ? '#B91C1C' : kind === 'warn' ? '#D97706' : '#059669') + '"></div></div>';

  // ---- faixa de alerta em qualquer página ----
  async function banner() {
    let s; try { s = await api('/master/monitoring/summary'); } catch { return; }
    let b = el('monBanner');
    if (!b) { b = document.createElement('div'); b.id = 'monBanner'; el('feedback').before(b); }
    const n = s.critical + s.warn;
    const btn = document.querySelector('.ct-nav-btn[data-page="Monitoramento"] span');
    if (btn) btn.innerHTML = 'Monitoramento' + (n ? ' <b style="background:' + (s.critical ? '#B91C1C' : '#D97706') + ';color:#fff;border-radius:99px;padding:0 7px;font-size:11px;margin-left:4px">' + n + '</b>' : '');
    if (!n || view === 'Monitoramento') { b.innerHTML = ''; return; }
    b.innerHTML = '<div role="alert" style="display:flex;align-items:center;gap:12px;justify-content:space-between;background:' + (s.critical ? '#FEF2F2' : '#FFF7ED') + ';color:' + (s.critical ? '#991B1B' : '#92400E') + ';border-radius:14px;padding:12px 16px;margin:0 0 14px;font-weight:600">'
      + '<span>' + (s.critical ? '🔴 ' + s.critical + ' problema(s) crítico(s)' : '') + (s.critical && s.warn ? ' · ' : '') + (s.warn ? '🟠 ' + s.warn + ' ponto(s) de atenção' : '') + ' na plataforma</span>'
      + '<button type="button" class="ct-btn" id="monGo" style="height:36px">Ver monitoramento</button></div>';
    el('monGo').onclick = () => show('Monitoramento');
  }
  window.fpMonitorBanner = banner;
  setInterval(() => { if (!document.hidden && !window.fpPollPaused?.()) banner(); }, 120000);

  function infra(m) {
    const n = m.neon || {}, r = m.render || {}, sv = m.server || {}, d = m.devices || {};
    const neonKind = n.percent >= 85 ? 'bad' : n.percent >= 70 || n.runs_out_at ? 'warn' : '';
    const cards = [];
    cards.push('<div class="ct-card"><h2>Banco de dados (Neon)</h2>' + (n.configured
      ? (n.limit ? kpi('Uso do mês', n.cu_hours + ' / ' + n.limit + ' CU-h', n.percent + '% · ' + n.cu_hours_per_day + '/dia' + (n.rate_basis === 'period' ? ' (média do mês)' : '') + ' · previsão ' + n.projected + (n.runs_out_at ? ' · acaba ~' + day(n.runs_out_at) : ''), neonKind) + bar(n.percent, neonKind)
        : kpi('Uso do mês', n.cu_hours + ' CU-h', 'US$ ' + n.cost_usd + ' · previsão US$ ' + n.projected_cost_usd + ' (orçamento ' + n.budget_usd + ')'))
        + '<p class="ct-muted" style="margin:10px 0 0">Espaço: ' + Math.round((n.storage_bytes || 0) / 1048576) + ' de ' + Math.round((n.storage_limit_bytes || 0) / 1048576) + ' MB · cota renova em ' + new Date(n.period_end).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) + ' · último uso ' + dt(n.compute_last_active_at) + '</p>'
      : '<p class="ct-muted">' + (n.error ? 'Não consegui consultar o Neon: ' + safe(n.error) + '.' : 'Sem NEON_API_KEY: consumo não monitorado.') + (m.db_size_mb != null ? ' Tamanho do banco: ' + m.db_size_mb + ' MB.' : '') + '</p>') + '</div>');
    cards.push('<div class="ct-card"><h2>Servidor (Render)</h2>' + (r.configured
      ? kpi('Última publicação', r.last_deploy?.status === 'live' ? 'No ar' : (r.last_deploy?.status || '—'), (r.last_deploy?.commit || '') + ' · ' + dt(r.last_deploy?.at), /failed/.test(r.last_deploy?.status || '') ? 'bad' : '')
        + '<p class="ct-muted" style="margin:10px 0 0">Plano: ' + safe(r.plan || '—') + (r.free_services ? ' · ' + r.free_services + ' serviço(s) grátis na conta' : '') + '</p>'
      : '<p class="ct-muted">' + (r.error ? 'Não consegui consultar o Render: ' + safe(r.error) + '.' : 'Sem RENDER_API_KEY: publicações e suspensão não monitoradas.') + '</p>')
      + '<p class="ct-muted" style="margin:6px 0 0">Memória ' + (sv.memory_mb ?? '—') + ' / ' + (sv.memory_limit_mb ?? '—') + ' MB · ligado há ' + Math.round((sv.uptime_s || 0) / 3600) + ' h · erros na última hora: ' + (sv.errors_1h ?? 0) + '</p></div>');
    const doms = (m.domains || []).map(x => '<li>' + safe(x.domain) + ': ' + (x.days != null ? 'vence em <strong>' + x.days + ' dias</strong> (' + day(x.expires_at) + ')' : safe(x.error || 'sem dados')) + (x.registrar ? ' · ' + safe(x.registrar) : '') + '</li>').join('');
    const certs = (m.certificates || []).map(x => '<li>' + safe(x.host) + ': ' + (x.days != null ? 'certificado válido por ' + x.days + ' dias' : safe(x.error || '—')) + '</li>').join('');
    cards.push('<div class="ct-card"><h2>Domínio e site</h2><ul style="margin:0;padding-left:18px;line-height:1.8">' + (doms || '<li class="ct-muted">Nenhum domínio configurado</li>') + certs
      + (m.site?.url ? '<li>' + safe(m.site.url) + ': ' + (m.site.status === 200 ? 'respondendo em ' + m.site.ms + ' ms' : safe(m.site.error || 'erro ' + m.site.status)) + '</li>' : '') + '</ul></div>');
    cards.push('<div class="ct-card"><h2>Computadores das lojas</h2>' + (d.total != null ? kpi('Com sinal agora', d.online + '/' + d.total, d.latest_agent ? 'versão atual do agente: ' + d.latest_agent : '', d.online < d.total ? 'bad' : '') : '<p class="ct-muted">Conferido no expediente.</p>') + '</div>');
    return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px">' + cards.join('') + '</div>';
  }

  window.monitoringPage = async function monitoringPage(data) {
    try { history.replaceState(null, '', '#monitoramento'); } catch { /* sem histórico */ }
    el('headActions').innerHTML = '<button type="button" class="ct-btn" id="monRun">Verificar agora</button>';
    if (!data) { render('<section>Verificando a plataforma…</section>'); data = await api('/master/monitoring'); }
    const a = data.alerts, crit = a.filter(x => x.severity === 'critical'), warn = a.filter(x => x.severity === 'warn');
    const answer = crit.length ? ['warn', crit.length + ' problema(s) crítico(s) agora', crit.map(x => x.title).slice(0, 3).join(' · ')]
      : warn.length ? ['warn', warn.length + ' ponto(s) de atenção', warn.map(x => x.title).slice(0, 3).join(' · ')]
      : ['ok', 'Tudo certo na plataforma', 'Última verificação: ' + dt(data.checked_at)];
    const ch = data.channels;
    const row = x => '<tr><td>' + chip(...SEV[x.severity]) + '</td><td><strong>' + safe(x.title) + '</strong><div class="ct-muted" style="max-width:640px;white-space:pre-wrap">' + safe(x.detail) + '</div></td><td>' + safe(x.store || '—') + '</td><td>' + dt(x.first_seen_at) + '</td><td>'
      + (x.severity !== 'info' ? (x.acknowledged_at ? '<span class="ct-muted">Ciente</span>' : '<button type="button" class="ct-link" data-ack="' + safe(x.key) + '">Ciente</button>') : '') + '</td></tr>';
    render('<section class="ct-answer ' + answer[0] + '"><div class="ct-answer-icon" aria-hidden="true">' + (answer[0] === 'ok' ? FPIcon('check') : FPIcon('alert')) + '</div><div><strong>' + safe(answer[1]) + '</strong><span>' + safe(answer[2]) + '</span></div></section>'
      + infra(data.metrics)
      + '<section class="ct-card"><div class="ct-card-head"><h2>Alertas abertos (' + a.length + ')</h2><span class="ct-muted">Verificado ' + dt(data.checked_at) + '</span></div>'
      + '<div class="ct-table-wrap"><table class="ct-table"><thead><tr><th>Gravidade</th><th>O quê</th><th>Loja</th><th>Desde</th><th></th></tr></thead><tbody>'
      + (a.length ? a.map(row).join('') : '<tr><td colspan="5" class="ct-empty">Nenhum alerta aberto.</td></tr>') + '</tbody></table></div>'
      + '<p class="ct-note">"Ciente" para de repetir o aviso; o alerta continua aqui até o problema ser resolvido.</p></section>'
      + '<section class="ct-card"><h2>Como você é avisado</h2>'
      + '<p>🔴 <strong>Crítico</strong> (algo parado ou prestes a parar): Telegram + e-mail na hora; repete no Telegram a cada 4 h até você marcar "Ciente". Avisa também de madrugada.<br>🟠 <strong>Atenção</strong>: Telegram na hora (no expediente).<br>🔵 <strong>Info</strong>: só aqui e no resumo diário (7h, Telegram + e-mail).<br>Antecedência: domínio 60/30/7 dias · certificado 20/7 dias · cota do banco a partir de 70% ou quando a previsão estoura antes do fim do mês.</p>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-top:12px">'
      + '<div><h3 style="margin:0 0 6px;font-size:15px">Telegram ' + (ch.telegram.linked ? chip('ok', 'Conectado') : ch.telegram.token ? chip('warn', 'Falta conectar') : chip('bad', 'Sem bot')) + '</h3>'
      + (ch.telegram.token ? '<p class="ct-muted">Abra o seu bot no Telegram, toque em <strong>Iniciar</strong> (ou mande "oi") e clique abaixo.</p><button type="button" class="ct-btn ghost" id="monTg">' + (ch.telegram.linked ? 'Reconectar' : 'Conectar Telegram') + '</button>'
        : '<p class="ct-muted">No Telegram, fale com <strong>@BotFather</strong> → /newbot → copie o token e coloque em <code>TELEGRAM_BOT_TOKEN</code> no Render. Depois volte aqui.</p>') + '</div>'
      + '<div><h3 style="margin:0 0 6px;font-size:15px">E-mail ' + (ch.email.configured ? chip('ok', 'Configurado') : chip('warn', 'Sem envio')) + '</h3>'
      + '<label>Enviar para<input id="monEmail" type="email" value="' + safe(ch.email.to) + '" placeholder="seu@email.com" style="display:block;width:100%;margin-top:6px;padding:10px;border:1px solid #E5E7EB;border-radius:10px;font:inherit"></label>'
      + '<div style="display:flex;gap:8px;margin-top:8px"><button type="button" class="ct-btn ghost" id="monEmailSave">Salvar</button><button type="button" class="ct-btn ghost" id="monTest">Enviar teste</button></div></div></div></section>'
      + (data.resolved.length ? '<section class="ct-card"><h2>Resolvidos nos últimos 7 dias</h2><ul style="margin:0;padding-left:18px;line-height:1.8">' + data.resolved.map(x => '<li>' + safe(x.title) + ' <span class="ct-muted">— ' + dt(x.first_seen_at) + ' até ' + dt(x.resolved_at) + '</span></li>').join('') + '</ul></section>' : ''));
    el('monRun').onclick = async () => { el('monRun').disabled = true; msg('Verificando…'); try { const d = await api('/master/monitoring/run', 'POST'); msg(''); await monitoringPage(d); banner(); } catch (e) { msg(e.message); el('monRun').disabled = false; } };
    document.querySelectorAll('[data-ack]').forEach(b => b.onclick = async () => { try { await api('/master/monitoring/ack', 'POST', { key: b.dataset.ack }); await monitoringPage(); banner(); } catch (e) { msg(e.message); } });
    if (el('monTg')) el('monTg').onclick = async () => { try { const r = await api('/master/monitoring/telegram/link', 'POST'); msg('Telegram conectado: ' + r.chat + '. Mandei uma mensagem de confirmação.'); } catch (e) { msg(e.message); } };
    el('monEmailSave').onclick = async () => { try { await api('/master/monitoring/settings', 'PATCH', { alert_email: el('monEmail').value.trim() }); msg('E-mail dos avisos salvo.'); } catch (e) { msg(e.message); } };
    el('monTest').onclick = async () => { try { const r = await api('/master/monitoring/test', 'POST'); msg('Teste — Telegram: ' + r.telegram + ' · E-mail: ' + r.email); } catch (e) { msg(e.message); } };
    banner();
  };
})();
