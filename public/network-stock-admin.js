// Painel da rede → Estoque: abas de gestão (dono e supervisor).
// Estoque por unidade · Produtos · Entrada rápida · Etiquetas · Gerar códigos · Reposição · Histórico · Preços · Valor do estoque (só o dono).
// Cadastro e preço valem para a rede toda (a mesma peça em todas as unidades, casada pelo código).
(() => {
  const N = window.fpNet; if (!N) return;
  const { api, safe, brl } = N, $ = id => document.getElementById(id);
  const root = $('nsTabs'), panel = $('nsPanel'); if (!root || !panel) return;
  let meta = null, tab = 'mx';
  const toCents = v => { const t = String(v ?? '').trim(); if (!t) return null; const n = Number(t.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN; };
  const money = c => c == null ? '' : (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = iso => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const msg = (el, text, err) => { if (!el) return; el.textContent = text || ''; el.style.color = err ? 'var(--red)' : 'var(--green)'; };
  const card = (title, hint, body) => '<section class="card block nsCard"><header class="bh nsh"><h2>' + title + '</h2><span class="hint">' + (hint || '') + '</span></header><div class="bb">' + body + '</div></section>';
  const KIND = { entry: 'Entrada', sale: 'Venda', cancel: 'Venda cancelada', adjust: 'Ajuste', edit: 'Correção no cadastro', restore: 'Reativada', delete: 'Excluída', transfer_out: 'Transferência enviada', transfer_in: 'Transferência recebida', count: 'Contagem' };
  const LAB_KEY = 'fp_net_label_choice';
  const labChoice = () => { try { return localStorage.getItem(LAB_KEY) || 'none'; } catch { return 'none'; } };
  const labHtml = name => '<label>Etiquetas<select id="' + name + '">' + [['none', 'Não imprimir'], ['one', '1 etiqueta só'], ['each', '1 por unidade']].map(([v, t]) => '<option value="' + v + '"' + (labChoice() === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></label>';
  const saveLab = v => { try { localStorage.setItem(LAB_KEY, v); } catch { } };

  async function loadMeta() { if (!meta) meta = await api('/network/catalog?limit=1'); return meta; }
  // Unidade padrão: a escolhida no menu, se a pessoa tiver acesso a ela; senão a primeira.
  const unitSelect = (id, { all = false, depotFirst = true } = {}) => {
    const cur = N.unit(), list = meta.my_units || [];
    const def = all ? '' : (list.find(u => u.id === cur)?.id || (depotFirst ? list[0]?.id : list.find(u => !u.depot)?.id) || '');
    return '<label>Unidade<select id="' + id + '">' + (all ? '<option value="">Todas as minhas</option>' : '') + list.map(u => '<option value="' + safe(u.id) + '"' + (u.id === def || (all && u.id === cur) ? ' selected' : '') + '>' + safe(u.label) + (u.depot && !/dep[oó]sito/i.test(u.label) ? ' (depósito)' : '') + '</option>').join('') + '</select></label>';
  };
  const famList = () => '<datalist id="nsFams">' + (meta.families || []).map(f => '<option value="' + safe(f) + '">').join('') + '</datalist>';
  // Busca de peça (bipar ou digitar): código exato entra direto; senão mostra opções.
  async function findPiece(term) {
    const d = await api('/network/catalog?' + new URLSearchParams({ q: term, limit: 12 }));
    const exact = d.items.filter(i => i.key === term || i.code === term || i.barcode === term);
    return { exact: exact.length === 1 ? exact[0] : null, items: d.items };
  }
  function scanBox(inputId, sugId, onPick, statusEl) {
    const inp = $(inputId), sug = $(sugId); let t;
    const show = items => { sug.innerHTML = items.map((p, i) => '<button type="button" class="nsSug" data-i="' + i + '"><b>' + safe(p.name) + '</b> <span class="soft">' + safe(p.code || p.key) + ' · ' + brl(p.price_cents) + '</span></button>').join(''); sug.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { onPick(items[b.dataset.i]); inp.value = ''; sug.innerHTML = ''; inp.focus(); }); };
    inp.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return; e.preventDefault(); const term = inp.value.trim(); if (!term) return;
      try { const r = await findPiece(term); if (r.exact) { onPick(r.exact); inp.value = ''; sug.innerHTML = ''; } else if (r.items.length) show(r.items); else msg(statusEl, 'Peça ' + term + ' não cadastrada na rede. Cadastre em "Produtos".', true); } catch (err) { msg(statusEl, err.message, true); }
    });
    inp.addEventListener('input', () => { clearTimeout(t); const term = inp.value.trim(); if (term.length < 3 || /^\d+$/.test(term)) { sug.innerHTML = ''; return; } t = setTimeout(async () => { try { show((await findPiece(term)).items); } catch { } }, 300); });
  }

  // ---------- Produtos ----------
  let prOff = 0;
  async function tabProducts() {
    panel.innerHTML = card('Cadastrar peça nova', 'Entra em todas as unidades com o mesmo código e preço',
      '<div class="form4"><label>Código da peça<input id="npCode" placeholder="Ex.: 003622" autocomplete="off"></label><label class="ck" style="padding-top:22px"><input type="checkbox" id="npGen"> Gerar código (peça sem código)</label>'
      + '<label>Nome<input id="npName" maxlength="120"></label><label>Família<input id="npFam" list="nsFams" maxlength="80"></label>'
      + '<label>Preço de venda<input id="npPrice" inputmode="decimal" placeholder="0,00"></label><label>Custo (opcional)<input id="npCost" inputmode="decimal" placeholder="0,00"></label>'
      + unitSelect('npUnit') + '<label>Quantidade que chegou<input id="npQty" type="number" min="0" max="9999" value="0"></label>' + labHtml('npLab') + '</div>' + famList()
      + '<div class="actions"><button type="button" class="btn" id="npSave">Cadastrar</button><span class="soft" id="npMsg"></span></div>')
      + card('Peças da rede', '<span id="prInfo"></span>', '<div class="row"><label class="grow" style="flex:1">Buscar<input id="prQ" placeholder="Código ou nome" autocomplete="off"></label><label>Família<select id="prFam"><option value="">Todas</option>' + (meta.families || []).map(f => '<option>' + safe(f) + '</option>').join('') + '</select></label></div>'
        + '<div class="wrap"><table><thead><tr><th>Peça</th><th>Família</th><th class="n">Preço</th>' + (meta.owner ? '<th class="n">Custo</th>' : '') + '<th class="n">Estoque na rede</th><th></th></tr></thead><tbody id="prRows"></tbody></table></div>'
        + '<div class="actions" style="justify-content:center"><button type="button" class="linkb" id="prMore" hidden>Mostrar mais</button></div><p class="soft" id="prMsg"></p>');
    $('npGen').onchange = () => { $('npCode').disabled = $('npGen').checked; if ($('npGen').checked) $('npCode').value = ''; };
    $('npSave').onclick = async () => {
      const price = toCents($('npPrice').value), cost = toCents($('npCost').value), qty = Number($('npQty').value) || 0;
      if (!price) return msg($('npMsg'), 'Informe o preço de venda (ex.: 89,90).', true);
      if (Number.isNaN(cost)) return msg($('npMsg'), 'Confira o custo.', true);
      const body = { name: $('npName').value.trim(), price_cents: price, family: $('npFam').value.trim(), labels: $('npLab').value };
      if ($('npGen').checked) body.generate = true; else body.code = $('npCode').value.trim();
      if (cost != null) body.cost_cents = cost;
      if (qty > 0) { body.unit_id = $('npUnit').value; body.quantity = qty; }
      saveLab(body.labels);
      try {
        const r = await api('/network/catalog', 'POST', body);
        msg($('npMsg'), r.name + ' cadastrada nas ' + r.units + ' unidades com o código ' + r.code + '.' + (body.labels !== 'none' && qty ? ' Etiquetas na fila da unidade (aba Etiquetas).' : ''));
        ['npCode', 'npName', 'npPrice', 'npCost'].forEach(id => { $(id).value = ''; }); $('npQty').value = 0; meta = null; await loadMeta(); loadList();
      } catch (e) { msg($('npMsg'), e.message, true); }
    };
    let t; $('prQ').oninput = () => { clearTimeout(t); t = setTimeout(() => loadList(), 300); }; $('prFam').onchange = () => loadList(); $('prMore').onclick = () => loadList(true);
    loadList();
  }
  async function loadList(more) {
    if (!more) prOff = 0;
    let d; try { d = await api('/network/catalog?' + new URLSearchParams({ q: $('prQ').value.trim(), family: $('prFam').value, offset: prOff, limit: 200 })); } catch (e) { return msg($('prMsg'), e.message, true); }
    const rows = d.items.map(p => '<tr data-k="' + safe(p.key) + '"><td><strong>' + safe(p.name) + '</strong><br><span class="soft">' + safe(p.code || 'sem código') + '</span></td><td>' + safe(p.family || '') + '</td>'
      + '<td class="n">' + brl(p.price_cents) + (p.prices_differ ? '<br><small style="color:var(--red)">preço diferente entre unidades</small>' : '') + '</td>' + (d.owner ? '<td class="n soft">' + (p.cost_cents == null ? '—' : brl(p.cost_cents)) + '</td>' : '')
      + '<td class="n">' + p.total + '</td><td class="n"><button type="button" class="linkb" data-ed>Editar</button></td></tr>').join('');
    $('prRows').innerHTML = more ? $('prRows').innerHTML + rows : (rows || '<tr><td colspan="6" class="soft">Nenhuma peça.</td></tr>');
    prOff = d.offset + d.items.length; $('prInfo').textContent = d.total + (d.total === 1 ? ' peça' : ' peças'); $('prMore').hidden = prOff >= d.total;
    const byKey = new Map(d.items.map(p => [p.key, p]));
    $('prRows').querySelectorAll('[data-ed]').forEach(b => b.onclick = () => {
      const tr = b.closest('tr'), p = byKey.get(tr.dataset.k); if (!p || tr.nextElementSibling?.classList.contains('nsEdit')) return;
      tr.insertAdjacentHTML('afterend', '<tr class="nsEdit"><td colspan="6"><div class="form4"><label>Nome<input class="eName" value="' + safe(p.name) + '"></label><label>Família<input class="eFam" list="nsFams" value="' + safe(p.family || '') + '"></label>'
        + '<label>Preço (todas as unidades)<input class="ePrice" inputmode="decimal" value="' + money(p.price_cents) + '"></label>' + (d.owner ? '<label>Custo<input class="eCost" inputmode="decimal" value="' + money(p.cost_cents) + '"></label>' : '') + '</div>' + famList()
        + '<div class="actions"><button type="button" class="btn eSave">Salvar na rede</button><button type="button" class="btn ghost eLab">Pôr etiqueta na fila</button><button type="button" class="linkb eX">Fechar</button><span class="soft eMsg"></span></div></td></tr>');
      const ed = tr.nextElementSibling, em = ed.querySelector('.eMsg');
      ed.querySelector('.eX').onclick = () => ed.remove();
      ed.querySelector('.eSave').onclick = async () => {
        const body = { key: p.key, name: ed.querySelector('.eName').value.trim(), family: ed.querySelector('.eFam').value.trim(), price_cents: toCents(ed.querySelector('.ePrice').value) };
        if (!body.price_cents) return msg(em, 'Confira o preço.', true);
        if (d.owner) { const c = toCents(ed.querySelector('.eCost').value); if (Number.isNaN(c)) return msg(em, 'Confira o custo.', true); body.cost_cents = c; }
        try { const r = await api('/network/catalog/update', 'POST', body); msg(em, 'Salvo em ' + r.updated + ' unidade(s).'); setTimeout(() => loadList(), 700); } catch (e) { msg(em, e.message, true); }
      };
      ed.querySelector('.eLab').onclick = async () => {
        const unit = N.unit() || (meta.my_units[0] || {}).id; if (!p.barcode) return msg(em, 'Peça sem código de barras: gere em "Gerar códigos".', true);
        try { await api('/network/labels', 'POST', { unit_id: unit, key: p.key, add: 1 }); msg(em, 'Etiqueta na fila de ' + (meta.my_units.find(u => u.id === unit)?.label || 'unidade') + '.'); } catch (e) { msg(em, e.message, true); }
      };
    });
  }

  // ---------- Entrada rápida ----------
  let entry = [];
  function tabEntry() {
    entry = [];
    panel.innerHTML = card('Entrada rápida', 'Bipe as peças que chegaram; o estoque soma na unidade escolhida',
      '<div class="form4">' + unitSelect('enUnit') + labHtml('enLab') + '<label>Observação (opcional)<input id="enNote" maxlength="120" placeholder="Ex.: Nota 1234 do fornecedor"></label></div>'
      + '<div class="row" style="margin-top:14px"><label style="flex:1">Peça<input id="enScan" placeholder="Bipe o código ou digite o nome e Enter" autocomplete="off"></label></div><div id="enSug" class="nsSugs"></div>'
      + '<div class="wrap"><table><thead><tr><th>Peça</th><th class="n">Quantidade</th><th class="n">Custo unitário (opcional)</th><th></th></tr></thead><tbody id="enRows"></tbody></table></div>'
      + '<div class="actions"><button type="button" class="btn" id="enGo" disabled>Dar entrada</button><span class="soft" id="enMsg"></span></div>');
    const draw = () => {
      $('enRows').innerHTML = entry.map((x, i) => '<tr><td><strong>' + safe(x.name) + '</strong><br><span class="soft">' + safe(x.code || x.key) + '</span></td><td class="n"><input class="enQ" data-i="' + i + '" type="number" min="1" max="9999" value="' + x.quantity + '" style="width:90px"></td>'
        + '<td class="n"><input class="enC" data-i="' + i + '" inputmode="decimal" placeholder="0,00" value="' + safe(x.cost || '') + '" style="width:110px"></td><td class="n"><button type="button" class="linkb" data-del="' + i + '">Tirar</button></td></tr>').join('') || '<tr><td colspan="4" class="soft">Nenhuma peça bipada.</td></tr>';
      const n = entry.reduce((a, x) => a + x.quantity, 0); $('enGo').disabled = !n; $('enGo').textContent = n ? 'Dar entrada de ' + n + (n === 1 ? ' peça' : ' peças') : 'Dar entrada';
      $('enRows').querySelectorAll('.enQ').forEach(el => el.onchange = () => { entry[el.dataset.i].quantity = Math.max(1, Math.min(9999, Number(el.value) || 1)); draw(); });
      $('enRows').querySelectorAll('.enC').forEach(el => el.onchange = () => { entry[el.dataset.i].cost = el.value; });
      $('enRows').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { entry.splice(Number(b.dataset.del), 1); draw(); });
    };
    scanBox('enScan', 'enSug', p => { const x = entry.find(e => e.key === p.key); if (x) x.quantity++; else entry.push({ key: p.key, code: p.code, name: p.name, quantity: 1, cost: '' }); msg($('enMsg'), ''); draw(); }, $('enMsg'));
    $('enGo').onclick = async () => {
      const items = []; for (const x of entry) { const c = toCents(x.cost); if (Number.isNaN(c)) return msg($('enMsg'), 'Confira o custo de ' + x.name + '.', true); items.push(c == null ? { key: x.key, quantity: x.quantity } : { key: x.key, quantity: x.quantity, unit_cost_cents: c }); }
      const body = { unit_id: $('enUnit').value, items, labels: $('enLab').value }; if ($('enNote').value.trim()) body.note = $('enNote').value.trim(); saveLab(body.labels);
      $('enGo').disabled = true;
      try { const r = await api('/network/stock/entry', 'POST', body); const u = $('enUnit').selectedOptions[0]?.textContent; entry = []; draw(); msg($('enMsg'), 'Entrada feita: ' + r.units + ' peça(s) em ' + u + '.' + (body.labels !== 'none' ? ' Etiquetas na fila (aba Etiquetas).' : '')); $('enScan').focus(); }
      catch (e) { msg($('enMsg'), e.message, true); draw(); }
    };
    draw(); $('enScan').focus();
  }

  // ---------- Etiquetas ----------
  function tabLabels() {
    panel.innerHTML = card('Etiquetas', 'Fila de cada unidade; imprime várias peças na mesma folha',
      '<div class="form4">' + unitSelect('lbUnit') + '<label style="grid-column:span 2">Adicionar peça<input id="lbScan" placeholder="Bipe o código ou digite o nome e Enter" autocomplete="off"></label></div><div id="lbSug" class="nsSugs"></div>'
      + '<div class="wrap"><table><thead><tr><th><input type="checkbox" id="lbAll" checked aria-label="Todas"></th><th>Peça</th><th class="n">Preço</th><th class="n">Etiquetas</th><th></th></tr></thead><tbody id="lbRows"></tbody></table></div>'
      + '<div class="actions"><button type="button" class="btn" id="lbPrint">Imprimir selecionadas</button><span class="soft" id="lbMsg"></span></div><div id="lbDone"></div>');
    let rows = [], off = new Set();
    const unit = () => $('lbUnit').value;
    const load = async () => { try { rows = await api('/network/labels?unit_id=' + unit()); draw(); } catch (e) { msg($('lbMsg'), e.message, true); } };
    const setQty = async (key, qty) => { try { rows = await api('/network/labels', 'POST', { unit_id: unit(), key, qty }); draw(); } catch (e) { msg($('lbMsg'), e.message, true); } };
    const draw = () => {
      $('lbRows').innerHTML = rows.map(r => '<tr data-k="' + safe(r.key) + '"><td><input type="checkbox" class="lbSel"' + (off.has(r.key) ? '' : ' checked') + '></td><td><strong>' + safe(r.name) + '</strong><br><span class="soft">' + safe(r.barcode) + '</span></td><td class="n">' + brl(r.price_cents) + '</td>'
        + '<td class="n"><input class="lbQ" type="number" min="1" max="500" value="' + r.labels_pending + '" style="width:80px"></td><td class="n"><button type="button" class="linkb lbDel">Tirar da fila</button></td></tr>').join('') || '<tr><td colspan="5" class="soft">A fila desta unidade está vazia.</td></tr>';
      $('lbRows').querySelectorAll('tr[data-k]').forEach(tr => { const k = tr.dataset.k;
        tr.querySelector('.lbSel').onchange = e => { e.target.checked ? off.delete(k) : off.add(k); };
        tr.querySelector('.lbQ').onchange = e => setQty(k, Math.max(1, Math.min(500, Number(e.target.value) || 1)));
        tr.querySelector('.lbDel').onclick = () => setQty(k, 0); });
      const n = rows.filter(r => !off.has(r.key)).reduce((a, r) => a + r.labels_pending, 0); $('lbPrint').disabled = !n; $('lbPrint').textContent = n ? 'Imprimir ' + n + ' etiqueta(s)' : 'Imprimir selecionadas';
    };
    $('lbAll').onchange = e => { off = e.target.checked ? new Set() : new Set(rows.map(r => r.key)); draw(); };
    $('lbUnit').onchange = () => { off = new Set(); $('lbDone').innerHTML = ''; load(); };
    scanBox('lbScan', 'lbSug', async p => { if (!p.barcode) return msg($('lbMsg'), p.name + ' não tem código de barras: gere em "Gerar códigos".', true); try { rows = await api('/network/labels', 'POST', { unit_id: unit(), key: p.key, add: 1 }); off.delete(p.key); msg($('lbMsg'), ''); draw(); } catch (e) { msg($('lbMsg'), e.message, true); } }, $('lbMsg'));
    $('lbPrint').onclick = () => {
      const chosen = rows.filter(r => !off.has(r.key));
      if (!window.FPLabels?.print(chosen.map(r => ({ p: r, n: r.labels_pending })), null, t => msg($('lbMsg'), t, true))) return;
      $('lbDone').innerHTML = '<div class="alert ok"><b>As etiquetas abriram em outra janela. Saíram certinho?</b><div class="actions" style="margin-top:8px"><button type="button" class="btn" id="lbClear">Sim, tirar da fila</button><button type="button" class="btn ghost" id="lbKeep">Não, manter na fila</button></div></div>';
      $('lbClear').onclick = async () => { try { await api('/network/labels/printed', 'POST', { unit_id: unit(), keys: chosen.map(r => r.key) }); $('lbDone').innerHTML = ''; msg($('lbMsg'), 'Etiquetas impressas saíram da fila.'); load(); } catch (e) { msg($('lbMsg'), e.message, true); } };
      $('lbKeep').onclick = () => { $('lbDone').innerHTML = ''; };
    };
    load(); $('lbScan').focus();
  }

  // ---------- Gerar códigos ----------
  async function tabGen() {
    panel.innerHTML = card('Gerar códigos', 'Peças sem código de barras',
      '<p class="soft">Para cadastrar uma peça nova sem código, use "Produtos" e marque "Gerar código". Aqui aparecem as peças já cadastradas que ainda não têm código de barras; o código gerado vale em todas as unidades.</p>'
      + '<div class="form4">' + unitSelect('gnUnit') + '</div><div class="wrap"><table><thead><tr><th>Peça</th><th class="n">Preço</th><th class="n">Estoque na rede</th><th></th></tr></thead><tbody id="gnRows"></tbody></table></div><p class="soft" id="gnMsg"></p>');
    let d; try { d = await api('/network/catalog?no_barcode=1&limit=500'); } catch (e) { return msg($('gnMsg'), e.message, true); }
    $('gnRows').innerHTML = d.items.map(p => '<tr data-k="' + safe(p.key) + '"><td><strong>' + safe(p.name) + '</strong><br><span class="soft">' + safe(p.code || 'sem código') + '</span></td><td class="n">' + brl(p.price_cents) + '</td><td class="n">' + p.total + '</td><td class="n"><button type="button" class="btn ghost gnGo">Gerar código e pôr etiqueta na fila</button></td></tr>').join('') || '<tr><td colspan="4" class="soft">Todas as peças têm código de barras.</td></tr>';
    $('gnRows').querySelectorAll('tr[data-k]').forEach(tr => tr.querySelector('.gnGo').onclick = async () => {
      try { const r = await api('/network/catalog/generate-code', 'POST', { key: tr.dataset.k }); await api('/network/labels', 'POST', { unit_id: $('gnUnit').value, key: r.key, add: 1 }).catch(() => {}); tr.remove(); msg($('gnMsg'), 'Código ' + r.barcode + ' gerado em ' + r.updated + ' unidade(s); etiqueta na fila de ' + $('gnUnit').selectedOptions[0]?.textContent + '.'); }
      catch (e) { msg($('gnMsg'), e.message, true); }
    });
  }

  // ---------- Reposição ----------
  function tabRestock() {
    panel.innerHTML = card('Reposição', '<span id="rsInfo"></span>', '<div class="form4">' + unitSelect('rsUnit', { all: true }) + '</div>'
      + '<div class="wrap"><table><thead><tr><th>Unidade</th><th>Peça</th><th class="n">Estoque</th><th class="n">Vendidas sem repor</th><th class="n">No depósito</th><th></th></tr></thead><tbody id="rsRows"></tbody></table></div>'
      + '<div class="actions"><button type="button" class="btn ghost" id="rsPrint">Imprimir lista</button><span class="soft" id="rsMsg"></span></div>');
    const load = async () => {
      let d; try { d = await api('/network/stock/restock?' + new URLSearchParams({ unit_id: $('rsUnit').value })); } catch (e) { return msg($('rsMsg'), e.message, true); }
      $('rsInfo').textContent = 'Vendidas e ainda não repostas, ou com ' + d.min + ' ou menos e vendendo';
      $('rsRows').innerHTML = d.rows.map(r => '<tr data-u="' + safe(r.unit_id) + '" data-k="' + safe(r.key) + '"><td>' + safe(r.unit) + '</td><td><strong>' + safe(r.name) + '</strong><br><span class="soft">' + safe(r.key) + '</span></td><td class="n">' + r.stock_qty + '</td><td class="n">' + r.sold + '</td><td class="n">' + r.depot_qty + '</td><td class="n"><button type="button" class="linkb rsOk">Reposta</button></td></tr>').join('') || '<tr><td colspan="6" class="soft">Nada para repor.</td></tr>';
      $('rsRows').querySelectorAll('.rsOk').forEach(b => b.onclick = async () => { const tr = b.closest('tr'); try { await api('/network/stock/restocked', 'POST', { unit_id: tr.dataset.u, key: tr.dataset.k }); tr.remove(); } catch (e) { msg($('rsMsg'), e.message, true); } });
    };
    $('rsUnit').onchange = load;
    $('rsPrint').onclick = () => { const w = window.open('', '_blank'); if (!w) return msg($('rsMsg'), 'Libere pop-ups para imprimir.', true); w.document.write('<!doctype html><meta charset="utf-8"><title>Reposição</title><style>body{font:13px Arial}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:6px;text-align:left}button{display:none}</style><h2>Reposição · ' + safe($('rsUnit').selectedOptions[0]?.textContent) + '</h2><table>' + document.querySelector('#rsRows').closest('table').innerHTML + '</table>'); w.document.close(); w.print(); };
    load();
  }

  // ---------- Histórico ----------
  function tabLog() {
    panel.innerHTML = card('Histórico do estoque', 'Toda entrada, venda, transferência, contagem e correção',
      '<div class="form4">' + unitSelect('lgUnit', { all: true }) + '<label>Tipo<select id="lgKind"><option value="">Todos</option>' + Object.entries(KIND).map(([k, t]) => '<option value="' + k + '">' + t + '</option>').join('') + '</select></label>'
      + '<label>Peça<input id="lgQ" placeholder="Código ou nome" autocomplete="off"></label><label>De<input type="date" id="lgFrom"></label><label>Até<input type="date" id="lgTo"></label></div>'
      + '<div class="wrap"><table><thead><tr><th>Quando</th><th>Unidade</th><th>Peça</th><th>O quê</th><th class="n">Qtd.</th><th class="n">Estoque</th><th>Quem</th></tr></thead><tbody id="lgRows"></tbody></table></div>'
      + '<div class="actions" style="justify-content:center"><button type="button" class="linkb" id="lgMore" hidden>Carregar mais</button></div><p class="soft" id="lgMsg"></p>');
    let last = '';
    const load = async more => {
      const qs = new URLSearchParams({ unit_id: $('lgUnit').value, kind: $('lgKind').value, q: $('lgQ').value.trim(), from: $('lgFrom').value, to: $('lgTo').value }); if (more && last) qs.set('before', last);
      let d; try { d = await api('/network/stock/log?' + qs); } catch (e) { return msg($('lgMsg'), e.message, true); }
      const rows = d.rows.map(r => '<tr><td>' + when(r.created_at) + '</td><td>' + safe(r.unit) + '</td><td><strong>' + safe(r.name) + '</strong><br><span class="soft">' + safe(r.key) + '</span></td><td>' + safe(KIND[r.kind] || r.kind) + (r.sale_number ? ' nº ' + r.sale_number : '') + (r.note ? '<br><span class="soft">' + safe(r.note) + '</span>' : '') + '</td>'
        + '<td class="n">' + (r.quantity > 0 ? '+' : '') + r.quantity + '</td><td class="n soft">' + (r.stock_before ?? '—') + ' → ' + (r.stock_after ?? '—') + '</td><td>' + safe(r.who || '') + '</td></tr>').join('');
      $('lgRows').innerHTML = more ? $('lgRows').innerHTML + rows : (rows || '<tr><td colspan="7" class="soft">Nenhum movimento.</td></tr>');
      if (d.rows.length) last = d.rows[d.rows.length - 1].created_at; $('lgMore').hidden = !d.more;
    };
    let t; ['lgUnit', 'lgKind', 'lgFrom', 'lgTo'].forEach(id => $(id).onchange = () => load()); $('lgQ').oninput = () => { clearTimeout(t); t = setTimeout(() => load(), 300); }; $('lgMore').onclick = () => load(true);
    load();
  }

  // ---------- Preços ----------
  function tabPrices() {
    panel.innerHTML = card('Reajuste em lote', 'Vale em todas as unidades',
      '<div class="form4"><label>Percentual<input id="rpPct" inputmode="decimal" placeholder="Ex.: 10 ou -5"></label><label>Arredondar<select id="rpRound"><option value="none">Não arredondar</option><option value="0.10">Para R$ 0,10</option><option value="0.50">Para R$ 0,50</option><option value="1.00">Para R$ 1,00</option></select></label>'
      + '<label>Quais peças<select id="rpFam"><option value="">Todas as famílias</option>' + (meta.families || []).map(f => '<option>' + safe(f) + '</option>').join('') + '</select></label></div>'
      + '<div class="actions"><button type="button" class="btn ghost" id="rpPrev">Ver prévia</button><button type="button" class="btn" id="rpApply" hidden>Aplicar reajuste</button><span class="soft" id="rpMsg"></span></div><div id="rpOut"></div>')
      + card('Preço por peça', 'Mudar aqui muda nas 7 unidades e no depósito', '<div class="row"><label style="flex:1">Buscar<input id="ppQ" placeholder="Código ou nome" autocomplete="off"></label><label>Família<select id="ppFam"><option value="">Todas</option>' + (meta.families || []).map(f => '<option>' + safe(f) + '</option>').join('') + '</select></label></div>'
        + '<div class="wrap"><table><thead><tr><th>Peça</th><th>Família</th><th class="n">Preço</th><th></th></tr></thead><tbody id="ppRows"></tbody></table></div><p class="soft" id="ppMsg"></p>');
    const body = () => { const p = Number(String($('rpPct').value).replace(',', '.')); return { percent: p, rounding: $('rpRound').value, ...($('rpFam').value ? { family: $('rpFam').value } : {}) }; };
    $('rpPrev').onclick = async () => {
      const b = body(); if (!b.percent) return msg($('rpMsg'), 'Informe o percentual.', true);
      try { const r = await api('/network/prices/reprice', 'POST', { ...b, preview: true }); msg($('rpMsg'), r.count + ' peça(s) mudam de preço. Confira e aplique.'); $('rpApply').hidden = false;
        $('rpOut').innerHTML = '<div class="wrap" style="max-height:320px;overflow:auto"><table><thead><tr><th>Peça</th><th class="n">Hoje</th><th class="n">Novo</th></tr></thead><tbody>' + r.items.map(i => '<tr><td>' + safe(i.name) + '</td><td class="n">' + brl(i.old_cents) + '</td><td class="n"><b>' + brl(i.new_cents) + '</b></td></tr>').join('') + '</tbody></table></div>'; }
      catch (e) { msg($('rpMsg'), e.message, true); }
    };
    ['rpPct', 'rpRound', 'rpFam'].forEach(id => $(id).addEventListener('input', () => { $('rpApply').hidden = true; $('rpOut').innerHTML = ''; }));
    $('rpApply').onclick = async () => { try { const r = await api('/network/prices/reprice', 'POST', body()); $('rpApply').hidden = true; $('rpOut').innerHTML = ''; msg($('rpMsg'), 'Preços reajustados: ' + r.count + ' peça(s) em todas as unidades.'); loadPP(); } catch (e) { msg($('rpMsg'), e.message, true); } };
    const loadPP = async () => {
      let d; try { d = await api('/network/catalog?' + new URLSearchParams({ q: $('ppQ').value.trim(), family: $('ppFam').value, limit: 300 })); } catch (e) { return msg($('ppMsg'), e.message, true); }
      $('ppRows').innerHTML = d.items.map(p => '<tr data-k="' + safe(p.key) + '"><td><strong>' + safe(p.name) + '</strong><br><span class="soft">' + safe(p.code || p.key) + '</span></td><td>' + safe(p.family || '') + '</td><td class="n"><input class="ppIn" inputmode="decimal" value="' + money(p.price_cents) + '" style="width:110px">' + (p.prices_differ ? '<br><small style="color:var(--red)">diferente entre unidades</small>' : '') + '</td><td class="n"><button type="button" class="btn ghost ppSave">Salvar</button></td></tr>').join('') || '<tr><td colspan="4" class="soft">Nenhuma peça.</td></tr>';
      msg($('ppMsg'), d.total > d.items.length ? 'Mostrando ' + d.items.length + ' de ' + d.total + '. Use a busca.' : '');
      $('ppRows').querySelectorAll('tr[data-k]').forEach(tr => tr.querySelector('.ppSave').onclick = async () => { const c = toCents(tr.querySelector('.ppIn').value); if (!c) return msg($('ppMsg'), 'Confira o preço.', true); try { const r = await api('/network/catalog/update', 'POST', { key: tr.dataset.k, price_cents: c }); msg($('ppMsg'), 'Preço salvo em ' + r.updated + ' unidade(s).'); } catch (e) { msg($('ppMsg'), e.message, true); } });
    };
    let t; $('ppQ').oninput = () => { clearTimeout(t); t = setTimeout(loadPP, 300); }; $('ppFam').onchange = loadPP; loadPP();
  }

  // ---------- Valor do estoque (só o dono) ----------
  async function tabValue() {
    panel.innerHTML = card('Valor do estoque', 'Só o dono vê', '<div class="wrap"><table><thead><tr><th>Unidade</th><th class="n">Peças diferentes</th><th class="n">Unidades em estoque</th><th class="n">Custo</th><th class="n">Preço de venda</th><th class="n">Lucro esperado</th><th class="n">Sem custo</th></tr></thead><tbody id="vlRows"></tbody><tfoot id="vlFoot"></tfoot></table></div><p class="soft" id="vlMsg">Custo e lucro esperado contam só as peças com custo cadastrado; as "sem custo" entram só no preço de venda.</p>');
    let d; try { d = await api('/network/stock/value'); } catch (e) { return msg($('vlMsg'), e.message, true); }
    const row = (name, x) => '<td class="n">' + x.items + '</td><td class="n">' + x.qty + '</td><td class="n">' + brl(x.cost_cents) + '</td><td class="n">' + brl(x.price_cents) + '</td><td class="n">' + (x.no_cost === x.items ? '—' : brl(x.profit_cents)) + '</td><td class="n soft">' + x.no_cost + '</td>';
    $('vlRows').innerHTML = d.rows.map(x => '<tr><td>' + safe(x.unit) + (x.depot && !/dep[oó]sito/i.test(x.unit) ? ' <span class="soft">(depósito)</span>' : '') + '</td>' + row(x.unit, x) + '</tr>').join('');
    $('vlFoot').innerHTML = '<tr><td>Rede</td>' + row('Rede', d.total) + '</tr>';
  }

  // ---------- Abas ----------
  const TABS = [['mx', 'Estoque por unidade'], ['prod', 'Produtos'], ['entry', 'Entrada rápida'], ['labels', 'Etiquetas'], ['gen', 'Gerar códigos'], ['restock', 'Reposição'], ['log', 'Histórico'], ['prices', 'Preços'], ['value', 'Valor do estoque']];
  const RUN = { prod: tabProducts, entry: tabEntry, labels: tabLabels, gen: tabGen, restock: tabRestock, log: tabLog, prices: tabPrices, value: tabValue };
  async function open(t) {
    tab = t; try { sessionStorage.setItem('fp_ns_tab', t); } catch { }
    root.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    $('bStock').hidden = t !== 'mx'; panel.hidden = t === 'mx';
    if (t === 'mx') { N.loadMatrix(); return; }
    panel.innerHTML = '<p class="soft">Carregando…</p>';
    try { await loadMeta(); await RUN[t](); } catch (e) { panel.innerHTML = '<p class="feedback">' + safe(e.message) + '</p>'; }
  }
  N.stockTabs = {
    draw() {
      const owner = N.access() !== 'supervisor';
      root.innerHTML = TABS.filter(([t]) => t !== 'value' || owner).map(([t, l]) => '<button type="button" data-t="' + t + '"' + (t === tab ? ' class="on"' : '') + '>' + l + '</button>').join('');
      root.querySelectorAll('button').forEach(b => b.onclick = () => open(b.dataset.t));
    },
    show() { this.draw(); let t = 'mx'; try { t = sessionStorage.getItem('fp_ns_tab') || 'mx'; } catch { } if (t === 'value' && N.access() === 'supervisor') t = 'mx'; open(t); }
  };
})();
