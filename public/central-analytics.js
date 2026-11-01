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

  // Gráfico simples por dia: pedidos com link (cinza) e aberturas (laranja).
  function chart(days) {
    if (!days.length) return '';
    const W = 760, H = 180, padL = 34, padB = 22, max = Math.max(1, ...days.map(d => Math.max(d.links, d.opens)));
    const bw = (W - padL) / days.length, bar = Math.max(2, Math.min(14, bw / 2 - 2));
    const y = v => H - padB - (H - padB - 8) * v / max;
    const ticks = [0, Math.round(max / 2), max];
    let g = ticks.map(t => '<line x1="' + padL + '" x2="' + W + '" y1="' + y(t) + '" y2="' + y(t) + '" stroke="#EEF0F3"/><text x="' + (padL - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end" font-size="10" fill="#6B7280">' + t + '</text>').join('');
    days.forEach((d, i) => {
      const x = padL + i * bw + bw / 2;
      g += '<rect x="' + (x - bar - 1) + '" y="' + y(d.links) + '" width="' + bar + '" height="' + (H - padB - y(d.links)) + '" rx="2" fill="#CBD2DC"><title>' + dmy(d.day) + ': ' + d.links + ' pedidos com link</title></rect>';
      g += '<rect x="' + (x + 1) + '" y="' + y(d.opens) + '" width="' + bar + '" height="' + (H - padB - y(d.opens)) + '" rx="2" fill="#F25C1F"><title>' + dmy(d.day) + ': ' + d.opens + ' aberturas</title></rect>';
      if (days.length <= 14 || i % Math.ceil(days.length / 10) === 0) g += '<text x="' + x + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="#6B7280">' + d.day.slice(8) + '/' + d.day.slice(5, 7) + '</text>';
    });
    return '<div style="overflow-x:auto"><svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;min-width:520px;height:auto" role="img" aria-label="Pedidos com link e aberturas por dia">' + g + '</svg></div>'
      + '<p class="ct-note"><span style="display:inline-block;width:10px;height:10px;background:#CBD2DC;border-radius:2px"></span> Pedidos com link &nbsp; <span style="display:inline-block;width:10px;height:10px;background:#F25C1F;border-radius:2px"></span> Aberturas</p>';
  }

  async function downloadCsv(group, range) {
    const r = await fetch('/api/master/analytics.csv?group=' + group + '&from=' + range.from + '&to=' + range.last, { headers: { Authorization: 'Bearer ' + token } });
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
      + '<section class="ct-card ct-kpis">'
      + kpi('Pedidos com link', num(t.links), num(t.sent) + ' enviados pelo WhatsApp')
      + kpi('Aberturas do link', num(t.opens), num(t.people) + ' pessoas (aparelhos)')
      + kpi('Links abertos', t.open_rate == null ? '—' : t.open_rate + '%', num(t.links_opened) + ' de ' + num(t.links) + ' pedidos')
      + kpi('Voltaram para ver de novo', num(t.returns), 'clientes que abriram mais de uma vez')
      + kpi('Tempo médio na página', dur(t.avg_visible_seconds), 'por abertura')
      + kpi('Vídeo ao vivo assistido', dur(t.live_seconds), num(t.downloads) + ' vídeos baixados')
      + kpi('Conversas com a loja', num(t.talks), 'cliques em "Falar com a loja"')
      + kpi('Pelo celular', t.opens ? Math.round(t.mobile * 100 / t.opens) + '%' : '—', 'das aberturas')
      + '</section>'
      + '<section class="ct-card"><h2>Por dia</h2>' + chart(d.days) + '</section>'
      + '<section class="ct-card"><div class="ct-card-head"><h2>Por loja</h2><div><button type="button" class="secondary" data-csv="store">Baixar por loja (CSV)</button><button type="button" class="secondary" data-csv="day">Por dia</button><button type="button" class="secondary" data-csv="order">Por pedido</button></div></div>'
      + '<div style="overflow-x:auto"><table><thead><tr><th>Loja</th><th>Pedidos com link</th><th>Enviados</th><th>Aberturas</th><th>Pessoas</th><th>Links abertos</th><th>Retornos</th><th>Tempo médio</th><th>Vídeo assistido</th><th>Downloads</th></tr></thead><tbody>'
      + (d.stores.length ? d.stores.map(s => '<tr><td><div class="ct-store"><strong>' + safe(s.name) + '</strong><span>' + safe(s.slug) + '</span></div></td><td>' + num(s.links) + '</td><td>' + num(s.sent) + '</td><td>' + num(s.opens) + '</td><td>' + num(s.people) + '</td><td>' + (s.open_rate == null ? '—' : s.open_rate + '%') + '</td><td>' + num(s.returns) + '</td><td>' + dur(s.avg_visible_seconds) + '</td><td>' + dur(s.live_seconds) + '</td><td>' + num(s.downloads) + '</td></tr>').join('') : '<tr><td colspan="10" class="ct-empty">Sem dados no período.</td></tr>')
      + '</tbody></table></div><p class="ct-note">Contagem anônima: aberturas são contadas pelo celular do cliente (a prévia do link no WhatsApp não conta). Pessoas = aparelhos diferentes. A medição começou em 31/10/2026; antes disso só existe a quantidade de pedidos.</p></section>'
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

  let reportDate = null;
  window.resultsReportsPage = async function resultsReportsPage() {
    const day = reportDate || today();
    const d = await api('/master/results-reports?date=' + day);
    const pending = d.due.filter(r => !r.sent).length;
    const sched = d.schedules.map(s => '<tr><td>' + safe(s.name) + '</td><td><select data-sched="' + safe(s.tenant_id) + '"><option value="off"' + (s.results_report === 'off' ? ' selected' : '') + '>Desligado</option><option value="daily"' + (s.results_report === 'daily' ? ' selected' : '') + '>Todo dia</option><option value="weekly"' + (s.results_report === 'weekly' ? ' selected' : '') + '>Toda semana</option></select></td><td><select data-weekday="' + safe(s.tenant_id) + '"' + (s.results_report !== 'weekly' ? ' disabled' : '') + '>' + WEEKDAYS.map((w, i) => '<option value="' + i + '"' + (i === s.results_report_weekday ? ' selected' : '') + '>' + w + '</option>').join('') + '</select></td></tr>').join('');
    render('<section class="ct-card"><div class="ct-card-head"><h2>' + (day === today() ? 'Para enviar hoje' : 'Para enviar em ' + safe(dmy(day))) + ' · ' + (d.due.length ? (pending ? pending + ' pendente(s)' : 'tudo enviado') : 'nenhum') + '</h2>'
      + '<div style="display:flex;gap:8px;align-items:center"><button type="button" class="secondary" id="rpPrev" aria-label="Dia anterior" title="Dia anterior">‹</button><input type="date" id="rpDate" value="' + day + '" style="margin:0;max-width:170px"><button type="button" class="secondary" id="rpNext" aria-label="Próximo dia" title="Próximo dia">›</button></div></div>'
      + '<p>Mensagens prontas com os resultados de cada loja. Revise, toque em <strong>Enviar no WhatsApp</strong> e a mensagem abre na conversa com o lojista. Diário = resultados de ontem; semanal = últimos 7 dias.</p>'
      + (d.due.length ? d.due.map(r => reportCard(r, { markable: true })).join('') : '<p class="ct-empty">Nenhum relatório programado para este dia.</p>') + '</section>'
      + '<section class="ct-card"><h2>Gerar agora para uma loja</h2><div style="display:flex;flex-wrap:wrap;gap:12px;align-items:end"><label style="margin:0">Loja<select id="rpTenant">' + d.schedules.map(s => '<option value="' + safe(s.tenant_id) + '">' + safe(s.name) + '</option>').join('') + '</select></label>'
      + '<label style="margin:0">Período<select id="rpKind"><option value="weekly">Últimos 7 dias</option><option value="daily">Ontem</option></select></label><button type="button" id="rpGen">Gerar mensagem</button></div><div id="rpPreview" style="margin-top:14px"></div></section>'
      + '<section class="ct-card"><h2>Programação por loja</h2><div style="overflow-x:auto"><table><thead><tr><th>Loja</th><th>Relatório de resultados</th><th>Dia da semana</th></tr></thead><tbody>' + sched + '</tbody></table></div></section>'
      + '<section class="ct-card"><h2>Modelo da mensagem</h2><p>Campos que viram números: ' + d.placeholders.map(p => '<code>{' + safe(p) + '}</code>').join(' ') + '</p>'
      + '<textarea id="rpTemplate" rows="9" style="max-width:none">' + safe(d.template) + '</textarea><div style="margin-top:8px"><button type="button" id="rpSave">Salvar modelo</button><button type="button" class="secondary" id="rpDefault">Voltar ao modelo padrão</button></div></section>');
    const go = n => { reportDate = shift(day, n); resultsReportsPage().catch(e => msg(e.message)); };
    el('rpPrev').onclick = () => go(-1); el('rpNext').onclick = () => go(1);
    el('rpDate').onchange = () => { if (el('rpDate').value) { reportDate = el('rpDate').value; resultsReportsPage().catch(e => msg(e.message)); } };
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
