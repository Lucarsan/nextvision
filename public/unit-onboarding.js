// Implantação por unidade: quadro das unidades + checklist de cada uma.
// Usado no painel da rede (dono e supervisores) e na Central → Redes (FicouPronto).
// window.fpOnboarding({ box, mode: 'network'|'master', api, networkId?, networkName?, onChange? })
(() => {
  const css = `.ob{display:grid;gap:14px}.ob a{color:inherit}.ob table{width:100%;border-collapse:collapse}.ob th,.ob td{padding:8px 10px;border-bottom:1px solid rgba(127,127,127,.2);text-align:left;vertical-align:top}
  .ob th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;opacity:.7}.ob .bar{height:8px;border-radius:9px;background:rgba(127,127,127,.2);overflow:hidden;min-width:90px}.ob .bar i{display:block;height:100%;background:#2e9d5b}
  .ob .pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}.ob .p-ok{background:#dff3e6;color:#16613a}.ob .p-bill{background:#e3ecff;color:#1d3f8f}.ob .p-wip{background:#fff1d6;color:#7a4b00}.ob .p-acc{background:#16613a;color:#fff}
  .ob details{border:1px solid rgba(127,127,127,.25);border-radius:12px;padding:0 14px}.ob summary{cursor:pointer;padding:12px 0;font-weight:600;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .ob h4{margin:14px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;opacity:.75}.ob .it{display:grid;grid-template-columns:26px 1fr auto;gap:8px;padding:8px 0;border-top:1px solid rgba(127,127,127,.12)}
  .ob .st{font-size:16px;line-height:1.3;text-align:center}.ob .st.done{color:#2e9d5b}.ob .st.waiting{color:#b7791f}.ob .st.pending{opacity:.45}.ob .soft{opacity:.7;font-size:13px}.ob .who{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid rgba(127,127,127,.35);margin-left:6px;white-space:nowrap}
  .ob .acts{display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start}.ob .acts button,.ob .foot button{font:inherit;font-size:13px;padding:5px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer}
  .ob .foot{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 0 14px;border-top:1px solid rgba(127,127,127,.2);margin-top:6px}.ob .foot .main{background:#16613a;color:#fff;border-color:#16613a}.ob .msg{min-height:1.2em}`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = d => d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' }) : '';
  const dayIso = s => s ? s.slice(0, 10).split('-').reverse().join('/') : '';
  const ICON = { done: '✓', waiting: '⏳', na: '—', pending: '○' };
  const STATE = { done: 'Feito', waiting: 'Aguardando a rede', na: 'Não se aplica', pending: 'Falta' };

  window.fpOnboarding = function fpOnboarding({ box, mode, api, networkId, networkName = 'Rede', onChange }) {
    if (!box) return;
    if (!document.getElementById('ob-css')) { const s = document.createElement('style'); s.id = 'ob-css'; s.textContent = css; document.head.appendChild(s); }
    const WHO = { fp: 'FicouPronto', rede: networkName, both: 'Os dois' };
    const open = new Set();
    const path = mode === 'master' ? '/master/networks/' + networkId + '/onboarding' : '/network/onboarding';
    const markPath = (u, k) => (mode === 'master' ? '/master/onboarding/' : '/network/onboarding/') + u + '/items/' + k;
    let data = null;

    function situation(u) {
      if (u.accepted_at) return '<span class="pill p-acc">Aceita em ' + day(u.accepted_at) + '</span>';
      if (u.complete) return '<span class="pill p-ok">Completa · falta o aceite</span>';
      if (u.ready_to_bill) return '<span class="pill p-bill">Nossa parte pronta</span>';
      return '<span class="pill p-wip">Em implantação</span>';
    }
    function itemRow(u, it) {
      const canMark = data.can_mark.includes(it.who) && !(it.auto && it.source === 'auto');
      let acts = '';
      if (canMark) {
        if (it.source === 'manual') acts = '<button type="button" data-a="clear">Desfazer</button>';
        else {
          acts = '<button type="button" data-a="done">Feito</button>';
          if (mode === 'master' && it.who !== 'rede') acts += '<button type="button" data-a="waiting">Aguardando a rede</button>';
          if (mode === 'master') acts += '<button type="button" data-a="na">Não se aplica</button>';
        }
      }
      const by = it.source === 'manual' && it.marked_by ? STATE[it.state] + ' · ' + esc(it.marked_by) + ' em ' + day(it.marked_at) : it.source === 'auto' ? 'Conferido pelo sistema' : '';
      return '<div class="it" data-u="' + esc(u.id) + '" data-k="' + esc(it.key) + '"><div class="st ' + it.state + '" title="' + STATE[it.state] + '">' + ICON[it.state] + '</div>'
        + '<div><div>' + esc(it.title) + '<span class="who">' + esc(WHO[it.who]) + '</span></div>'
        + (it.detail ? '<div class="soft">' + esc(it.detail) + '</div>' : '')
        + (it.note ? '<div class="soft">Obs.: ' + esc(it.note) + '</div>' : '')
        + (by ? '<div class="soft">' + by + '</div>' : '') + '</div>'
        + '<div class="acts">' + acts + '</div></div>';
    }
    function unitCard(u) {
      const secs = data.sections.map((s, i) => { const its = u.items.filter(x => x.section === i); return '<h4>' + (i + 1) + '. ' + esc(s) + '</h4>' + its.map(it => itemRow(u, it)).join(''); }).join('');
      let foot = '';
      if (u.accepted_at) foot += '<span>Aceite de <b>' + esc(u.accepted_by || '—') + '</b> em ' + day(u.accepted_at) + '.</span>';
      else if (mode === 'network') foot += u.complete ? '<button type="button" class="main" data-a="accept">Dar aceite desta unidade</button><span class="soft">Confirma que a unidade está operando conforme o checklist.</span>'
        : '<span class="soft">O aceite libera quando todos os itens estiverem feitos.</span>';
      if (mode === 'master') {
        if (u.accepted_at) foot += '<button type="button" data-a="unaccept">Desfazer aceite</button>';
        if (u.billing_since) foot += '<span>Cobrança liberada desde <b>' + dayIso(u.billing_since) + '</b>.</span>';
        else if (data.billing_account_id) foot += '<button type="button"' + (u.ready_to_bill ? ' class="main"' : '') + ' data-a="bill">Liberar cobrança</button>' + (u.ready_to_bill ? '' : '<span class="soft">Nossa parte ainda não está 100%.</span>');
        else foot += '<span class="soft">Sem cadastro de cobrança desta rede (Central → Cobrança).</span>';
      }
      return '<details data-u="' + esc(u.id) + '"' + (open.has(u.id) ? ' open' : '') + '><summary>' + esc(u.name) + ' ' + situation(u) + '<span class="soft">Nossa parte ' + u.ours_percent + '%</span></summary>'
        + secs + '<div class="foot" data-u="' + esc(u.id) + '">' + foot + '<span class="msg soft"></span></div></details>';
    }
    function draw() {
      const units = data.units;
      if (!units.length) { box.innerHTML = '<p class="soft">Nenhuma unidade.</p>'; return; }
      box.innerHTML = '<div class="ob"><div style="overflow-x:auto"><table><thead><tr><th>Unidade</th><th>Nossa parte</th><th>O que falta (FicouPronto)</th><th>Com a ' + esc(networkName) + '</th><th>Situação</th></tr></thead><tbody>'
        + units.map(u => '<tr><td><a href="#" data-go="' + esc(u.id) + '"><b>' + esc(u.name) + '</b></a></td><td><div class="bar"><i style="width:' + u.ours_percent + '%"></i></div><span class="soft">' + u.ours_ok + ' de ' + u.ours_total + '</span></td>'
          + '<td class="soft">' + (u.missing_ours.length ? u.missing_ours.length + ' itens' + ': ' + esc(u.missing_ours.slice(0, 2).join('; ')) + (u.missing_ours.length > 2 ? '…' : '') : 'Nada') + '</td>'
          + '<td class="soft">' + (u.missing_network.length ? u.missing_network.length + ' itens' : 'Nada') + '</td><td>' + situation(u) + '</td></tr>').join('')
        + '</tbody></table></div>'
        + '<p class="soft" style="margin:0">Itens marcados "Conferido pelo sistema" saem dos dados reais (peças, PINs, notas, pinpad, caixa). Item parado por falta de algo da ' + esc(networkName) + ' fica "Aguardando a rede" e não atrasa o nosso prazo.</p>'
        + units.map(unitCard).join('') + '</div>';
      box.querySelectorAll('[data-go]').forEach(a => a.onclick = e => { e.preventDefault(); const d = box.querySelector('details[data-u="' + a.dataset.go + '"]'); d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      box.querySelectorAll('details').forEach(d => d.ontoggle = () => d.open ? open.add(d.dataset.u) : open.delete(d.dataset.u));
      box.querySelectorAll('.it button').forEach(b => b.onclick = () => act(b));
      box.querySelectorAll('.foot button').forEach(b => b.onclick = () => act(b));
    }
    async function act(b) {
      const row = b.closest('[data-u]'), u = data.units.find(x => x.id === row.dataset.u), a = b.dataset.a;
      const say = t => { const m = box.querySelector('.foot[data-u="' + u.id + '"] .msg'); if (m) m.textContent = t; };
      try {
        if (['done', 'waiting', 'na'].includes(a)) {
          const ask = { done: 'Observação ou evidência (opcional). Ex.: "bipou 20 etiquetas de primeira", "Ana e Bia presentes":', waiting: 'O que falta da rede? (ex.: planilha de clientes, pinpad)', na: 'Por que não se aplica?' }[a];
          const note = prompt(ask, ''); if (note === null) return;
          if (a !== 'done' && !note.trim()) { alert('Escreva o motivo.'); return; }
          await api(markPath(u.id, row.dataset.k), 'PUT', { state: a, ...(note.trim() ? { note: note.trim().slice(0, 300) } : {}) });
        } else if (a === 'clear') {
          if (!confirm('Desfazer esta marcação?')) return;
          await api(markPath(u.id, row.dataset.k), 'PUT', { state: null });
        } else if (a === 'accept') {
          if (!confirm('Dar o aceite da unidade ' + u.name + '?\n\nVocê declara que a unidade está operando com o FicouPronto conforme o checklist. Fica registrado com o seu nome, a data e a hora.')) return;
          await api('/network/onboarding/' + u.id + '/accept', 'POST', { confirm: true });
        } else if (a === 'unaccept') {
          if (!confirm('Desfazer o aceite de ' + u.name + '?')) return;
          await api('/master/onboarding/' + u.id + '/accept', 'DELETE');
        } else if (a === 'bill') {
          if (!u.ready_to_bill && !confirm('A nossa parte de ' + u.name + ' ainda não está 100%. Liberar a cobrança mesmo assim?')) return;
          if (u.ready_to_bill && !confirm('Liberar a cobrança de ' + u.name + '? Mês cheio: a unidade entra inteira na próxima cobrança em aberto.')) return;
          const r = await api('/master/billing/accounts/' + data.billing_account_id + '/units/' + u.id, 'POST', { active: true });
          if (r?.warning) alert(r.warning);
        }
        open.add(u.id); await load(); onChange?.();
      } catch (e) { say(e.message); }
    }
    async function load() {
      try { data = await api(path); draw(); } catch (e) { box.innerHTML = '<p class="soft">' + esc(e.message) + '</p>'; }
    }
    load();
    return { reload: load };
  };
})();
