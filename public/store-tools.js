// Links úteis (menu abaixo de "Visão geral") e atalhos no topo do painel.
// Abas: Links (acessos rápidos), Dívidas (fiado dos clientes) e Recibos (recibo simples para imprimir na hora).
// Liga junto com "Caixa e mensagens". Tudo fica salvo na loja (vale para todos os computadores e celulares).
(() => {
  const token = sessionStorage.getItem('nv_token');
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const centsText = c => c ? (Number(c) / 100).toFixed(2).replace('.', ',') : '';
  const ic = (n, cls) => window.FPIcon ? FPIcon(n, cls) : '';
  const store = { get(k) { try { return localStorage.getItem('ft_' + k); } catch { return null; } }, set(k, v) { try { localStorage.setItem('ft_' + k, v); } catch { /* sem armazenamento: só não lembra */ } } };
  function parseMoney(v) {
    let s = String(v || '').trim().replace(/[^\d.,]/g, '');
    if (!s) return 0;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = Math.round(Number(s) * 100); return Number.isFinite(n) && n >= 0 ? n : NaN;
  }
  function waPhone(p) {
    let d = String(p || '').replace(/\D/g, '');
    if (d.length >= 11 && d.length <= 12 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 10 || d.length === 11) d = '55' + d;
    return d.length >= 12 ? d : '';
  }
  const phoneBR = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length >= 12 && d.startsWith('55')) d = d.slice(2); return d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : String(p || ''); };
  const storeName = () => ($('storeBrandName')?.textContent || '').trim() || 'Loja';
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const urlKey = u => String(u || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/#?]+$/, '');
  const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  const dmy = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '';
  const today = () => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); };

  async function api(path, method = 'GET', body) {
    const r = await fetch('/api' + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(Error(data.error || 'Não foi possível concluir a operação'), { status: r.status });
    return data;
  }
  function feedback(msg, error) {
    const el = $('panelFeedback'); if (!el) return;
    el.textContent = msg; el.hidden = false; el.classList.toggle('error', !!error);
    clearTimeout(feedback.t); feedback.t = setTimeout(() => { el.hidden = true; el.classList.remove('error'); }, error ? 7000 : 3500);
  }
  async function copy(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* plano B abaixo */ }
    const t = document.createElement('textarea'); t.value = text; t.style.cssText = 'position:fixed;left:-9999px'; document.body.append(t); t.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; } t.remove(); return ok;
  }
  // Imprime num quadro escondido (não mexe na página do painel).
  function printHtml(html) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true'); frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.append(frame);
    const doc = frame.contentDocument; doc.open(); doc.write(html); doc.close();
    const go = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } finally { setTimeout(() => frame.remove(), 60000); } };
    const imgs = [...doc.images].filter(i => !i.complete);
    if (!imgs.length) setTimeout(go, 200); else Promise.all(imgs.map(i => new Promise(r => { i.onload = i.onerror = r; }))).then(() => setTimeout(go, 100));
  }

  let enabled = false, settings = { shortcuts: [], receipt_issuer: {} }, links = null, debts = null;
  let tab = store.get('tab') || 'links';
  const isBasic = () => document.body.classList.contains('fs-basic');

  // ---------------- Atalhos do topo ----------------
  const VIEWS = {
    cash: ['Caixa', 'cash'], links: ['Links úteis', 'link'], messages: ['Mensagens', 'message'], stock: ['Estoque', 'package'],
    orders: ['Pedidos', 'orders'], new_order: ['Novo pedido', 'plus'], customers: ['Clientes', 'users'], queues: ['Filas', 'queues'],
    processes: ['Processos', 'processes'], cameras: ['Câmeras', 'camera'], settings: ['Configurações', 'settings'], plan: ['Meu plano', 'plan'],
    support: ['Suporte', 'support'], home: ['Visão geral', 'home']
  };
  const favicon = u => { const h = host(u); return h ? 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(h) : ''; };
  const favImg = (u, name) => { const f = favicon(u); return f ? `<img class="ft-fav" src="${esc(f)}" alt="" loading="lazy" data-letter="${esc(initials(name)[0])}">` : `<span class="ft-fav ft-fav-letter">${esc(initials(name)[0])}</span>`; };
  // Ícone que não carregou vira a letra inicial.
  document.addEventListener('error', e => { const t = e.target; if (t?.matches?.('img.ft-fav')) { const s = document.createElement('span'); s.className = 'ft-fav ft-fav-letter'; s.textContent = t.dataset.letter || '•'; t.replaceWith(s); } }, true);

  function shortcutHtml(s) {
    if (s.type === 'view') {
      const [label, icon] = VIEWS[s.view] || [s.view, 'zap'];
      return `<button type="button" class="ft-qbtn" data-view="${s.view === 'new_order' ? 'orders' : esc(s.view)}" title="${esc(label)}">${ic(icon)}<span>${esc(label)}</span></button>`;
    }
    if (s.type === 'link') {
      const l = (links || []).find(x => x.id === s.link_id); if (!l) return '';
      return `<a class="ft-qbtn" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" data-ft-open-link="${l.id}" title="${esc(l.name)}">${favImg(l.url, l.name)}<span>${esc(l.name)}</span></a>`;
    }
    return `<a class="ft-qbtn" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.label)}">${favImg(s.url, s.label)}<span>${esc(s.label)}</span></a>`;
  }
  function renderQuick() {
    const top = document.querySelector('.nv-top'); if (!top) return;
    let bar = $('ftQuick');
    if (!bar) { top.classList.add('ft-has-quick'); (top.querySelector('.nv-profile') || top.lastElementChild).insertAdjacentHTML('beforebegin', '<nav class="ft-quick" id="ftQuick" aria-label="Atalhos"></nav>'); bar = $('ftQuick'); }
    bar.innerHTML = settings.shortcuts.map(shortcutHtml).join('') + `<button type="button" class="ft-qbtn ft-qadd" data-ft-quick-edit title="Adicionar ou mudar atalhos">${ic('plus')}<span>Atalho</span></button>`;
    const active = document.querySelector('.nv-menu button.active')?.dataset.view;
    bar.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === active));
  }
  async function editShortcuts() {
    if (!links) { try { links = await api('/store/tools/links'); } catch { links = []; } }
    let list = settings.shortcuts.map(s => ({ ...s }));
    const d = dialog();
    const label = s => s.type === 'view' ? VIEWS[s.view]?.[0] : s.type === 'link' ? (links.find(l => l.id === s.link_id)?.name || 'Link apagado') : s.label;
    const draw = () => {
      const usedViews = new Set(list.filter(s => s.type === 'view').map(s => s.view)), usedLinks = new Set(list.filter(s => s.type === 'link').map(s => s.link_id));
      d.innerHTML = `<form id="ftQuickF" class="ft-form"><div class="nv-heading"><h2>Atalhos no topo</h2><button type="button" class="nv-button secondary fs-small" data-ft-close>Fechar</button></div>
        <p class="nv-help">Aparecem no alto do painel, em todos os computadores da loja. Até 8.</p>
        <ol class="ft-qlist">${list.map((s, i) => `<li><span>${esc(label(s))}</span><span class="ft-qtools">
          <button type="button" class="ft-icon-btn" data-ft-q-up="${i}" title="Subir" ${i ? '' : 'disabled'}>${ic('up')}</button>
          <button type="button" class="ft-icon-btn" data-ft-q-down="${i}" title="Descer" ${i < list.length - 1 ? '' : 'disabled'}>${ic('down')}</button>
          <button type="button" class="ft-icon-btn ft-danger" data-ft-q-del="${i}" title="Tirar">${ic('x')}</button></span></li>`).join('') || '<li class="nv-help">Nenhum atalho.</li>'}</ol>
        ${list.length < 8 ? `<fieldset class="ft-qadd-box"><legend>Acrescentar</legend>
          <select id="ftQuickPick"><option value="">Escolha…</option>
            <optgroup label="Telas do painel">${Object.entries(VIEWS).filter(([k]) => !usedViews.has(k)).map(([k, [n]]) => `<option value="view:${k}">${esc(n)}</option>`).join('')}</optgroup>
            ${links.length ? `<optgroup label="Links úteis">${links.filter(l => !usedLinks.has(l.id)).map(l => `<option value="link:${l.id}">${esc(l.name)}</option>`).join('')}</optgroup>` : ''}
            <option value="url">Outro site (digitar endereço)…</option></select>
          <div id="ftQuickUrl" hidden class="fs-row"><label class="nv-field fs-grow">Nome do botão<input name="label" maxlength="40"></label><label class="nv-field fs-grow">Endereço<input name="url" inputmode="url" placeholder="site.com.br"></label></div>
          <button type="button" class="nv-button secondary" id="ftQuickAdd">${ic('plus')} Acrescentar</button></fieldset>` : ''}
        <div class="ft-actions"><button class="nv-button">Salvar atalhos</button><button type="button" class="nv-button secondary" id="ftQuickReset">Voltar ao padrão</button></div>
        <p role="alert" class="ft-err"></p></form>`;
      const f = $('ftQuickF'), err = f.querySelector('[role=alert]');
      const pick = $('ftQuickPick');
      if (pick) pick.onchange = () => { $('ftQuickUrl').hidden = pick.value !== 'url'; };
      const addBtn = $('ftQuickAdd');
      if (addBtn) addBtn.onclick = () => {
        const v = pick.value; err.textContent = '';
        if (!v) { err.textContent = 'Escolha o que acrescentar.'; return; }
        if (v.startsWith('view:')) list.push({ type: 'view', view: v.slice(5) });
        else if (v.startsWith('link:')) list.push({ type: 'link', link_id: v.slice(5) });
        else { const lb = f.elements.label.value.trim(), u = f.elements.url.value.trim(); if (!lb || !u) { err.textContent = 'Preencha o nome do botão e o endereço.'; return; } list.push({ type: 'url', label: lb, url: u }); }
        draw();
      };
      f.querySelectorAll('[data-ft-q-up]').forEach(b => b.onclick = () => { const i = +b.dataset.ftQUp; [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); });
      f.querySelectorAll('[data-ft-q-down]').forEach(b => b.onclick = () => { const i = +b.dataset.ftQDown; [list[i + 1], list[i]] = [list[i], list[i + 1]]; draw(); });
      f.querySelectorAll('[data-ft-q-del]').forEach(b => b.onclick = () => { list.splice(+b.dataset.ftQDel, 1); draw(); });
      $('ftQuickReset').onclick = () => { list = [{ type: 'view', view: 'cash' }, { type: 'view', view: 'links' }, { type: 'view', view: 'messages' }]; draw(); };
      f.onsubmit = async e => {
        e.preventDefault(); err.textContent = '';
        try { settings.shortcuts = (await api('/store/tools/shortcuts', 'PUT', { shortcuts: list })).shortcuts; renderQuick(); d.close(); feedback('Atalhos salvos.'); }
        catch (ex) { err.textContent = ex.message; }
      };
    };
    draw(); d.showModal();
  }
  function dialog() {
    let d = $('ftDialog');
    if (!d) { d = document.createElement('dialog'); d.id = 'ftDialog'; d.className = 'nv-dialog ft-dialog'; document.body.append(d); d.addEventListener('click', e => { if (e.target.closest('[data-ft-close]')) d.close(); }); }
    d.onclose = null; return d;
  }

  // ---------------- Página ----------------
  let page = null, alive = () => true;
  async function load(view, box, isAlive) {
    alive = isAlive;
    if (!enabled) { box.innerHTML = '<section class="nv-card">Recurso não habilitado para esta loja.</section>'; return; }
    box.innerHTML = `<section class="nv-card ft-page"><div class="ft-tabs" role="tablist">${[['links', 'Links', 'link'], ['debts', 'Dívidas', 'wallet'], ['receipts', 'Recibos', 'receipt']].map(([k, n, i]) => `<button type="button" role="tab" data-ft-tab="${k}" aria-selected="${tab === k}">${ic(i)}${n}</button>`).join('')}</div><div id="ftBody"></div></section>`;
    page = box.querySelector('.ft-page');
    page.querySelectorAll('[data-ft-tab]').forEach(b => b.onclick = () => { tab = b.dataset.ftTab; store.set('tab', tab); page.querySelectorAll('[data-ft-tab]').forEach(x => x.setAttribute('aria-selected', x === b)); drawTab(); });
    await drawTab();
  }
  async function drawTab() {
    const body = $('ftBody'); if (!body) return;
    body.innerHTML = '<p class="nv-help">Carregando…</p>';
    try {
      if (tab === 'debts') { debts = await api('/store/tools/debts'); if (alive()) drawDebts(); }
      else if (tab === 'receipts') drawReceipts();
      else { links = await api('/store/tools/links'); if (alive()) drawLinks(); }
    } catch (e) { body.innerHTML = `<p role="alert" class="ft-err">${esc(e.message)}</p>`; }
  }

  // ---------------- Links ----------------
  let linkQ = '', linkCat = '', linkSort = store.get('linkSort') || 'manual';
  const SORTS = [['manual', 'Ordem manual'], ['az', 'Nome A–Z'], ['za', 'Nome Z–A'], ['recent', 'Mais novos'], ['oldest', 'Mais antigos'], ['clicks', 'Mais usados'], ['opened', 'Abertos por último'], ['domain', 'Por site']];
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  function visibleLinks() {
    const words = norm(linkQ).split(/\s+/).filter(Boolean);
    let out = links.filter(l => (!linkCat || l.categories.includes(linkCat)) && words.every(w => norm([l.name, l.url, l.keywords, ...l.categories].join(' ')).includes(w)));
    const by = {
      manual: (a, b) => a.position - b.position, az: (a, b) => a.name.localeCompare(b.name, 'pt-BR'), za: (a, b) => b.name.localeCompare(a.name, 'pt-BR'),
      recent: (a, b) => b.created_at.localeCompare(a.created_at), oldest: (a, b) => a.created_at.localeCompare(b.created_at), clicks: (a, b) => b.clicks - a.clicks,
      opened: (a, b) => String(b.last_opened_at || '').localeCompare(String(a.last_opened_at || '')), domain: (a, b) => host(a.url).localeCompare(host(b.url))
    }[linkSort] || ((a, b) => a.position - b.position);
    return out.sort((a, b) => (b.pinned - a.pinned) || by(a, b));
  }
  function drawLinks() {
    const body = $('ftBody');
    body.innerHTML = `<div class="ft-bar"><label class="ft-search">${ic('search')}<input id="ftLinkQ" type="search" placeholder="Buscar link ou site" title="Enter abre o primeiro da lista" value="${esc(linkQ)}" autocomplete="off"></label>
      <select id="ftLinkSort" aria-label="Ordenar">${SORTS.map(([k, n]) => `<option value="${k}" ${k === linkSort ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <button type="button" class="nv-button" data-ft-link-new>${ic('plus')} Novo link</button></div>
      <div class="ft-chips" id="ftCats"></div><div class="ft-links" id="ftLinkList"></div>
      <details class="ft-import"><summary>Trazer links e dívidas do painel antigo</summary>${importHtml()}</details>`;
    const q = $('ftLinkQ');
    q.oninput = () => { linkQ = q.value; drawLinkList(); };
    q.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); const a = $('ftLinkList').querySelector('a.ft-link-main'); if (a) a.click(); } };
    $('ftLinkSort').onchange = e => { linkSort = e.target.value; store.set('linkSort', linkSort); drawLinkList(); };
    bindImport(body);
    drawLinkList();
    if (matchMedia('(min-width:701px)').matches) q.focus();
  }
  function drawLinkList() {
    const cats = {}; links.forEach(l => l.categories.forEach(c => { cats[c] = (cats[c] || 0) + 1; }));
    if (linkCat && !cats[linkCat]) linkCat = '';
    $('ftCats').innerHTML = Object.keys(cats).length ? [['', 'Todos', links.length], ...Object.keys(cats).sort((a, b) => a.localeCompare(b, 'pt-BR')).map(c => [c, c, cats[c]])]
      .map(([k, n, c]) => `<button type="button" class="ft-chip" data-ft-cat="${esc(k)}" aria-pressed="${k === linkCat}">${esc(n)} <small>${c}</small></button>`).join('') : '';
    $('ftCats').querySelectorAll('[data-ft-cat]').forEach(b => b.onclick = () => { linkCat = b.dataset.ftCat; drawLinkList(); });
    const list = visibleLinks(), drag = linkSort === 'manual' && !linkQ && !linkCat;
    $('ftLinkList').innerHTML = list.length ? list.map(l => `<div class="ft-link${l.pinned ? ' pinned' : ''}" data-id="${l.id}" ${drag ? 'draggable="true"' : ''}>
        ${drag ? `<span class="ft-grip" title="Arraste para mudar a ordem">${ic('grip')}</span>` : ''}
        <a class="ft-link-main" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" data-ft-open-link="${l.id}" draggable="false">${favImg(l.url, l.name)}<span class="ft-link-txt"><b>${esc(l.name)}</b><small>${esc(host(l.url))}${l.categories.length ? ' · ' + l.categories.map(esc).join(', ') : ''}</small></span></a>
        <span class="ft-link-tools"><button type="button" class="ft-icon-btn${l.pinned ? ' on' : ''}" data-ft-pin="${l.id}" title="${l.pinned ? 'Desafixar' : 'Fixar no começo'}" aria-pressed="${l.pinned}">${ic('star')}</button><button type="button" class="ft-icon-btn" data-ft-link-edit="${l.id}" title="Editar">${ic('edit')}</button></span></div>`).join('')
      : `<p class="nv-help">${links.length ? 'Nenhum link encontrado.' : 'Nenhum link ainda. Use “Novo link” ou traga os do painel antigo (abaixo).'}</p>`;
    if (drag) bindDrag($('ftLinkList'), '.ft-link', ids => api('/store/tools/links/order', 'PUT', { ids }).then(() => { ids.forEach((id, i) => { const l = links.find(x => x.id === id); if (l) l.position = i; }); }).catch(e => feedback(e.message, true)));
  }
  function bindDrag(list, sel, save) {
    let dragged = null;
    list.querySelectorAll(sel).forEach(el => {
      el.addEventListener('dragstart', e => { dragged = el; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', el.dataset.id); } catch { /* ok */ } });
      el.addEventListener('dragend', () => { el.classList.remove('dragging'); if (!dragged) return; dragged = null; save([...list.querySelectorAll(sel)].map(x => x.dataset.id)); });
      el.addEventListener('dragover', e => {
        if (!dragged || dragged === el) return; e.preventDefault();
        const r = el.getBoundingClientRect(), after = (e.clientY - r.top) > r.height / 2 || ((e.clientX - r.left) > r.width / 2 && Math.abs(e.clientY - (r.top + r.height / 2)) < r.height / 2);
        el.parentNode.insertBefore(dragged, after ? el.nextSibling : el);
      });
    });
  }
  function linkForm(l) {
    const d = dialog(), cats = [...new Set(links.flatMap(x => x.categories))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    d.innerHTML = `<form id="ftLinkF" class="ft-form" autocomplete="off"><div class="nv-heading"><h2>${l ? 'Editar link' : 'Novo link'}</h2><button type="button" class="nv-button secondary fs-small" data-ft-close>Fechar</button></div>
      <label class="nv-field">Endereço<input name="url" required inputmode="url" placeholder="Ex.: fornecedor.com.br/pedidos" value="${esc(l?.url || '')}"></label>
      <label class="nv-field">Nome<input name="name" maxlength="120" placeholder="Ex.: Fornecedor de telas" value="${esc(l?.name || '')}"></label>
      <label class="nv-field">Categorias <small>(separe por vírgula)</small><input name="categories" maxlength="400" placeholder="Ex.: Fornecedores, Consultas" value="${esc((l?.categories || []).join(', '))}"></label>
      ${cats.length ? `<div class="ft-chips ft-chips-sm">${cats.map(c => `<button type="button" class="ft-chip" data-ft-addcat="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
      <label class="nv-field">Palavras-chave <small>(ajudam a achar na busca)</small><input name="keywords" maxlength="300" value="${esc(l?.keywords || '')}"></label>
      <label class="ft-check"><input type="checkbox" name="pinned" ${l?.pinned ? 'checked' : ''}> Fixar no começo da lista</label>
      <div class="ft-actions"><button class="nv-button">Salvar</button>${l ? `<button type="button" class="nv-button secondary ft-danger" id="ftLinkDel">${ic('trash')} Apagar</button>` : ''}</div>
      <p role="alert" class="ft-err"></p></form>`;
    const f = $('ftLinkF'), err = f.querySelector('[role=alert]');
    // Sem nome digitado, usa o do site (aparece como sugestão no campo).
    const suggest = () => { const u = f.elements.url.value.trim(), h = u ? host(/^https?:/i.test(u) ? u : 'https://' + u) : ''; return h ? h.split('.')[0].replace(/^./, c => c.toUpperCase()) : ''; };
    f.elements.url.oninput = () => { f.elements.name.placeholder = suggest() || 'Ex.: Fornecedor de telas'; };
    f.querySelectorAll('[data-ft-addcat]').forEach(b => b.onclick = () => { const cur = f.elements.categories.value.split(',').map(s => s.trim()).filter(Boolean); if (!cur.includes(b.dataset.ftAddcat)) cur.push(b.dataset.ftAddcat); f.elements.categories.value = cur.join(', '); });
    f.onsubmit = async e => {
      e.preventDefault(); err.textContent = '';
      const body = { name: f.elements.name.value.trim() || suggest(), url: f.elements.url.value.trim(), categories: f.elements.categories.value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 12), keywords: f.elements.keywords.value.trim(), pinned: f.elements.pinned.checked };
      try {
        if (l) { Object.assign(l, await api('/store/tools/links/' + l.id, 'PATCH', body)); }
        else {
          try { links.push(await api('/store/tools/links', 'POST', body)); }
          catch (ex) {
            if (ex.status !== 409) throw ex;
            const same = links.find(x => urlKey(x.url) === urlKey(/^https?:/i.test(body.url) ? body.url : 'https://' + body.url));
            if (!confirm(`Este endereço já está salvo${same ? ' como “' + same.name + '”' : ''}. Salvar de novo mesmo assim?`)) return;
            links.push(await api('/store/tools/links?allow_duplicate=1', 'POST', body));
          }
        }
        d.close(); drawLinkList(); renderQuick(); feedback('Link salvo.');
      } catch (ex) { err.textContent = ex.message; }
    };
    const del = $('ftLinkDel');
    if (del) del.onclick = async () => {
      if (!confirm(`Apagar o link “${l.name}”?`)) return;
      try { await api('/store/tools/links/' + l.id, 'DELETE'); links = links.filter(x => x.id !== l.id); settings.shortcuts = settings.shortcuts.filter(s => s.link_id !== l.id); d.close(); drawLinkList(); renderQuick(); feedback('Link apagado.'); }
      catch (ex) { err.textContent = ex.message; }
    };
    d.showModal(); (l ? f.elements.name : f.elements.url).focus();
  }

  // ---------------- Trazer do painel antigo ----------------
  function importHtml() {
    return `<div class="ft-import-body"><p class="nv-help">Acrescenta os links e as listas de dívidas do painel antigo. Nada aqui é apagado: links com o mesmo endereço e pessoas com o mesmo nome são pulados. Compras e Telas não são trazidas.</p>
      <div class="fs-row"><label class="nv-field fs-grow">Arquivo de backup do painel antigo (.json)<input type="file" id="ftImpFile" accept=".json,application/json"></label></div>
      <div class="fs-row"><label class="nv-field fs-grow">ou endereço do banco do painel antigo<input id="ftImpUrl" inputmode="url" placeholder="https://…firebaseio.com"></label><button type="button" class="nv-button secondary" id="ftImpFetch">Buscar</button></div>
      <p id="ftImpOut" class="nv-help" role="status"></p></div>`;
  }
  // Formato do painel antigo: links [{name,url,categorias|categoria,keywords,fixado,cliques}], listas [{name,telefone,rows:[{nome,texto,data,valor,pago,feito}]}].
  const arr = v => !v ? [] : Array.isArray(v) ? v.filter(Boolean) : Object.values(v).filter(Boolean);
  const oldMoney = v => { if (v === null || v === undefined || v === '') return 0; const n = typeof v === 'number' ? Math.round(v * 100) : parseMoney(String(v).includes(',') ? v : String(v).replace(/[^\d.]/g, '').replace(/^(\d*\.\d*).*$/, '$1')); return Number.isFinite(n) ? Math.max(0, Math.min(n, 100000000)) : 0; };
  const oldDay = v => { const s = String(v || '').trim(); let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`; m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
  const cut = (v, n) => String(v ?? '').trim().slice(0, n);
  function convertOld(data) {
    const linksIn = arr(data.links).map(l => ({ name: cut(l.name || l.nome || host(l.url) || l.url, 120), url: cut(l.url, 2000), categories: [...new Set((Array.isArray(l.categorias) ? l.categorias : l.categoria ? [l.categoria] : []).map(c => cut(c, 40)).filter(Boolean))].slice(0, 12), keywords: cut(l.keywords, 300), pinned: !!l.fixado, clicks: Math.max(0, Math.floor(Number(l.cliques) || 0)) })).filter(l => l.url);
    const debtorsIn = arr(data.listas).map(x => ({ name: cut(x.name, 120), phone: cut(x.telefone, 30), items: arr(x.rows).map(r => ({ who: cut(r.nome, 120), description: cut(r.texto, 300), day: oldDay(r.data), amount_cents: oldMoney(r.valor), paid_cents: oldMoney(r.pago), done: !!r.feito })) })).filter(x => x.name);
    return { links: linksIn, debtors: debtorsIn };
  }
  async function runImport(data, out) {
    if (!data || (!data.links && !data.listas)) { out.textContent = 'Não encontrei links nem listas nesse conteúdo.'; return; }
    const body = convertOld(data);
    if (!confirm(`Encontrei ${body.links.length} link(s) e ${body.debtors.length} lista(s) de dívidas. Acrescentar aqui?`)) return;
    out.textContent = 'Trazendo…';
    try {
      const r = await api('/store/tools/import', 'POST', body);
      out.textContent = `Pronto: ${r.links_added} link(s) e ${r.debtors_added} lista(s) com ${r.items_added} item(ns) acrescentados. Pulados por já existirem: ${r.links_skipped} link(s), ${r.debtors_skipped} lista(s).`;
      links = await api('/store/tools/links'); if (tab === 'links') drawLinkList(); else { debts = await api('/store/tools/debts'); drawDebtList(); }
    } catch (e) { out.textContent = e.message; }
  }
  function bindImport(root) {
    const out = root.querySelector('#ftImpOut'); if (!out) return;
    root.querySelector('#ftImpFile').onchange = async e => {
      const file = e.target.files[0]; e.target.value = ''; if (!file) return;
      if (file.size > 5000000) { out.textContent = 'Arquivo grande demais (até 5 MB).'; return; }
      let data; try { data = JSON.parse(await file.text()); } catch { out.textContent = 'Não consegui ler esse arquivo. Confira se é o backup (.json) do painel antigo.'; return; }
      runImport(data, out);
    };
    root.querySelector('#ftImpFetch').onclick = async () => {
      let base = root.querySelector('#ftImpUrl').value.trim().replace(/\/+$/, '');
      if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebaseio\.com|firebasedatabase\.app)$/i.test(base)) { out.textContent = 'Informe o endereço do banco do painel antigo (termina em firebaseio.com).'; return; }
      out.textContent = 'Buscando…';
      try {
        const get = async k => { const r = await fetch(`${base}/${k}.json`, { cache: 'no-store' }); if (!r.ok) throw Error('O painel antigo não respondeu (' + r.status + ').'); return r.json(); };
        const [l, d] = await Promise.all([get('links'), get('listas')]);
        runImport({ links: l, listas: d }, out);
      } catch (e) { out.textContent = e.message || 'Não foi possível buscar.'; }
    };
  }

  // ---------------- Dívidas ----------------
  let debtQ = '', debtSort = store.get('debtSort') || 'balance';
  function drawDebts() {
    const body = $('ftBody');
    body.innerHTML = `<div class="ft-kpis" id="ftDebtKpis"></div>
      <div class="ft-bar"><label class="ft-search">${ic('search')}<input id="ftDebtQ" type="search" placeholder="Buscar pessoa, telefone ou item" value="${esc(debtQ)}" autocomplete="off"></label>
        <select id="ftDebtSort" aria-label="Ordenar">${[['balance', 'Maior dívida'], ['az', 'Nome A–Z'], ['recent', 'Mexidas por último'], ['manual', 'Ordem manual']].map(([k, n]) => `<option value="${k}" ${k === debtSort ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <button type="button" class="nv-button" data-ft-debt-new>${ic('plus')} Nova pessoa</button></div>
      <div class="ft-debts" id="ftDebtList"></div>
      <details class="ft-import"><summary>Trazer links e dívidas do painel antigo</summary>${importHtml()}</details>`;
    $('ftDebtQ').oninput = e => { debtQ = e.target.value; drawDebtList(); };
    $('ftDebtSort').onchange = e => { debtSort = e.target.value; store.set('debtSort', debtSort); drawDebtList(); };
    bindImport(body);
    drawDebtList();
  }
  const totals = p => { const total = p.items.reduce((a, i) => a + i.amount_cents, 0), paid = p.items.reduce((a, i) => a + i.paid_cents, 0); return { total, paid, balance: total - paid, open: p.items.filter(i => i.amount_cents - i.paid_cents > 0).length }; };
  function drawDebtList() {
    const list = $('ftDebtList'); if (!list) return;
    const owing = debts.filter(p => totals(p).balance > 0);
    $('ftDebtKpis').innerHTML = `<div><small>Pessoas devendo</small><b>${owing.length}</b></div><div><small>Total em dívidas</small><b class="ft-neg">${brl(owing.reduce((a, p) => a + totals(p).balance, 0))}</b></div><div><small>Listas</small><b>${debts.length}</b></div>`;
    const words = norm(debtQ).split(/\s+/).filter(Boolean);
    const rows = debts.filter(p => words.every(w => norm([p.name, p.phone, String(p.phone).replace(/\D/g, ''), ...p.items.map(i => i.who + ' ' + i.description)].join(' ')).includes(w)));
    const by = { balance: (a, b) => totals(b).balance - totals(a).balance || a.name.localeCompare(b.name, 'pt-BR'), az: (a, b) => a.name.localeCompare(b.name, 'pt-BR'), recent: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)), manual: (a, b) => a.position - b.position }[debtSort];
    rows.sort(by);
    const drag = debtSort === 'manual' && !debtQ;
    list.innerHTML = rows.length ? rows.map(p => { const t = totals(p); return `<div class="ft-debt" data-id="${p.id}" ${drag ? 'draggable="true"' : ''}>
        <button type="button" class="ft-debt-main" data-ft-debt-open="${p.id}"><span class="ft-avatar">${esc(initials(p.name))}</span><span class="ft-debt-txt"><b>${esc(p.name)}</b><small>${p.phone ? esc(phoneBR(p.phone)) + ' · ' : ''}${t.open ? t.open + (t.open === 1 ? ' item em aberto' : ' itens em aberto') : p.items.length ? 'Em dia' : 'Sem itens'}</small></span>
        <span class="ft-debt-val ${t.balance > 0 ? 'ft-neg' : 'ft-pos'}">${t.balance > 0 ? brl(t.balance) : 'Em dia'}</span></button>
        ${waPhone(p.phone) ? `<a class="ft-icon-btn ft-wa" href="https://wa.me/${waPhone(p.phone)}?text=${encodeURIComponent(debtText(p))}" target="_blank" rel="noopener" title="Enviar a lista no WhatsApp">${ic('message')}</a>` : ''}</div>`; }).join('')
      : `<p class="nv-help">${debts.length ? 'Ninguém encontrado.' : 'Nenhuma dívida anotada. Use “Nova pessoa”.'}</p>`;
    if (drag) bindDrag(list, '.ft-debt', ids => api('/store/tools/debts/order', 'PUT', { ids }).then(() => ids.forEach((id, i) => { const p = debts.find(x => x.id === id); if (p) p.position = i; })).catch(e => feedback(e.message, true)));
  }
  function debtText(p) {
    const rows = p.items.filter(r => r.who || r.description || r.amount_cents || r.paid_cents), t = totals(p);
    const lines = [`*${storeName()}*`, `*Lista: ${p.name}*`, ''];
    if (!rows.length) lines.push('(nenhum item)');
    rows.forEach(r => {
      let l = '• ' + [r.who, r.description].map(s => (s || '').trim()).filter(Boolean).join(' - ');
      if (r.day) l += ' (' + dmy(r.day) + ')';
      if (r.amount_cents) l += ': ' + brl(r.amount_cents);
      if (r.amount_cents && r.paid_cents >= r.amount_cents) l += ' ✅ pago';
      else if (r.paid_cents > 0) l += ' | pago ' + brl(r.paid_cents) + ' | falta ' + brl(r.amount_cents - r.paid_cents);
      lines.push(l);
    });
    lines.push('', '*Total:* ' + brl(t.total), '*Pago:* ' + brl(t.paid), '*Saldo devedor:* ' + brl(t.balance));
    return lines.join('\n');
  }
  function newDebtor() {
    const d = dialog();
    d.innerHTML = `<form id="ftDebtorF" class="ft-form" autocomplete="off"><div class="nv-heading"><h2>Nova pessoa</h2><button type="button" class="nv-button secondary fs-small" data-ft-close>Fechar</button></div>
      <label class="nv-field">Nome<input name="name" required maxlength="120"></label>
      <label class="nv-field">WhatsApp <small>(opcional)</small><input name="phone" inputmode="tel" maxlength="30" placeholder="(85) 99999-9999"></label>
      <div class="ft-actions"><button class="nv-button">Criar e anotar</button></div><p role="alert" class="ft-err"></p></form>`;
    const f = $('ftDebtorF'), err = f.querySelector('[role=alert]');
    f.onsubmit = async e => {
      e.preventDefault(); err.textContent = '';
      const name = f.elements.name.value.trim();
      if (debts.some(p => norm(p.name) === norm(name)) && !confirm(`Já existe uma lista de “${name}”. Criar outra mesmo assim?`)) return;
      try { const p = await api('/store/tools/debts', 'POST', { name, phone: f.elements.phone.value.trim() }); debts.unshift(p); drawDebtList(); openDebt(p.id, true); }
      catch (ex) { err.textContent = ex.message; }
    };
    d.showModal(); f.elements.name.focus();
  }
  function itemRow(r) {
    return `<tr data-item="${r.id}" class="${r.done ? 'done' : ''}">
      <td class="ft-c-chk"><input type="checkbox" data-k="done" ${r.done ? 'checked' : ''} title="Recebido" aria-label="Recebido"></td>
      <td><input data-k="who" value="${esc(r.who)}" maxlength="120" placeholder="Nome" aria-label="Nome"></td>
      <td><input data-k="description" value="${esc(r.description)}" maxlength="300" placeholder="O que levou" aria-label="Item"></td>
      <td><input data-k="day" type="date" value="${esc(r.day || '')}" aria-label="Data"></td>
      <td><input data-k="amount_cents" inputmode="decimal" value="${centsText(r.amount_cents)}" placeholder="0,00" class="ft-money" aria-label="Valor"></td>
      <td><input data-k="paid_cents" inputmode="decimal" value="${centsText(r.paid_cents)}" placeholder="0,00" class="ft-money" aria-label="Pago"></td>
      <td class="ft-c-del"><button type="button" class="ft-icon-btn ft-danger" data-ft-item-del="${r.id}" title="Apagar item">${ic('x')}</button></td></tr>`;
  }
  function openDebt(id, addFirst) {
    const p = debts.find(x => x.id === id); if (!p) return;
    const d = dialog(); d.classList.add('ft-wide');
    d.onclose = () => { d.classList.remove('ft-wide'); drawDebtList(); };
    const foot = () => { const t = totals(p); return `<tr><td colspan="4" class="ft-r">Total</td><td>${brl(t.total)}</td><td>${brl(t.paid)}</td><td></td></tr><tr><td colspan="4" class="ft-r"><b>Saldo devedor</b></td><td colspan="2" class="${t.balance > 0 ? 'ft-neg' : 'ft-pos'}"><b>${brl(t.balance)}</b></td><td></td></tr>`; };
    const wa = waPhone(p.phone);
    d.innerHTML = `<div class="ft-form"><div class="nv-heading"><div><h2>${esc(p.name)}</h2><p class="nv-help" style="margin:4px 0 0">${p.phone ? esc(phoneBR(p.phone)) : 'Sem telefone'} · <button type="button" class="fs-link ft-link-btn" data-ft-debtor-edit>Editar nome/telefone</button></p></div><button type="button" class="nv-button secondary fs-small" data-ft-close>Fechar</button></div>
      <div class="ft-table-wrap"><table class="ft-debt-table"><thead><tr><th title="Recebido">✓</th><th>Nome</th><th>Item</th><th>Data</th><th>Valor (R$)</th><th>Pago (R$)</th><th></th></tr></thead>
      <tbody id="ftItems">${p.items.map(itemRow).join('')}</tbody><tfoot id="ftFoot">${foot()}</tfoot></table></div>
      <button type="button" class="nv-button secondary ft-additem" id="ftAddItem">${ic('plus')} Adicionar item</button>
      <div class="ft-actions ft-actions-wrap">
        ${wa ? `<a class="nv-button" id="ftDebtWa" href="#" target="_blank" rel="noopener">${ic('message')} Enviar no WhatsApp</a>` : ''}
        <button type="button" class="nv-button secondary" id="ftDebtCopy">${ic('copy')} Copiar lista</button>
        <button type="button" class="nv-button secondary" id="ftDebtPrint">${ic('printer')} Imprimir / PDF</button>
        <button type="button" class="nv-button secondary" id="ftDebtReceipt">${ic('receipt')} Gerar recibo</button>
        <button type="button" class="nv-button secondary ft-danger" id="ftDebtClear">Limpar lista</button>
        <button type="button" class="nv-button secondary ft-danger" id="ftDebtDel">${ic('trash')} Apagar pessoa</button></div>
      <p role="alert" class="ft-err" id="ftDebtErr"></p></div>`;
    const err = $('ftDebtErr'), tbody = $('ftItems');
    const refresh = () => { $('ftFoot').innerHTML = foot(); const a = $('ftDebtWa'); if (a) a.href = `https://wa.me/${wa}?text=${encodeURIComponent(debtText(p))}`; };
    refresh();
    // Salva cada campo ao sair dele (ou ao marcar a caixa).
    tbody.addEventListener('change', async e => {
      const input = e.target, tr = input.closest('tr[data-item]'); if (!tr) return;
      const item = p.items.find(i => i.id === tr.dataset.item), k = input.dataset.k; if (!item || !k) return;
      let v = input.type === 'checkbox' ? input.checked : input.value.trim();
      if (k.endsWith('_cents')) { v = parseMoney(v); if (Number.isNaN(v)) { err.textContent = 'Valor inválido. Use, por exemplo, 25,90.'; input.focus(); return; } input.value = centsText(v); }
      if (k === 'day') v = v || null;
      err.textContent = '';
      try { Object.assign(item, await api('/store/tools/debt-items/' + item.id, 'PATCH', { [k]: v })); tr.classList.toggle('done', item.done); p.updated_at = new Date().toISOString(); refresh(); }
      catch (ex) { err.textContent = ex.message; }
    });
    tbody.addEventListener('click', async e => {
      const b = e.target.closest('[data-ft-item-del]'); if (!b) return;
      const item = p.items.find(i => i.id === b.dataset.ftItemDel);
      if ((item.description || item.amount_cents) && !confirm('Apagar este item?')) return;
      try { await api('/store/tools/debt-items/' + item.id, 'DELETE'); p.items = p.items.filter(i => i !== item); b.closest('tr').remove(); refresh(); }
      catch (ex) { err.textContent = ex.message; }
    });
    const add = async () => {
      try { const it = await api(`/store/tools/debts/${p.id}/items`, 'POST', { day: today() }); p.items.push(it); tbody.insertAdjacentHTML('beforeend', itemRow(it)); refresh(); tbody.lastElementChild.querySelector('[data-k=description]').focus(); }
      catch (ex) { err.textContent = ex.message; }
    };
    $('ftAddItem').onclick = add;
    $('ftDebtCopy').onclick = async () => feedback(await copy(debtText(p)) ? 'Lista copiada. É só colar no WhatsApp.' : 'Não consegui copiar.', false);
    $('ftDebtPrint').onclick = () => printDebt(p);
    $('ftDebtReceipt').onclick = () => { receiptDraft = { payer: p.name, ref: 'pagamento de compras', prep: 'a' }; d.close(); tab = 'receipts'; store.set('tab', tab); page?.querySelectorAll('[data-ft-tab]').forEach(x => x.setAttribute('aria-selected', x.dataset.ftTab === 'receipts')); drawTab(); };
    $('ftDebtClear').onclick = async () => {
      if (!confirm(`Apagar todos os itens da lista de ${p.name}? A pessoa continua cadastrada.`)) return;
      try { Object.assign(p, await api(`/store/tools/debts/${p.id}/clear`, 'POST')); tbody.innerHTML = ''; refresh(); } catch (ex) { err.textContent = ex.message; }
    };
    $('ftDebtDel').onclick = async () => {
      const t = totals(p);
      if (!confirm(`Apagar a lista de ${p.name}${t.balance > 0 ? ` (ainda deve ${brl(t.balance)})` : ''}? Isso não pode ser desfeito.`)) return;
      try { await api('/store/tools/debts/' + p.id, 'DELETE'); debts = debts.filter(x => x !== p); d.close(); feedback('Lista apagada.'); } catch (ex) { err.textContent = ex.message; }
    };
    d.querySelector('[data-ft-debtor-edit]').onclick = async () => {
      const name = prompt('Nome', p.name); if (name === null) return;
      const phone = prompt('WhatsApp (opcional)', p.phone || ''); if (phone === null) return;
      try { Object.assign(p, await api('/store/tools/debts/' + p.id, 'PATCH', { name: name.trim() || p.name, phone: phone.trim() })); openDebt(p.id); } catch (ex) { err.textContent = ex.message; }
    };
    if (!d.open) d.showModal();
    if (addFirst && !p.items.length) add();
  }
  function printDebt(p) {
    const t = totals(p);
    printHtml(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Lista · ${esc(p.name)}</title><style>
      @page{size:A4;margin:14mm}body{font:12px/1.4 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#111;margin:0}
      h1{font-size:18px;margin:0}h2{font-size:15px;margin:12px 0 2px}.muted{color:#555;font-size:11px}
      table{width:100%;border-collapse:collapse;margin-top:10px}th{text-align:left;border-bottom:2px solid #333;padding:5px 6px;font-size:10px;text-transform:uppercase}
      td{border-bottom:1px solid #ccc;padding:5px 6px}.n{text-align:right;white-space:nowrap}tfoot td{font-weight:700;border-bottom:0}.neg{color:#b42318}
    </style></head><body><h1>${esc(storeName())}</h1><h2>Lista: ${esc(p.name)}</h2><div class="muted">${p.phone ? esc(phoneBR(p.phone)) + ' · ' : ''}Emitida em ${new Date().toLocaleString('pt-BR')}</div>
      <table><thead><tr><th>Nome</th><th>Item</th><th>Data</th><th class="n">Valor</th><th class="n">Pago</th></tr></thead><tbody>
      ${p.items.map(r => `<tr><td>${esc(r.who)}</td><td>${esc(r.description)}</td><td>${dmy(r.day)}</td><td class="n">${r.amount_cents ? brl(r.amount_cents) : ''}</td><td class="n">${r.paid_cents ? brl(r.paid_cents) : ''}</td></tr>`).join('') || '<tr><td colspan="5">Nenhum item</td></tr>'}
      </tbody><tfoot><tr><td colspan="3">Total</td><td class="n">${brl(t.total)}</td><td class="n">${brl(t.paid)}</td></tr><tr><td colspan="3">Saldo devedor</td><td colspan="2" class="n ${t.balance > 0 ? 'neg' : ''}">${brl(t.balance)}</td></tr></tfoot></table></body></html>`);
  }

  // ---------------- Recibos ----------------
  const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const U = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
  const D = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const C = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
  function under1000(n) {
    if (n === 100) return 'cem';
    const c = Math.floor(n / 100), r = n % 100, p = [];
    if (c) p.push(C[c]);
    if (r) { if (r < 20) p.push(U[r]); else { const d = Math.floor(r / 10), u = r % 10; p.push(D[d] + (u ? ' e ' + U[u] : '')); } }
    return p.join(' e ');
  }
  function integer(n) {
    const groups = []; while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
    const names = [['', ''], ['mil', 'mil'], ['milhão', 'milhões'], ['bilhão', 'bilhões']], parts = [];
    for (let g = groups.length - 1; g >= 0; g--) {
      const v = groups[g]; if (!v) continue;
      parts.push({ t: g === 0 ? under1000(v) : g === 1 ? (v === 1 ? '' : under1000(v) + ' ') + 'mil' : under1000(v) + ' ' + (v === 1 ? names[g][0] : names[g][1]), v });
    }
    let out = parts[0].t;
    for (let k = 1; k < parts.length; k++) { const p = parts[k]; out += (k === parts.length - 1 && (p.v < 100 || p.v % 100 === 0) ? ' e ' : ' ') + p.t; }
    return out;
  }
  // 1234,56 → "mil duzentos e trinta e quatro reais e cinquenta e seis centavos"
  function extenso(cents) {
    const r = Math.floor(cents / 100), c = cents % 100, p = [];
    if (r > 0) p.push(integer(r) + (r === 1 ? ' real' : (r >= 1000000 && r % 1000000 === 0 ? ' de reais' : ' reais')));
    if (c > 0) p.push(integer(c) + (c === 1 ? ' centavo' : ' centavos'));
    return p.join(' e ');
  }
  const digits = s => String(s || '').replace(/\D/g, '');
  function maskDoc(s) {
    const d = digits(s).slice(0, 14);
    if (d.length <= 11) return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2');
    return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
  }
  function maskTel(s) {
    const d = digits(s).slice(0, 11);
    if (d.length > 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
    if (d.length > 6) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    if (d.length > 2) return '(' + d.slice(0, 2) + ') ' + d.slice(2);
    return d.length ? '(' + d : '';
  }
  const docLabel = doc => { const n = digits(doc).length; return n === 11 ? 'CPF' : n === 14 ? 'CNPJ' : 'CPF/CNPJ'; };
  const fmt2 = c => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateLong = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? parseInt(m[3], 10) + ' de ' + MESES[parseInt(m[2], 10) - 1] + ' de ' + m[1] : ''; };
  let receiptDraft = null, rcCents = 0, issuerTimer = null;
  const FORMS = ['Dinheiro', 'Pix', 'Cheque', 'Transferência/Depósito', 'Cartão de Crédito/Débito', 'Boleto'];
  function receiptBox(d, logo) {
    const blank = '<span class="rc-blank"></span>';
    const val = d.cents ? 'R$ ' + fmt2(d.cents) : 'R$ ______';
    const local = [d.city ? esc(d.city) : '', dateLong(d.date)].filter(Boolean).join(', ');
    return '<div class="rc-box"><div class="rc-head">' + (logo ? `<img class="rc-logo" src="${esc(logo)}" alt="">` : '<span></span>') + '<h3 class="rc-title">Recibo de Pagamento</h3><span class="rc-valor">' + val + '</span></div>' +
      '<p>Recebemos de <b>' + (d.payer ? esc(d.payer) : blank) + '</b>' + (d.payerDoc ? ' - ' + docLabel(d.payerDoc) + ' ' + esc(d.payerDoc) : '') +
      ', a importância de <b>' + (d.cents ? esc(extenso(d.cents)) : blank) + '</b>, referente ' + esc(d.prep) + ' <b>' + (d.ref ? esc(d.ref) : blank) + '</b>.</p>' +
      '<p>Para maior clareza, firmamos o presente recibo, que comprova o recebimento integral do valor mencionado, concedendo <b>quitação plena, geral e irrevogável</b> pela quantia recebida.</p>' +
      (d.form ? '<p class="rc-forma">Forma de pagamento: <b>' + esc(d.form) + '</b>.</p>' : '') +
      '<p class="rc-data">' + (local || blank) + '</p>' +
      '<div class="rc-sign"><div class="rc-line"></div><div class="rc-nome">' + (d.issuer ? esc(d.issuer) : '&nbsp;') + '</div>' +
      (d.issuerDoc ? '<div class="rc-small">' + docLabel(d.issuerDoc) + ': ' + esc(d.issuerDoc) + '</div>' : '') + (d.phone ? '<div class="rc-small">' + esc(d.phone) + '</div>' : '') + '</div></div>';
  }
  const RC_CSS = `.rc-box{box-sizing:border-box;border:1px solid #000;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;padding:1.2em 1.6em;display:flex;flex-direction:column;min-height:13em}
    .rc-head{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.8em;margin-bottom:1em}.rc-logo{max-height:3.8em;max-width:10em;object-fit:contain;justify-self:start}
    .rc-title{font-weight:600;font-size:1.25em;text-align:center;margin:0;color:#000}.rc-valor{justify-self:end;border:1px solid #000;border-radius:.5em;padding:.2em .7em;font-weight:700;font-size:1.1em;white-space:nowrap}
    .rc-box p{margin:0 0 .5em;color:#000}.rc-box b{font-weight:700}.rc-forma{font-size:.92em}.rc-data{text-align:right;margin:auto 0 0!important;padding-top:.6em}
    .rc-sign{text-align:center;margin-top:1.8em;line-height:1.35}.rc-sign .rc-line{width:62%;margin:0 auto .3em;border-top:1px solid #000}.rc-sign .rc-nome{font-weight:600}.rc-sign .rc-small{font-size:.85em}
    .rc-blank{display:inline-block;min-width:9em;border-bottom:1px solid #000;height:1em;vertical-align:baseline}`;
  function drawReceipts() {
    const iss = settings.receipt_issuer || {}, draft = receiptDraft || {}; receiptDraft = null;
    rcCents = draft.cents || 0;
    $('ftBody').innerHTML = `<form id="ftRc" class="ft-rc" autocomplete="off" onsubmit="return false">
      <label class="ft-f s2">Valor<input name="value" inputmode="numeric" placeholder="0,00" value="${rcCents ? fmt2(rcCents) : ''}"></label>
      <label class="ft-f s4">Pagador<input name="payer" maxlength="120" value="${esc(draft.payer || '')}"></label>
      <label class="ft-f s2"><span>CPF ou CNPJ <small>(opcional)</small></span><input name="payerDoc" inputmode="numeric"></label>
      <div class="ft-f s4"><span class="ft-lbl">Referente <span class="ft-radios">${['à', 'a', 'às', 'ao', 'aos'].map(p => `<label><input type="radio" name="prep" value="${p}" ${p === (draft.prep || 'à') ? 'checked' : ''}> ${p}</label>`).join('')}</span></span><input name="ref" maxlength="200" aria-label="Referente" placeholder="Ex.: troca de tela do iPhone 11" value="${esc(draft.ref || '')}"></div>
      <label class="ft-f s2">Data do pagamento<input name="date" type="date" value="${today()}"></label>
      <div class="ft-f s4"><span class="ft-lbl">Forma de pagamento</span><span class="ft-radios">${FORMS.map((f, i) => `<label><input type="radio" name="form" value="${f}" ${i ? '' : 'checked'}> ${f}</label>`).join('')}</span></div>
      <fieldset class="ft-f s6 ft-issuer"><legend>Quem emite <small>(fica salvo para a loja toda)</small></legend>
        <label class="ft-f">Nome do emissor<input name="issuer" maxlength="120" value="${esc(iss.name ?? storeName())}"></label>
        <label class="ft-f"><span>CPF ou CNPJ <small>(opcional)</small></span><input name="issuerDoc" inputmode="numeric" value="${esc(iss.doc || '')}"></label>
        <label class="ft-f"><span>Telefone <small>(opcional)</small></span><input name="phone" inputmode="tel" value="${esc(iss.phone || '')}"></label>
        <label class="ft-f">Cidade<input name="city" maxlength="80" value="${esc(iss.city || '')}"></label>
        <div class="ft-f ft-logo"><span class="ft-lbl">Logo <small>(opcional)</small></span><span class="ft-logo-row"><img id="ftLogoPrev" alt="Logo" hidden><button type="button" class="nv-button secondary fs-small" id="ftLogoBtn">Escolher logo…</button><button type="button" class="nv-button secondary fs-small ft-danger" id="ftLogoDel" hidden>Remover</button><input type="file" id="ftLogoFile" accept="image/*" hidden></span></div>
        <small class="ft-saved" id="ftIssuerSaved" role="status"></small></fieldset>
      <div class="ft-f s6 ft-print-opts"><label class="ft-check"><input type="checkbox" name="two"> Duas vias</label><label class="ft-check">Posição na folha <select name="pos"><option value="0">1ª (em cima)</option><option value="1">2ª (no meio)</option><option value="2">3ª (embaixo)</option></select></label><small class="nv-help">Cada recibo ocupa 1/3 da folha A4. Use a posição para aproveitar uma folha já usada.</small></div>
      <div class="ft-actions s6"><button type="button" class="nv-button" id="ftRcPrint">${ic('printer')} Imprimir recibo</button><button type="button" class="nv-button secondary" id="ftRcClear">Limpar</button></div>
      </form><p class="ft-prev-title">Pré-visualização</p><div class="ft-prev"><div id="ftRcPrev"></div></div>`;
    const f = $('ftRc'), logoState = { v: iss.logo || '' };
    const data = () => ({ cents: rcCents, payer: f.elements.payer.value.trim(), payerDoc: f.elements.payerDoc.value.trim(), prep: f.elements.prep.value || 'à', ref: f.elements.ref.value.trim(),
      issuer: f.elements.issuer.value.trim(), issuerDoc: f.elements.issuerDoc.value.trim(), phone: f.elements.phone.value.trim(), city: f.elements.city.value.trim(), date: f.elements.date.value, form: f.elements.form.value });
    const preview = () => { $('ftRcPrev').innerHTML = receiptBox(data(), logoState.v); };
    const showLogo = () => { const img = $('ftLogoPrev'); img.hidden = !logoState.v; if (logoState.v) img.src = logoState.v; else img.removeAttribute('src'); $('ftLogoDel').hidden = !logoState.v; $('ftLogoBtn').textContent = logoState.v ? 'Trocar logo…' : 'Escolher logo…'; };
    const saveIssuer = (extra = {}) => {
      clearTimeout(issuerTimer);
      issuerTimer = setTimeout(async () => {
        const body = { name: f.elements.issuer.value.trim(), doc: f.elements.issuerDoc.value.trim(), phone: f.elements.phone.value.trim(), city: f.elements.city.value.trim(), ...extra };
        try { settings.receipt_issuer = await api('/store/tools/receipt-issuer', 'PUT', body); $('ftIssuerSaved') && ($('ftIssuerSaved').textContent = 'Salvo.'); }
        catch (e) { $('ftIssuerSaved') && ($('ftIssuerSaved').textContent = e.message); }
      }, Object.keys(extra).length ? 0 : 700);
    };
    f.elements.value.oninput = e => { const d = digits(e.target.value).slice(0, 12).replace(/^0+/, ''); rcCents = parseInt(d || '0', 10); e.target.value = d ? fmt2(rcCents) : ''; };
    f.elements.payerDoc.oninput = e => { e.target.value = maskDoc(e.target.value); };
    f.elements.issuerDoc.oninput = e => { e.target.value = maskDoc(e.target.value); saveIssuer(); };
    f.elements.phone.oninput = e => { e.target.value = maskTel(e.target.value); saveIssuer(); };
    f.elements.issuer.oninput = f.elements.city.oninput = () => saveIssuer();
    f.addEventListener('input', preview); f.addEventListener('change', preview);
    $('ftLogoBtn').onclick = () => $('ftLogoFile').click();
    $('ftLogoDel').onclick = () => { logoState.v = ''; showLogo(); preview(); saveIssuer({ logo: '' }); };
    $('ftLogoFile').onchange = e => {
      const file = e.target.files[0]; e.target.value = ''; if (!file) return;
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        // Reduz para caber (até ~260 KB): 500 px em PNG; se passar, JPEG.
        let max = 500, out = '';
        for (let tries = 0; tries < 4; tries++) {
          const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
          const g = c.getContext('2d'); if (tries) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); } g.drawImage(img, 0, 0, c.width, c.height);
          out = tries ? c.toDataURL('image/jpeg', 0.85) : c.toDataURL('image/png');
          if (out.length < 350000) break; max = Math.round(max * 0.75);
        }
        logoState.v = out; showLogo(); preview(); saveIssuer({ logo: out });
      };
      img.onerror = () => { URL.revokeObjectURL(url); feedback('Não consegui abrir essa imagem.', true); };
      img.src = url;
    };
    $('ftRcClear').onclick = () => {
      rcCents = 0; ['value', 'payer', 'payerDoc', 'ref'].forEach(n => { f.elements[n].value = ''; });
      f.querySelector('[name=prep][value="à"]').checked = true; f.querySelector('[name=form][value="Dinheiro"]').checked = true;
      f.elements.two.checked = false; f.elements.pos.value = '0'; f.elements.date.value = today(); preview(); f.elements.value.focus();
    };
    $('ftRcPrint').onclick = () => {
      const d = data();
      if (!d.cents) { feedback('Informe o valor do recibo.', true); f.elements.value.focus(); return; }
      const list = []; for (let i = 0; i < (+f.elements.pos.value || 0); i++) list.push(null);
      list.push(d); if (f.elements.two.checked) list.push(d);
      while (list.length % 3) list.push(null);
      let pages = '';
      for (let i = 0; i < list.length; i += 3) pages += '<div class="rc-page">' + list.slice(i, i + 3).map(x => '<div class="rc-slot">' + (x ? receiptBox(x, logoState.v) : '') + '</div>').join('') + '</div>';
      printHtml(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Recibo</title><style>@page{size:A4 portrait;margin:6mm}body{margin:0}${RC_CSS}
        .rc-page{width:198mm;break-after:page;page-break-after:always;overflow:hidden}.rc-page:last-child{break-after:auto;page-break-after:auto}
        .rc-slot{height:92mm;margin-bottom:3mm;break-inside:avoid}.rc-slot:last-child{margin-bottom:0}.rc-slot .rc-box{height:92mm;min-height:0;font-size:9.6pt;border:.35mm solid #000;padding:4.5mm 7mm}
        .rc-slot .rc-valor{border-width:.3mm}.rc-slot .rc-logo{max-height:14mm;max-width:38mm}</style></head><body>${pages}</body></html>`);
    };
    showLogo(); preview();
    if (matchMedia('(min-width:701px)').matches) f.elements.value.focus();
  }

  // ---------------- Cliques ----------------
  document.addEventListener('click', e => {
    const open = e.target.closest('[data-ft-open-link]');
    if (open) { const id = open.dataset.ftOpenLink; api(`/store/tools/links/${id}/open`, 'POST').then(r => { const l = links?.find(x => x.id === id); if (l) Object.assign(l, r); }).catch(() => {}); return; }
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-ft-quick-edit')) return void editShortcuts();
    if (b.hasAttribute('data-ft-link-new')) return void linkForm(null);
    if (b.dataset.ftLinkEdit) return void linkForm(links.find(l => l.id === b.dataset.ftLinkEdit));
    if (b.dataset.ftPin) {
      const l = links.find(x => x.id === b.dataset.ftPin);
      api('/store/tools/links/' + l.id, 'PATCH', { pinned: !l.pinned }).then(r => { Object.assign(l, r); drawLinkList(); }).catch(err => feedback(err.message, true));
      return;
    }
    if (b.hasAttribute('data-ft-debt-new')) return void newDebtor();
    if (b.dataset.ftDebtOpen) return void openDebt(b.dataset.ftDebtOpen);
  });

  const css = `
  .nv-top.ft-has-quick{flex-wrap:wrap}.ft-quick{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;margin-left:auto}
  .ft-qbtn{display:inline-flex;align-items:center;gap:7px;min-height:40px;padding:8px 13px;border:1px solid var(--nv-border,#e5e7eb);border-radius:11px;background:#fff;color:var(--nv-text,#374151);font:inherit;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer;white-space:nowrap;max-width:190px}
  .ft-qbtn span{overflow:hidden;text-overflow:ellipsis}.ft-qbtn:hover{border-color:var(--nv-blue,#f25c1f);color:var(--nv-ink,#111)}.ft-qbtn.active{background:var(--nv-blue-soft,#fff1ea);border-color:transparent;color:#C2410C}
  .ft-qbtn .fp-ic{width:17px;height:17px;flex:0 0 auto}.ft-qbtn .ft-fav{width:17px;height:17px}.ft-qadd{border-style:dashed;color:var(--nv-muted,#6b7280);font-weight:500}
  @media(max-width:700px){.ft-quick{order:3;width:100%;flex-wrap:nowrap;overflow-x:auto;justify-content:flex-start;margin:4px 0 0;padding-bottom:2px;scrollbar-width:none}.ft-quick::-webkit-scrollbar{display:none}.ft-qbtn{flex:0 0 auto;min-height:38px;padding:7px 11px}}
  .ft-tabs{display:flex;gap:4px;border-bottom:1px solid var(--nv-border);margin:-4px 0 16px;overflow-x:auto}.ft-tabs button{display:inline-flex;align-items:center;gap:7px;border:0;background:none;padding:10px 14px;cursor:pointer;border-bottom:2px solid transparent;color:var(--nv-muted);white-space:nowrap;font:inherit;font-size:15px}
  .ft-tabs button[aria-selected=true]{border-bottom-color:var(--nv-blue);color:var(--nv-ink);font-weight:700}.ft-tabs .fp-ic{width:17px;height:17px}
  .ft-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}.ft-search{flex:1 1 260px;display:flex;align-items:center;gap:8px;border:1px solid var(--nv-border);border-radius:11px;padding:0 12px;background:#fff}.ft-search .fp-ic{width:17px;color:var(--nv-muted)}
  .ft-search input{border:0;outline:0;padding:11px 0;width:100%;font:inherit;font-size:15px;background:transparent}.ft-search:focus-within{border-color:var(--nv-blue)}
  .ft-bar select,.ft-print-opts select{padding:10px 12px;border:1px solid var(--nv-border);border-radius:11px;background:#fff;font:inherit;font-size:14px}
  .ft-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.ft-chip{border:1px solid var(--nv-border);background:#fff;border-radius:999px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}.ft-chip small{color:var(--nv-muted)}.ft-chip[aria-pressed=true]{background:var(--nv-blue);border-color:var(--nv-blue);color:#fff}.ft-chip[aria-pressed=true] small{color:#fff}.ft-chips-sm{margin:-6px 0 10px}
  .ft-links{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
  .ft-link{display:flex;align-items:center;gap:4px;border:1px solid var(--nv-border);border-radius:13px;background:#fff;padding:4px 6px 4px 4px;min-width:0}.ft-link:hover{border-color:var(--nv-blue)}.ft-link.pinned{background:#fffaf5}.ft-link.dragging{opacity:.4}
  .ft-grip{color:#c0c4cc;cursor:grab;display:flex}.ft-grip .fp-ic{width:16px}
  .ft-link-main{flex:1;display:flex;align-items:center;gap:10px;min-width:0;padding:8px 6px;color:inherit;text-decoration:none}.ft-link-txt{display:flex;flex-direction:column;min-width:0}.ft-link-txt b{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ft-link-txt small{color:var(--nv-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ft-fav{width:28px;height:28px;border-radius:7px;flex:0 0 auto;object-fit:contain}.ft-fav-letter{display:inline-grid;place-items:center;background:var(--nv-blue-soft,#fff1ea);color:#C2410C;font-weight:800;font-size:13px}.ft-qbtn .ft-fav-letter{font-size:10px;border-radius:5px}
  .ft-link-tools{display:flex;gap:2px}.ft-icon-btn{display:inline-grid;place-items:center;width:34px;height:34px;border:0;border-radius:9px;background:none;color:var(--nv-muted);cursor:pointer;text-decoration:none}.ft-icon-btn:hover{background:var(--nv-bg,#f2f3f5);color:var(--nv-ink)}.ft-icon-btn:disabled{opacity:.3}.ft-icon-btn .fp-ic{width:17px;height:17px}.ft-icon-btn.on{color:#e69500}.ft-icon-btn.on svg{fill:currentColor}
  .ft-danger{color:#b42318!important}.ft-err{color:#b42318;font-size:13px;min-height:1em}.ft-neg{color:#b42318}.ft-pos{color:#027a48}.ft-r{text-align:right}
  .ft-import{margin-top:18px;border-top:1px solid var(--nv-border);padding-top:12px}.ft-import summary{cursor:pointer;color:var(--nv-muted);font-size:14px}.ft-import-body{padding-top:8px}
  .ft-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:14px}.ft-kpis div{border:1px solid var(--nv-border);border-radius:13px;padding:12px 14px;display:flex;flex-direction:column}.ft-kpis small{color:var(--nv-muted);font-size:12px}.ft-kpis b{font-size:22px;margin-top:4px}
  .ft-debts{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:10px}.ft-debt{display:flex;align-items:center;border:1px solid var(--nv-border);border-radius:13px;background:#fff;padding-right:6px}.ft-debt:hover{border-color:var(--nv-blue)}.ft-debt.dragging{opacity:.4}
  .ft-debt-main{flex:1;display:flex;align-items:center;gap:11px;border:0;background:none;padding:12px;text-align:left;font:inherit;cursor:pointer;min-width:0}.ft-avatar{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:var(--nv-lavender,#f3e8ff);color:#C2410C;font-weight:800;font-size:13px;flex:0 0 auto}
  .ft-debt-txt{flex:1;display:flex;flex-direction:column;min-width:0}.ft-debt-txt b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ft-debt-txt small{color:var(--nv-muted);font-size:12px}.ft-debt-val{font-weight:800;white-space:nowrap}.ft-wa{color:#128c7e}
  .ft-dialog.ft-wide{width:min(980px,calc(100% - 16px))}.ft-form .nv-field input{font-size:15px}.ft-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.ft-actions .nv-button{text-decoration:none}.ft-check{display:flex;align-items:center;gap:8px;font-size:14px}.ft-check input{width:18px;height:18px}
  .ft-qlist{margin:6px 0 12px;padding-left:22px}.ft-qlist li{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--nv-border)}.ft-qtools{display:flex}.ft-qadd-box{border:1px solid var(--nv-border);border-radius:12px;padding:10px 12px;display:grid;gap:8px}.ft-qadd-box legend{font-size:13px;color:var(--nv-muted);padding:0 4px}.ft-qadd-box select{padding:10px;border:1px solid var(--nv-border);border-radius:10px;font:inherit}
  .ft-table-wrap{overflow-x:auto;margin:6px 0}.ft-debt-table{width:100%;border-collapse:collapse;font-size:14px;min-width:720px}.ft-debt-table th{text-align:left;font-size:12px;color:var(--nv-muted);font-weight:600;padding:6px 4px;border-bottom:1px solid var(--nv-border)}
  .ft-debt-table td{padding:3px 3px;border-bottom:1px solid var(--nv-border)}.ft-debt-table input:not([type=checkbox]){width:100%;border:1px solid transparent;border-radius:8px;padding:7px 6px;font:inherit;font-size:14px;background:transparent}.ft-debt-table input:not([type=checkbox]):hover{border-color:var(--nv-border)}.ft-debt-table input:focus{border-color:var(--nv-blue)!important;outline:0;background:#fff}
  .ft-debt-table .ft-money{width:96px;text-align:right}.ft-debt-table input[type=date]{width:140px}.ft-c-chk{width:34px;text-align:center}.ft-c-chk input{width:18px;height:18px}.ft-c-del{width:40px}.ft-debt-table tr.done td input:not([type=checkbox]){color:var(--nv-muted);text-decoration:line-through}.ft-debt-table tfoot td{border:0;padding:6px 6px;text-align:right}.ft-debt-table tfoot td:nth-child(2),.ft-debt-table tfoot td:nth-child(3){text-align:right}
  .ft-additem{margin-top:4px}.ft-link-btn{padding:0}
  .ft-rc{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px 14px;align-items:end}.ft-f{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:13px;font-weight:600;color:var(--nv-text)}.ft-f small{font-weight:400;color:var(--nv-muted)}.ft-f.s2{grid-column:span 2}.ft-f.s4{grid-column:span 4}.ft-f.s6,.ft-actions.s6{grid-column:span 6}
  .ft-rc input:not([type=radio]):not([type=checkbox]){border:1px solid var(--nv-border);border-radius:10px;padding:11px 12px;font:inherit;font-size:15px;font-weight:400;background:#fff;width:100%}.ft-rc input:focus{outline:0;border-color:var(--nv-blue)}
  .ft-lbl{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px}.ft-radios{display:flex;flex-wrap:wrap;gap:6px 16px;font-weight:400}.ft-radios label{display:inline-flex;align-items:center;gap:6px;font-size:14px;cursor:pointer}.ft-radios input{width:16px;height:16px;margin:0;accent-color:var(--nv-blue)}
  .ft-issuer{border:1px solid var(--nv-border);border-radius:12px;padding:10px 12px 12px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 12px}.ft-issuer legend{padding:0 4px;font-weight:600}.ft-issuer .ft-logo{grid-column:span 3}.ft-logo-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}#ftLogoPrev{height:40px;max-width:120px;object-fit:contain;border:1px solid var(--nv-border);border-radius:6px;padding:2px;background:#fff}.ft-saved{align-self:end;color:var(--nv-muted);font-weight:400}
  .ft-print-opts{flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px 18px;font-weight:400}
  .ft-prev-title{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--nv-muted);margin:18px 0 6px;font-weight:700}.ft-prev{background:#fff;border:1px dashed var(--nv-border);border-radius:10px;padding:12px;overflow-x:auto}.ft-prev .rc-box{max-width:760px}
  ${RC_CSS}
  @media(max-width:700px){.ft-rc{grid-template-columns:minmax(0,1fr)}.ft-f.s2,.ft-f.s4,.ft-f.s6,.ft-actions.s6{grid-column:auto}.ft-issuer{grid-template-columns:minmax(0,1fr)}.ft-issuer .ft-logo{grid-column:auto}.ft-kpis{grid-template-columns:1fr 1fr}.ft-kpis div:last-child{display:none}.ft-prev .rc-box{font-size:11px;padding:1em}.ft-bar .nv-button{flex:1}}`;

  window.FPTools = {
    has: v => v === 'links',
    titles: { links: 'Links úteis' },
    moreItems: () => enabled ? [['links', 'Links úteis']] : [],
    load
  };
  if (!token) return;
  api('/store/sales/config').then(async c => {
    if (!c.enabled) return;
    enabled = true;
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    const home = document.querySelector('.nv-menu [data-view="home"]');
    if (home && !document.querySelector('.nv-menu [data-view="links"]')) home.insertAdjacentHTML('afterend', `<button data-view="links">${ic('link')}Links úteis</button>`);
    try { settings = await api('/store/tools/settings'); } catch { settings = { shortcuts: [{ type: 'view', view: 'cash' }, { type: 'view', view: 'links' }, { type: 'view', view: 'messages' }], receipt_issuer: {} }; }
    if (settings.shortcuts.some(s => s.type === 'link')) { try { links = await api('/store/tools/links'); } catch { links = []; } }
    renderQuick();
  }).catch(() => {});
})();
