// Central: "Números" (acompanhamento dos links) e "Relatórios" (resultados para enviar aos lojistas).
// Usa os utilitários globais do app.js: api, el, safe, msg, render.
(() => {
  const pad = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const shift = (day, n) => { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const dmy = s => s.split('-').reverse().join('/');
  const num = v => Number(v || 0).toLocaleString('pt-BR');
  const dur = sec => { const s = Math.max(0, Math.round(Number(sec) || 0)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? h + ' h' + (m ? ' ' + m + ' min' : '') : m ? m + ' min' : s + ' s'; };
  const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const kpi = (label, value, note = '') => '<div class="ct-kpi"><span>' + safe(label) + '</span><strong>' + safe(value) + '</strong><em>' + safe(note) + '</em></div>';
  const state = { days: 30, from: null, to: null, tenant: '' };
  const legend = (c, t) => '<span style="display:inline-block;width:10px;height:10px;background:' + c + ';border-radius:2px"></span> ' + safe(t);
  const rate = v => v == null ? '—' : v + '%';
  const TZ = 'America/Fortaleza';
  const hm = d => d ? new Date(d).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '';
  const dayOf = d => d ? new Date(d).toLocaleDateString('sv-SE', { timeZone: TZ }) : '';
  const when = (d, base) => d ? (dayOf(d) === base ? hm(d) : dmy(dayOf(d)).slice(0, 5) + ' ' + hm(d)) : '';
  const gap = (a, b) => { if (!a || !b) return ''; const m = Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)); return m < 1 ? 'na hora' : m < 60 ? m + ' min depois' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min depois'; };
  // Funil: pedidos criados → link enviado → cliente abriu → viu ao vivo.
  function funnel(t) {
    const steps = [['Pedidos criados', t.links, ''], ['Link enviado ou copiado', t.shared, rate(t.share_rate) + ' dos pedidos'],
      ['Cliente abriu o link', t.links_opened, rate(t.open_rate) + ' dos pedidos'], ['Cliente viu ao vivo', t.live_orders, t.links_opened ? Math.round(t.live_orders * 100 / t.links_opened) + '% de quem abriu' : '—']];
    const max = Math.max(1, t.links);
    return '<div style="display:grid;gap:10px">' + steps.map(([l, v, n], i) => '<div style="display:grid;grid-template-columns:minmax(150px,210px) 1fr;gap:12px;align-items:center"><span style="font-size:13px;color:var(--muted)">' + safe(l) + '</span>'
      + '<div style="display:flex;align-items:center;gap:10px"><div style="height:26px;border-radius:6px;background:' + ['#CBD2DC', '#3B82F6', '#F25C1F', '#16A34A'][i] + ';width:' + Math.max(1, Math.round(v * 70 / max)) + '%;min-width:4px"></div><strong style="font-size:18px">' + num(v) + '</strong><em style="font-style:normal;font-size:12px;color:var(--muted)">' + safe(n) + '</em></div></div>').join('') + '</div>';
  }

  // Gráfico simples por dia: pedidos com link (cinza) e aberturas (laranja).
  function chart(days) {
    if (!days.length) return '';
    const W = 760, H = 180, padL = 34, padB = 22, max = Math.max(1, ...days.map(d => Math.max(d.links, d.shared || 0, d.opens)));
    const bw = (W - padL) / days.length, bar = Math.max(2, Math.min(12, bw / 3 - 2));
    const y = v => H - padB - (H - padB - 8) * v / max;
    const ticks = [0, Math.round(max / 2), max];
    let g = ticks.map(t => '<line x1="' + padL + '" x2="' + W + '" y1="' + y(t) + '" y2="' + y(t) + '" stroke="#EEF0F3"/><text x="' + (padL - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end" font-size="10" fill="#6B7280">' + t + '</text>').join('');
    days.forEach((d, i) => {
      const x = padL + i * bw + bw / 2;
      const r = (dx, v, fill, t) => '<rect x="' + (x + dx) + '" y="' + y(v) + '" width="' + bar + '" height="' + (H - padB - y(v)) + '" rx="2" fill="' + fill + '"><title>' + dmy(d.day) + ': ' + v + ' ' + t + '</title></rect>';
      g += r(-bar * 1.5 - 1, d.links, '#CBD2DC', 'pedidos criados') + r(-bar / 2, d.shared || 0, '#3B82F6', 'pedidos com link enviado') + r(bar / 2 + 1, d.opens, '#F25C1F', 'aberturas de clientes');
      if (days.length <= 14 || i % Math.ceil(days.length / 10) === 0) g += '<text x="' + x + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="#6B7280">' + d.day.slice(8) + '/' + d.day.slice(5, 7) + '</text>';
    });
    return '<div style="overflow-x:auto"><svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;min-width:520px;height:auto" role="img" aria-label="Pedidos com link e aberturas por dia">' + g + '</svg></div>'
      + '<p class="ct-note">' + legend('#CBD2DC', 'Pedidos criados') + ' &nbsp; ' + legend('#3B82F6', 'Link enviado') + ' &nbsp; ' + legend('#F25C1F', 'Aberturas de clientes') + '</p>';
  }

  async function downloadCsv(group, range, tenant = '') {
    const r = await fetch('/api/master/analytics.csv?group=' + group + '&from=' + range.from + '&to=' + range.last + (tenant ? '&tenant=' + tenant : ''), { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw Error('Não foi possível gerar o arquivo');
    const blob = await r.blob(), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'ficoupronto-' + group + '-' + range.from + '-a-' + range.last + '.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  window.numbersPage = async function numbersPage() {
    const last = state.to || today(), from = state.from || shift(last, -(state.days - 1));
    const [d, stores] = await Promise.all([
      api('/master/analytics?from=' + from + '&to=' + last + (state.tenant ? '&tenant=' + state.tenant : '')),
      api('/master/tenants')
    ]);
    const t = d.totals;
    const seg = [7, 30, 90].map(n => '<button type="button" data-days="' + n + '" aria-selected="' + (!state.from && state.days === n) + '">' + n + ' dias</button>').join('');
    render('<section class="ct-card"><div class="ct-card-head"><h2>Período: ' + safe(dmy(from)) + ' a ' + safe(dmy(last)) + '</h2><div class="ct-seg">' + seg + '</div></div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:12px;align-items:end"><label style="margin:0">De<input type="date" id="anFrom" value="' + from + '"></label><label style="margin:0">Até<input type="date" id="anTo" value="' + last + '"></label>'
      + '<label style="margin:0">Loja<select id="anTenant"><option value="">Todas as lojas</option>' + stores.map(s => '<option value="' + safe(s.id) + '"' + (s.id === state.tenant ? ' selected' : '') + '>' + safe(s.name) + '</option>').join('') + '</select></label>'
      + '<button type="button" id="anApply">Ver</button></div></section>'
      + '<section class="ct-card"><h2>Funil dos pedidos criados no período</h2>' + funnel(t) + '</section>'
      + '<section class="ct-card ct-kpis">'
      + kpi('Abriram entre os enviados', rate(t.shared_open_rate), num(t.shared_opened) + ' de ' + num(t.shared) + ' links enviados')
      + kpi('Tempo até abrir', t.median_open_seconds == null ? '—' : dur(t.median_open_seconds), 'mediana entre o envio e a 1ª abertura')
      + kpi('Abriram durante o atendimento', num(t.opened_during), 'antes de o pedido ficar pronto')
      + kpi('Aberturas de clientes', num(t.opens), num(t.people) + ' pessoas (aparelhos)')
      + kpi('Voltaram para ver de novo', num(t.returns), 'clientes que abriram mais de uma vez')
      + kpi('Tempo médio na página', dur(t.avg_visible_seconds), 'por abertura')
      + kpi('Vídeo ao vivo assistido', dur(t.live_seconds), num(t.downloads) + ' vídeos baixados')
      + kpi('Conversas com a loja', num(t.talks), 'cliques em "Falar com a loja"')
      + kpi('Pelo celular', t.opens ? Math.round(t.mobile * 100 / t.opens) + '%' : '—', 'das aberturas')
      + kpi('Aberturas da equipe', num(t.staff_opens), 'fora da conta (loja e central)')
      + '</section>'
      + '<section class="ct-card"><h2>Por dia</h2>' + chart(d.days) + '</section>'
      + '<section class="ct-card"><div class="ct-card-head"><h2>Por loja</h2><div><button type="button" class="secondary" data-csv="store">Baixar por loja (CSV)</button><button type="button" class="secondary" data-csv="day">Por dia</button><button type="button" class="secondary" data-csv="order">Por pedido</button></div></div>'
      + '<div style="overflow-x:auto"><table><thead><tr><th>Loja</th><th>Pedidos</th><th>Link enviado</th><th>Abertos</th><th>Aberturas</th><th>Pessoas</th><th>Tempo até abrir</th><th>Retornos</th><th>Tempo médio</th><th>Vídeo assistido</th><th>Downloads</th></tr></thead><tbody>'
      + (d.stores.length ? d.stores.map(s => '<tr><td><div class="ct-store"><strong>' + safe(s.name) + '</strong><span>' + safe(s.slug) + '</span></div></td><td>' + num(s.links) + '</td><td>' + num(s.shared) + ' <small>(' + rate(s.share_rate) + ')</small></td><td>' + num(s.links_opened) + ' <small>(' + rate(s.open_rate) + ')</small></td><td>' + num(s.opens) + '</td><td>' + num(s.people) + '</td><td>' + (s.median_open_seconds == null ? '—' : dur(s.median_open_seconds)) + '</td><td>' + num(s.returns) + '</td><td>' + dur(s.avg_visible_seconds) + '</td><td>' + dur(s.live_seconds) + '</td><td>' + num(s.downloads) + '</td></tr>').join('') : '<tr><td colspan="11" class="ct-empty">Sem dados no período.</td></tr>')
      + '</tbody></table></div><p class="ct-note">Contagem anônima: aberturas são contadas pelo aparelho do cliente (a prévia do link no WhatsApp não conta). Pessoas = aparelhos diferentes. Aberturas da equipe ficam fora: navegadores onde alguém entrou no painel e aparelhos que abriram links de clientes diferentes. Funil e taxas consideram os pedidos criados no período. A medição começou em 31/10/2026.</p></section>'
      + '<section class="ct-card"><div class="ct-card-head"><h2>Números públicos (site e apresentação)</h2><span class="ct-chip ' + (d.public_stats_enabled ? 'ok">Ligado' : 'muted">Desligado') + '</span></div>'
      + '<p>Totais somados de todas as lojas, sem nenhum dado de cliente, em <code>' + safe(location.origin) + '/api/public/stats</code>. Fica desligado até você decidir mostrar.</p>'
      + '<button type="button" id="pubToggle" class="' + (d.public_stats_enabled ? 'secondary' : '') + '">' + (d.public_stats_enabled ? 'Desligar números públicos' : 'Ligar números públicos') + '</button></section>');
    document.querySelectorAll('[data-days]').forEach(b => b.onclick = () => { state.days = Number(b.dataset.days); state.from = state.to = null; numbersPage().catch(e => msg(e.message)); });
    el('anApply').onclick = () => { const f = el('anFrom').value, to = el('anTo').value; if (f && to && f <= to) { state.from = f; state.to = to; } state.tenant = el('anTenant').value; numbersPage().catch(e => msg(e.message)); };
    document.querySelectorAll('[data-csv]').forEach(b => b.onclick = () => downloadCsv(b.dataset.csv, { from, last }).catch(e => msg(e.message)));
    el('pubToggle').onclick = async () => { try { await api('/master/analytics/settings', 'PATCH', { public_stats_enabled: !d.public_stats_enabled }); msg(d.public_stats_enabled ? 'Números públicos desligados.' : 'Números públicos ligados.'); await numbersPage(); } catch (e) { msg(e.message); } };
  };

  // ---------- Relatórios para os lojistas ----------
  const waLink = (phone, text) => 'https://wa.me/' + (phone || '') + '?text=' + encodeURIComponent(text);
  function reportCard(r, { markable }) {
    const s = r.stats || {};
    return '<article class="ct-card" style="border:1px solid #EEF0F3" data-report="' + safe(r.tenant_id) + '"><div class="ct-card-head"><div class="ct-store"><strong>' + safe(r.name) + '</strong><span>' + (r.schedule === 'daily' ? 'Diário' : 'Semanal') + ' · ' + safe(r.period.title) + (r.whatsapp ? ' · WhatsApp ' + safe(r.whatsapp) : '') + '</span></div>'
      + (markable ? (r.sent ? '<span class="ct-chip ok">Enviado ' + safe(new Date(r.sent.sent_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })) + (r.sent.sent_by ? ' por ' + safe(r.sent.sent_by) : '') + '</span>' : '<span class="ct-chip warn">A enviar</span>') : '') + '</div>'
      + '<p style="margin:0 0 8px">' + num(s.links) + ' pedidos com link · ' + num(s.opens) + ' aberturas · ' + num(s.people) + ' pessoas · ' + dur(s.live_seconds) + ' de vídeo</p>'
      + '<textarea rows="8" style="max-width:none" data-text>' + safe(r.message) + '</textarea>'
      + '<div style="margin-top:8px">' + (r.whatsapp ? '<button type="button" data-send>Enviar no WhatsApp</button>' : '<span class="ct-chip bad">Loja sem WhatsApp cadastrado</span> ')
      + '<button type="button" class="secondary" data-copy>Copiar mensagem</button>'
      + (markable ? (r.sent ? '<button type="button" class="secondary" data-unmark>Marcar como não enviado</button>' : '<button type="button" class="secondary" data-mark>Marcar como enviado</button>') : '') + '</div></article>';
  }
  function wireCards(list, { markable, reload }) {
    document.querySelectorAll('[data-report]').forEach(card => {
      const r = list.find(x => x.tenant_id === card.dataset.report); if (!r) return;
      const text = () => card.querySelector('[data-text]').value;
      const mark = async sent => { await api('/master/results-reports/sent', 'POST', { tenant_id: r.tenant_id, period_key: r.period.key, sent }); await reload(); };
      card.querySelector('[data-send]')?.addEventListener('click', async () => {
        const w = window.open(waLink(r.whatsapp, text()), '_blank', 'noopener');
        if (!w) location.href = waLink(r.whatsapp, text());
        if (markable && !r.sent) { try { await mark(true); msg('Mensagem aberta no WhatsApp e marcada como enviada.'); } catch (e) { msg(e.message); } }
      });
      card.querySelector('[data-copy]')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text()); msg('Mensagem copiada.'); } catch { msg('Selecione o texto e copie.'); } });
      card.querySelector('[data-mark]')?.addEventListener('click', () => mark(true).catch(e => msg(e.message)));
      card.querySelector('[data-unmark]')?.addEventListener('click', () => mark(false).catch(e => msg(e.message)));
    });
  }

  // Relatório do dia: funil, números e uma linha por pedido criado no dia.
  function orderStatus(o) {
    if (o.opens) return '<span class="ct-chip ok">Abriu</span>';
    if (o.shared_at) return '<span class="ct-chip warn">Enviado, não abriu</span>';
    return '<span class="ct-chip muted">Link não enviado</span>';
  }
  function dayReport(r, day, allStores) {
    const t = r.totals, rows = r.orders;
    const head = '<tr>' + (allStores ? '<th>Loja</th>' : '') + '<th>Pedido</th><th>Cliente / pet</th><th>Criado</th><th>Link</th><th>Cliente abriu</th><th>Aberturas</th><th>Na página</th><th>Ao vivo</th><th>Pronto</th></tr>';
    const body = rows.length ? rows.map(o => '<tr>' + (allStores ? '<td>' + safe(o.store) + '</td>' : '')
      + '<td><strong>' + safe(o.order_number || '') + '</strong>' + (o.external_reference ? '<br><small>' + safe(o.external_reference) + '</small>' : '') + '</td>'
      + '<td>' + safe(o.customer || '—') + (o.item ? '<br><small>' + safe(o.item) + (o.service ? ' · ' + safe(o.service) : '') + '</small>' : '') + '</td>'
      + '<td>' + safe(when(o.created_at, day)) + '</td>'
      + '<td>' + (o.shared_at ? safe(when(o.shared_at, day)) + '<br><small>' + [o.sent ? 'WhatsApp' + (o.sent > 1 ? ' ×' + o.sent : '') : '', o.copied ? 'copiado' : ''].filter(Boolean).join(' + ') + '</small>' : orderStatus(o)) + '</td>'
      + '<td>' + (o.first_open ? safe(when(o.first_open, day)) + '<br><small>' + safe(gap(o.shared_at || o.created_at, o.first_open)) + '</small>' : (o.shared_at ? orderStatus(o) : '—')) + '</td>'
      + '<td>' + (o.opens ? num(o.opens) + (o.people > 1 ? ' <small>(' + o.people + ' pessoas)</small>' : '') : '—') + (o.staff_opens ? '<br><small title="Aberturas da loja ou da central, fora da conta">+' + o.staff_opens + ' da equipe</small>' : '') + '</td>'
      + '<td>' + (o.opens ? dur(o.visible_seconds) : '—') + '</td>'
      + '<td>' + (o.live_seconds ? dur(o.live_seconds) : '—') + (o.downloads ? '<br><small>' + o.downloads + ' download(s)</small>' : '') + '</td>'
      + '<td>' + (o.completed_at ? safe(when(o.completed_at, day)) : '<small>' + safe(o.status === 'live' ? 'Em atendimento' : o.status === 'paused' ? 'Pausado' : 'Na fila') + '</small>') + '</td></tr>').join('')
      : '<tr><td colspan="' + (allStores ? 10 : 9) + '" class="ct-empty">Nenhum pedido criado neste dia.</td></tr>';
    const notSent = rows.filter(o => !o.shared_at).length, notOpened = rows.filter(o => o.shared_at && !o.opens).length;
    return funnel(t)
      + '<div class="ct-kpis" style="margin-top:22px">'
      + kpi('Abriram entre os enviados', rate(t.shared_open_rate), num(t.shared_opened) + ' de ' + num(t.shared))
      + kpi('Tempo até abrir', t.median_open_seconds == null ? '—' : dur(t.median_open_seconds), 'mediana após o envio')
      + kpi('Tempo médio na página', dur(t.avg_visible_seconds), num(t.opens) + ' aberturas · ' + num(t.people) + ' pessoas')
      + kpi('Vídeo ao vivo assistido', dur(t.live_seconds), num(t.returns) + ' voltaram para ver de novo')
      + '</div>'
      + (rows.length ? '<p class="ct-note" style="margin-top:16px">' + (notSent ? '<strong>' + notSent + '</strong> pedido(s) sem link enviado pelo painel. ' : '') + (notOpened ? '<strong>' + notOpened + '</strong> enviado(s) e ainda não aberto(s). ' : '') + (t.staff_opens ? t.staff_opens + ' abertura(s) da equipe ficaram fora da conta.' : '') + '</p>' : '')
      + '<div style="overflow-x:auto;margin-top:12px"><table><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>'
      + '<p class="ct-note">"Link enviado" conta o botão de WhatsApp e o "Copiar link" do painel; links mandados por fora do painel (ex.: digitados no WhatsApp) não aparecem como enviados, mas as aberturas contam. Aberturas da equipe (navegadores do painel e aparelhos que abriram links de clientes diferentes) ficam fora.</p>';
  }

  let reportDate = null, reportTenant = '';
  window.resultsReportsPage = async function resultsReportsPage() {
    const day = reportDate || today();
    const [d, r] = await Promise.all([
      api('/master/results-reports?date=' + day),
      api('/master/analytics/orders?from=' + day + '&to=' + day + (reportTenant ? '&tenant=' + reportTenant : ''))
    ]);
    const pending = d.due.filter(r => !r.sent).length;
    const sched = d.schedules.map(s => '<tr><td>' + safe(s.name) + '</td><td><select data-sched="' + safe(s.tenant_id) + '"><option value="off"' + (s.results_report === 'off' ? ' selected' : '') + '>Desligado</option><option value="daily"' + (s.results_report === 'daily' ? ' selected' : '') + '>Todo dia</option><option value="weekly"' + (s.results_report === 'weekly' ? ' selected' : '') + '>Toda semana</option></select></td><td><select data-weekday="' + safe(s.tenant_id) + '"' + (s.results_report !== 'weekly' ? ' disabled' : '') + '>' + WEEKDAYS.map((w, i) => '<option value="' + i + '"' + (i === s.results_report_weekday ? ' selected' : '') + '>' + w + '</option>').join('') + '</select></td></tr>').join('');
    render('<section class="ct-card"><div class="ct-card-head"><h2>Relatório do dia · ' + safe(dmy(day)) + (day === today() ? ' (hoje, até agora)' : '') + '</h2>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><select id="rpStore" style="margin:0;max-width:220px"><option value="">Todas as lojas</option>' + d.schedules.map(s => '<option value="' + safe(s.tenant_id) + '"' + (s.tenant_id === reportTenant ? ' selected' : '') + '>' + safe(s.name) + '</option>').join('') + '</select>'
      + '<button type="button" class="secondary" id="rpPrev" aria-label="Dia anterior" title="Dia anterior">‹</button><input type="date" id="rpDate" value="' + day + '" max="' + today() + '" style="margin:0;max-width:170px"><button type="button" class="secondary" id="rpNext" aria-label="Próximo dia" title="Próximo dia"' + (day >= today() ? ' disabled' : '') + '>›</button>'
      + '<button type="button" class="secondary" id="rpCsv">Baixar (CSV)</button></div></div>'
      + dayReport(r, day, !reportTenant) + '</section>'
      + '<section class="ct-card"><div class="ct-card-head"><h2>Mensagens de resultados ' + (day === today() ? 'para enviar hoje' : 'de ' + safe(dmy(day))) + ' · ' + (d.due.length ? (pending ? pending + ' pendente(s)' : 'tudo enviado') : 'nenhuma programada') + '</h2></div>'
      + '<p>Mensagens prontas com os resultados de cada loja (aparecem só no dia programado de cada uma; veja a programação abaixo). Revise, toque em <strong>Enviar no WhatsApp</strong> e a mensagem abre na conversa com o lojista. Diário = resultados de ontem; semanal = últimos 7 dias.</p>'
      + (d.due.length ? d.due.map(r => reportCard(r, { markable: true })).join('') : '<p class="ct-empty">Nenhum relatório programado para este dia.</p>') + '</section>'
      + '<section class="ct-card"><h2>Gerar agora para uma loja</h2><div style="display:flex;flex-wrap:wrap;gap:12px;align-items:end"><label style="margin:0">Loja<select id="rpTenant">' + d.schedules.map(s => '<option value="' + safe(s.tenant_id) + '">' + safe(s.name) + '</option>').join('') + '</select></label>'
      + '<label style="margin:0">Período<select id="rpKind"><option value="weekly">Últimos 7 dias</option><option value="daily">Ontem</option></select></label><button type="button" id="rpGen">Gerar mensagem</button></div><div id="rpPreview" style="margin-top:14px"></div></section>'
      + '<section class="ct-card"><h2>Programação por loja</h2><div style="overflow-x:auto"><table><thead><tr><th>Loja</th><th>Relatório de resultados</th><th>Dia da semana</th></tr></thead><tbody>' + sched + '</tbody></table></div></section>'
      + '<section class="ct-card"><h2>Modelo da mensagem</h2><p>Campos que viram números: ' + d.placeholders.map(p => '<code>{' + safe(p) + '}</code>').join(' ') + '</p>'
      + '<textarea id="rpTemplate" rows="9" style="max-width:none">' + safe(d.template) + '</textarea><div style="margin-top:8px"><button type="button" id="rpSave">Salvar modelo</button><button type="button" class="secondary" id="rpDefault">Voltar ao modelo padrão</button></div></section>');
    const go = n => { reportDate = shift(day, n); resultsReportsPage().catch(e => msg(e.message)); };
    el('rpPrev').onclick = () => go(-1); el('rpNext').onclick = () => go(1);
    el('rpDate').onchange = () => { if (el('rpDate').value) { reportDate = el('rpDate').value; resultsReportsPage().catch(e => msg(e.message)); } };
    el('rpStore').onchange = () => { reportTenant = el('rpStore').value; resultsReportsPage().catch(e => msg(e.message)); };
    el('rpCsv').onclick = () => downloadCsv('order', { from: day, last: day }, reportTenant).catch(e => msg(e.message));
    wireCards(d.due, { markable: true, reload: resultsReportsPage });
    el('rpGen').onclick = async () => {
      try {
        const r = await api('/master/results-reports/preview?tenant=' + el('rpTenant').value + '&kind=' + el('rpKind').value);
        r.schedule = el('rpKind').value;
        el('rpPreview').innerHTML = reportCard(r, { markable: false });
        wireCards([r], { markable: false, reload: async () => {} });
      } catch (e) { msg(e.message); }
    };
    document.querySelectorAll('[data-sched]').forEach(sel => sel.onchange = async () => {
      try { await api('/master/tenants/' + sel.dataset.sched + '/results-report', 'PATCH', { results_report: sel.value }); msg('Programação salva.'); await resultsReportsPage(); } catch (e) { msg(e.message); }
    });
    document.querySelectorAll('[data-weekday]').forEach(sel => sel.onchange = async () => {
      try { await api('/master/tenants/' + sel.dataset.weekday + '/results-report', 'PATCH', { results_report: 'weekly', results_report_weekday: Number(sel.value) }); msg('Dia da semana salvo.'); await resultsReportsPage(); } catch (e) { msg(e.message); }
    });
    el('rpSave').onclick = async () => { try { await api('/master/analytics/settings', 'PATCH', { store_report_template: el('rpTemplate').value }); msg('Modelo salvo.'); await resultsReportsPage(); } catch (e) { msg(e.message); } };
    el('rpDefault').onclick = async () => { if (!confirm('Voltar ao modelo padrão?')) return; try { await api('/master/analytics/settings', 'PATCH', { store_report_template: null }); msg('Modelo padrão restaurado.'); await resultsReportsPage(); } catch (e) { msg(e.message); } };
  };
})();
