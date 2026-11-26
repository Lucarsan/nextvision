// Vídeos de treinamento: player com controle do que foi assistido, lista no quiosque (com o PIN da vendedora),
// "Meus treinamentos" e "Quem já assistiu" no painel da rede, e cadastro dos vídeos na Central.
// window.fpTraining({ box, mode: 'kiosk'|'network'|'master', api, networkId? })
(() => {
  const css = `.tr{display:grid;gap:16px}.tr table{width:100%;border-collapse:collapse}.tr th,.tr td{padding:8px 10px;border-bottom:1px solid rgba(127,127,127,.2);text-align:left;vertical-align:middle}
  .tr th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;opacity:.7}.tr .soft{opacity:.7;font-size:13px}.tr h3{margin:0 0 6px;font-size:16px}
  .tr .vid{border:1px solid rgba(127,127,127,.25);border-radius:12px;padding:14px 16px;display:grid;gap:10px}.tr .vh{display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between}
  .tr button,.trd button{font:inherit;font-size:14px;padding:8px 14px;border-radius:9px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer}
  .tr button.main,.trd button.main{background:#1f2937;color:#fff;border-color:#1f2937}.tr .people{display:flex;flex-wrap:wrap;gap:8px}
  .tr .chip{display:inline-flex;gap:6px;align-items:center;padding:5px 11px;border-radius:99px;border:1px solid rgba(127,127,127,.35);font-size:13px;background:transparent;cursor:pointer}
  .tr .pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}.tr .ok{background:#dff3e6;color:#16613a}.tr .wip{background:#fff1d6;color:#7a4b00}.tr .no{background:rgba(127,127,127,.15)}
  .tr .seg,.trd .seg{height:8px;border-radius:9px;background:rgba(127,127,127,.18);overflow:hidden;min-width:120px}.tr .seg i,.trd .seg i{display:block;height:100%}
  .tr .filters{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.tr select,.tr input,.tr textarea{font:inherit;padding:7px 9px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit}
  .tr tr.person{cursor:pointer}.tr tr.det td{background:rgba(127,127,127,.06)}.tr .chs{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px 18px;padding:4px 0}
  .tr .form{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.tr .form label{display:grid;gap:4px;font-size:13px}.tr .msg{min-height:1.2em}
  dialog.trd{width:min(980px,96vw);border:0;border-radius:14px;padding:0;background:#111;color:#eee}dialog.trd::backdrop{background:rgba(0,0,0,.65)}
  .trd .top{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 16px}.trd video{width:100%;max-height:68vh;background:#000;display:block}
  .trd .info{padding:10px 16px 14px;display:grid;gap:8px}.trd .chl{display:flex;flex-wrap:wrap;gap:6px}.trd .chl button{font-size:12px;padding:4px 9px;color:#eee;border-color:#555}
  .trd button{color:#eee;border-color:#555}.trd .pin{padding:22px;display:grid;gap:12px;justify-items:center}.trd .pin input{font-size:28px;letter-spacing:12px;width:170px;text-align:center;padding:8px;border-radius:10px;border:1px solid #555;background:#000;color:#fff}`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mmss = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const day = d => d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const KIND = { seller: 'Vendedora', supervisor: 'Supervisor', owner: 'Gestão' };
  function addCss() { if (!document.getElementById('tr-css')) { const s = document.createElement('style'); s.id = 'tr-css'; s.textContent = css; document.head.appendChild(s); } }
  // Barra com os trechos assistidos (verde) e não assistidos (cinza).
  function segBar(seen) {
    if (!seen) return '<div class="seg"></div>';
    const n = seen.length, stops = []; let i = 0;
    while (i < n) { let j = i; while (j < n && seen[j] === seen[i]) j++; const c = seen[i] === '1' ? '#2e9d5b' : 'transparent'; stops.push(`${c} ${(i * 100 / n).toFixed(2)}% ${(j * 100 / n).toFixed(2)}%`); i = j; }
    return '<div class="seg"><i style="background:linear-gradient(90deg,' + stops.join(',') + ')"></i></div>';
  }
  function status(w, done) {
    if (!w) return '<span class="pill no">Não assistiu</span>';
    if (w.completed_at) return '<span class="pill ok">Viu até o final</span>';
    return '<span class="pill wip">' + w.percent + '% assistido</span>';
  }

  // ---------- Player ----------
  // start(): pede ao servidor o link e o passe. Conta só os trechos que passam tocando (sem pular).
  function play({ api, start, title, onClose }) {
    addCss();
    const d = document.createElement('dialog'); d.className = 'trd';
    d.innerHTML = '<div class="top"><strong>' + esc(title) + '</strong><button type="button" data-x>Fechar</button></div><div class="body"><p class="pin">Abrindo o vídeo…</p></div>';
    document.body.appendChild(d); d.showModal();
    let s = null, video = null, pending = new Set(), lastT = null, timer = null, closed = false;
    const body = d.querySelector('.body');
    let chain = Promise.resolve();
    const send = () => (chain = chain.then(sendNow));
    const sendNow = async () => {
      if (!s || !video) return;
      const list = [...pending]; pending = new Set();
      try {
        const r = await api('/training/progress', 'POST', { token: s.token, buckets: list, position: Math.floor(video.currentTime) });
        info(r);
      } catch (e) { list.forEach(i => pending.add(i)); d.querySelector('.st').textContent = e.message; }
    };
    const info = r => {
      if (!r) return;
      const el = d.querySelector('.st'); if (!el) return;
      el.innerHTML = r.completed_at ? '<b style="color:#6fd39a">✓ Treinamento concluído: assistiu até o final.</b>' : 'Assistido: <b>' + r.percent + '%</b> · conta como concluído ao chegar em ' + s.done_percent + '%. Pular para frente não conta.';
    };
    const close = async () => { if (closed) return; closed = true; clearInterval(timer); if (video) video.pause(); await send(); d.close(); d.remove(); onClose?.(); };
    d.querySelector('[data-x]').onclick = close; d.addEventListener('cancel', e => { e.preventDefault(); close(); });
    (async () => {
      try { s = await start(body); } catch (e) { body.innerHTML = '<p class="pin">' + esc(e.message) + '</p>'; return; }
      if (!s || closed) return;
      const v = s.video, w = s.view;
      body.innerHTML = '<video controls playsinline preload="metadata" controlsList="nodownload" disablepictureinpicture></video><div class="info"><div class="st soft"></div>'
        + (v.chapters?.length ? '<div class="chl">' + v.chapters.map(c => '<button type="button" data-t="' + c.t + '">' + mmss(c.t) + ' · ' + esc(c.title) + '</button>').join('') + '</div>' : '') + '</div>';
      video = body.querySelector('video'); video.src = s.src;
      video.addEventListener('contextmenu', e => e.preventDefault());
      info({ percent: w?.percent || 0, completed_at: w?.completed_at });
      video.addEventListener('loadedmetadata', () => { if (w?.position && w.position < v.duration_s - 5 && !w.completed_at) video.currentTime = w.position; }, { once: true });
      body.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { video.currentTime = Number(b.dataset.t); video.play(); });
      video.addEventListener('seeking', () => { lastT = null; });
      video.addEventListener('pause', () => { lastT = null; send(); });
      video.addEventListener('ended', () => { lastT = null; send(); });
      video.addEventListener('timeupdate', () => {
        if (video.paused || video.seeking) { lastT = null; return; }
        const t = video.currentTime;
        if (lastT !== null && t > lastT && t - lastT < 1.5 * (video.playbackRate || 1)) {
          for (let b = Math.floor(lastT / s.bucket_s); b <= Math.floor(t / s.bucket_s); b++) pending.add(b);
        }
        lastT = t;
      });
      // Aba escondida ou janela minimizada: pausa (não conta vídeo rodando sozinho).
      document.addEventListener('visibilitychange', () => { if (document.hidden && video && !video.paused) video.pause(); });
      timer = setInterval(() => { if (pending.size) send(); }, 10000);
      video.play().catch(() => { });
    })();
  }

  window.fpTraining = function fpTraining({ box, mode, api, networkId }) {
    if (!box) return;
    addCss();
    box.classList.add('tr');
    let data = null, rep = null, unitF = '', stateF = '';
    const ctl = { reload: () => load() };

    // ---------- Quiosque ----------
    function drawKiosk() {
      if (!data.videos.length) { box.innerHTML = '<p class="soft">Nenhum vídeo de treinamento por enquanto.</p>'; return; }
      box.innerHTML = data.videos.map(v => {
        const people = data.sellers.map(p => { const w = p.views[v.id]; return '<button type="button" class="chip" data-v="' + esc(v.id) + '" data-s="' + esc(p.id) + '">' + (w?.completed_at ? '✓ ' : w ? '◐ ' : '○ ') + esc(p.name) + (w && !w.completed_at ? ' · ' + w.percent + '%' : '') + '</button>'; }).join('');
        return '<div class="vid"><div class="vh"><div><h3>' + esc(v.title) + '</h3><div class="soft">' + mmss(v.duration_s) + (v.chapters?.length ? ' · ' + v.chapters.length + ' partes' : '') + (v.description ? ' · ' + esc(v.description) : '') + '</div></div></div>'
          + '<div class="soft">Toque no seu nome para assistir. ✓ viu até o final · ◐ começou · ○ não assistiu</div><div class="people">' + (people || '<span class="soft">Nenhuma vendedora cadastrada nesta unidade.</span>') + '</div></div>';
      }).join('');
      box.querySelectorAll('[data-s]').forEach(b => b.onclick = () => {
        const v = data.videos.find(x => x.id === b.dataset.v), p = data.sellers.find(x => x.id === b.dataset.s);
        play({ api, title: v.title + ' · ' + p.name, onClose: load, start: body => new Promise((res, rej) => {
          body.innerHTML = '<div class="pin"><div>Digite o PIN de <b>' + esc(p.name) + '</b></div><input type="password" inputmode="numeric" maxlength="4" autocomplete="off"><div class="soft pm"></div><button type="button" class="main">Assistir</button></div>';
          const inp = body.querySelector('input'), go = async () => {
            if (!/^\d{4}$/.test(inp.value)) { body.querySelector('.pm').textContent = 'O PIN tem 4 números.'; return; }
            try { res(await api('/store/kiosk/training/' + v.id + '/start', 'POST', { seller_id: p.id, pin: inp.value })); }
            catch (e) { body.querySelector('.pm').textContent = e.message; inp.value = ''; inp.focus(); }
          };
          body.querySelector('button').onclick = go; inp.onkeydown = e => { if (e.key === 'Enter') go(); }; setTimeout(() => inp.focus(), 30);
        }) });
      });
    }

    // ---------- Painel da rede ----------
    function drawNetwork() {
      const mine = data.videos.length ? data.videos.map(v => '<div class="vid"><div class="vh"><div><h3>' + esc(v.title) + '</h3><div class="soft">' + mmss(v.duration_s) + (v.description ? ' · ' + esc(v.description) : '') + '</div></div>'
        + '<div style="display:flex;gap:10px;align-items:center">' + status(v.view) + '<button type="button" class="main" data-play="' + esc(v.id) + '">' + (v.view && !v.view.completed_at ? 'Continuar' : 'Assistir') + '</button></div></div>' + (v.view ? segBar(v.view.seen) : '') + '</div>').join('')
        : '<p class="soft">Nenhum vídeo para você por enquanto.</p>';
      let report = '';
      if (rep && rep.videos.length) {
        const units = new Map(rep.units.map(u => [u.id, u.label]));
        const unitOf = p => p.kind === 'seller' ? units.get(p.unit_id) || '' : p.kind === 'supervisor' ? (p.unit_ids || []).map(i => units.get(i)).filter(Boolean).join(', ') : 'Rede';
        const people = rep.people.filter(p => (!unitF || p.unit_id === unitF || (p.unit_ids || []).includes(unitF)) && (!stateF || Object.values(p.views).some(w => stateF === 'done' ? w?.completed_at : stateF === 'wip' ? w && !w.completed_at : !w)));
        const total = rep.people.reduce((a, p) => a + Object.keys(p.views).length, 0), done = rep.people.reduce((a, p) => a + Object.values(p.views).filter(w => w?.completed_at).length, 0);
        report = '<section><h3>Quem já assistiu</h3><p class="soft">' + done + ' de ' + total + ' treinamentos concluídos. Clique na pessoa para ver quais partes ela viu. A barra verde mostra os trechos assistidos de verdade.</p>'
          + '<div class="filters"><select data-f="unit"><option value="">Todas as unidades</option>' + rep.units.map(u => '<option value="' + esc(u.id) + '"' + (u.id === unitF ? ' selected' : '') + '>' + esc(u.label) + '</option>').join('') + '</select>'
          + '<select data-f="state"><option value="">Todas as situações</option><option value="none"' + (stateF === 'none' ? ' selected' : '') + '>Não assistiu</option><option value="wip"' + (stateF === 'wip' ? ' selected' : '') + '>Começou e parou</option><option value="done"' + (stateF === 'done' ? ' selected' : '') + '>Viu até o final</option></select></div>'
          + '<div style="overflow:auto"><table><thead><tr><th>Pessoa</th><th>Unidade</th>' + rep.videos.map(v => '<th>' + esc(v.title) + '</th>').join('') + '</tr></thead><tbody>'
          + (people.map(p => '<tr class="person" data-p="' + esc(p.id) + '"><td><b>' + esc(p.name) + '</b><div class="soft">' + KIND[p.kind] + '</div></td><td>' + esc(unitOf(p)) + '</td>'
            + rep.videos.map(v => { if (!(v.id in p.views)) return '<td class="soft">—</td>'; const w = p.views[v.id]; return '<td>' + status(w) + (w ? segBar(w.seen) + '<div class="soft">' + (w.completed_at ? 'Concluiu ' + day(w.completed_at) : 'Última vez ' + day(w.last_at)) + '</div>' : '') + '</td>'; }).join('') + '</tr>'
            + '<tr class="det" data-d="' + esc(p.id) + '" hidden><td colspan="' + (2 + rep.videos.length) + '">' + rep.videos.filter(v => p.views[v.id]?.chapters?.length).map(v => '<div style="margin:6px 0"><b>' + esc(v.title) + '</b><div class="chs">'
              + p.views[v.id].chapters.map(c => '<div>' + (c.percent >= 90 ? '✓' : c.percent ? '◐' : '○') + ' ' + mmss(c.t) + ' · ' + esc(c.title) + ' <span class="soft">' + c.percent + '%</span></div>').join('') + '</div></div>').join('')
              + (rep.videos.some(v => p.views[v.id]?.chapters?.length) ? '' : '<span class="soft">' + (Object.values(p.views).some(Boolean) ? 'Este vídeo não tem partes cadastradas; a barra acima mostra os trechos vistos.' : 'Ainda não abriu nenhum vídeo.') + '</span>') + '</td></tr>').join('')
            || '<tr><td colspan="' + (2 + rep.videos.length) + '" class="soft">Ninguém nesta seleção.</td></tr>')
          + '</tbody></table></div></section>';
      }
      box.innerHTML = '<section><h3>Meus treinamentos</h3><div style="display:grid;gap:10px">' + mine + '</div></section>' + report;
      box.querySelectorAll('[data-play]').forEach(b => b.onclick = () => { const v = data.videos.find(x => x.id === b.dataset.play); play({ api, title: v.title, onClose: load, start: () => api('/network/training/' + v.id + '/start', 'POST', {}) }); });
      box.querySelectorAll('tr.person').forEach(r => r.onclick = () => { const det = box.querySelector('tr[data-d="' + r.dataset.p + '"]'); det.hidden = !det.hidden; });
      box.querySelector('[data-f="unit"]')?.addEventListener('change', e => { unitF = e.target.value; drawNetwork(); });
      box.querySelector('[data-f="state"]')?.addEventListener('change', e => { stateF = e.target.value; drawNetwork(); });
    }

    // ---------- Central ----------
    function drawMaster() {
      const list = data.videos.map(v => '<tr><td><b>' + esc(v.title) + '</b><div class="soft">' + esc(v.object_key || v.url) + (v.all_networks ? ' · todas as redes' : '') + '</div></td><td>' + mmss(v.duration_s) + '</td><td>' + (v.chapters?.length || 0) + '</td><td>' + v.audiences.map(a => KIND[a]).join(', ') + '</td>'
        + '<td>v' + v.version + '</td><td>' + v.completed + ' concluíram · ' + v.started + ' abriram</td><td>' + (v.active ? 'Ativo' : 'Oculto') + '</td><td><button type="button" data-ed="' + esc(v.id) + '">Editar</button></td></tr>').join('');
      box.innerHTML = (data.r2 ? '' : '<p class="soft"><b>R2 não configurado no servidor.</b> Configure R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY e R2_BUCKET no Render.</p>')
        + (list ? '<div style="overflow:auto"><table><thead><tr><th>Vídeo</th><th>Duração</th><th>Partes</th><th>Quem assiste</th><th>Versão</th><th>Andamento</th><th></th><th></th></tr></thead><tbody>' + list + '</tbody></table></div>' : '<p class="soft">Nenhum vídeo cadastrado para esta rede.</p>')
        + '<details><summary style="cursor:pointer;font-weight:600;padding:8px 0" data-fs>Cadastrar vídeo</summary><div class="form" style="margin-top:8px">'
        + '<label>Título<input data-i="title" maxlength="120"></label><label>Arquivo no R2 (nome do objeto)<input data-i="object_key" placeholder="audace/consultoras-paineis-v1.mp4"></label>'
        + '<label>Duração (segundos)<input data-i="duration_s" type="number" min="5"></label><label>Descrição<input data-i="description" maxlength="600"></label>'
        + '<label style="grid-column:1/-1">Partes (uma por linha: 0:00 Título)<textarea data-i="chapters" rows="5" placeholder="0:00 Abertura do caixa&#10;2:15 Venda e PIN"></textarea></label>'
        + '<label>Quem assiste<select data-i="audiences" multiple size="3"><option value="seller" selected>Vendedora</option><option value="supervisor" selected>Supervisor</option><option value="owner" selected>Gestão</option></select></label>'
        + '<label style="align-self:end"><span><input type="checkbox" data-i="new_version"> Vídeo regravado: todos assistem de novo</span></label></div>'
        + '<div class="filters" style="margin-top:10px"><button type="button" data-a="test">Testar o vídeo e ler a duração</button><button type="button" class="main" data-a="save">Salvar</button><button type="button" data-a="clear">Limpar</button><span class="msg soft"></span></div><video data-pv controls preload="metadata" style="max-width:420px;margin-top:10px" hidden></video></details>';
      const $i = k => box.querySelector('[data-i="' + k + '"]'), msg = t => box.querySelector('.msg').textContent = t;
      let editing = null;
      const parseCh = s => s.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})\s+(.+)$/.exec(l); if (!m) throw Error('Parte inválida: "' + l + '". Use 2:15 Título'); return { t: (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]), title: m[4].slice(0, 80) }; });
      box.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => {
        const v = data.videos.find(x => x.id === b.dataset.ed); editing = v.id;
        box.querySelector('details').open = true; box.querySelector('[data-fs]').textContent = 'Editar: ' + v.title;
        $i('title').value = v.title; $i('object_key').value = v.object_key || ''; $i('duration_s').value = v.duration_s; $i('description').value = v.description || '';
        $i('chapters').value = (v.chapters || []).map(c => mmss(c.t) + ' ' + c.title).join('\n');
        [...$i('audiences').options].forEach(o => o.selected = v.audiences.includes(o.value)); $i('new_version').checked = false;
      });
      box.querySelector('[data-a="clear"]').onclick = () => { editing = null; drawMaster(); };
      box.querySelector('[data-a="test"]').onclick = async () => {
        try {
          const r = await api('/master/training/preview', 'POST', { object_key: $i('object_key').value.trim() });
          const pv = box.querySelector('[data-pv]'); pv.hidden = false; pv.src = r.src; msg('Carregando…');
          pv.onloadedmetadata = () => { $i('duration_s').value = Math.round(pv.duration); msg('Vídeo abriu: ' + mmss(pv.duration) + '.'); };
          pv.onerror = () => msg('O vídeo não abriu. Confira o nome do arquivo no R2.');
        } catch (e) { msg(e.message); }
      };
      box.querySelector('[data-a="save"]').onclick = async () => {
        try {
          const body = { title: $i('title').value.trim(), object_key: $i('object_key').value.trim() || null, duration_s: Number($i('duration_s').value), description: $i('description').value.trim() || null,
            chapters: parseCh($i('chapters').value), audiences: [...$i('audiences').selectedOptions].map(o => o.value) };
          if (editing) await api('/master/training/' + editing, 'PATCH', { ...body, new_version: $i('new_version').checked });
          else await api('/master/networks/' + networkId + '/training', 'POST', body);
          editing = null; await load(); msg('Salvo.');
        } catch (e) { msg(e.message); }
      };
    }

    async function load() {
      try {
        if (mode === 'kiosk') { data = await api('/store/kiosk/training'); drawKiosk(); }
        else if (mode === 'network') { [data, rep] = await Promise.all([api('/network/training'), api('/network/training/report')]); drawNetwork(); }
        else { data = await api('/master/networks/' + networkId + '/training'); drawMaster(); }
      } catch (e) { box.innerHTML = '<p class="soft">' + esc(e.message) + '</p>'; }
    }
    load();
    return ctl;
  };
  window.fpTraining.play = play;
})();
