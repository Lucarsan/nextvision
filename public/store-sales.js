// Caixa, vendas ligadas a clientes, fidelidade e mensagens do dia (WhatsApp por clique).
// Só aparece quando a central liga "Caixa e mensagens" para a loja.
(() => {
  const token = sessionStorage.getItem('nv_token');
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const hhmm = d => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dmy = d => new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const first = name => String(name || '').trim().split(/\s+/)[0] || '';
  const cap = t => t ? t[0].toLocaleUpperCase('pt-BR') + t.slice(1).toLocaleLowerCase('pt-BR') : '';
  const METHODS = { cash: 'Dinheiro', pix: 'Pix', debit: 'Débito', credit: 'Crédito', other: 'Outro' };
  const DEFAULT_STATUS = 'Olá, {cliente}! Obrigado pela preferência na {loja}. 🙏\n\n{fidelidade}\n\nSua opinião ajuda muito: pode nos avaliar no Google? Leva 1 minutinho: {avaliacao}';
  let config = null, saleCustomer = null, lastSale = null;

  async function api(path, method = 'GET', body) {
    const r = await fetch('/api' + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(data.error || 'Não foi possível concluir a operação');
    return data;
  }
  // "12,50", "1.234,56" ou "12.5" → centavos
  function parseMoney(v) {
    let s = String(v || '').trim().replace(/[^\d.,]/g, '');
    if (!s) return NaN;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = Math.round(Number(s) * 100); return Number.isFinite(n) ? n : NaN;
  }
  function waPhone(p) {
    let d = String(p || '').replace(/\D/g, '');
    if (d.length >= 11 && d.length <= 12 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 10 || d.length === 11) d = '55' + d;
    return d.length >= 12 ? d : '';
  }
  const waLink = (phone, text) => 'https://wa.me/' + waPhone(phone) + '?text=' + encodeURIComponent(text);

  function loyaltyText(l) {
    if (!l || !l.enabled) return '';
    const rules = config.loyalty_rules ? '\nRegras: ' + config.loyalty_rules : '';
    if (l.complete) return `🎁 Você completou o cartão fidelidade e já pode resgatar: ${l.reward}. É só pedir aqui na loja.` + rules;
    return `⭐ Cartão fidelidade: ${l.checkins} de ${l.target} compras. ${l.remaining === 1 ? 'Falta 1 compra' : 'Faltam ' + l.remaining + ' compras'} para ganhar: ${l.reward}.` + rules;
  }
  function render(template, values) {
    let lines = template.split('\n');
    if (!values.avaliacao) lines = lines.filter(line => !line.includes('{avaliacao}'));
    return lines.join('\n').replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m)).replace(/\n{3,}/g, '\n\n').trim();
  }
  const statusMessage = c => render(config.status_message || DEFAULT_STATUS, {
    cliente: cap(first(c.name)) || 'tudo bem', loja: config.name || 'loja', fidelidade: loyaltyText(c.loyalty), avaliacao: config.google_review_url || '',
    compras: c.loyalty?.checkins ?? '', meta: c.loyalty?.target ?? '', faltam: c.loyalty?.remaining ?? '', premio: c.loyalty?.reward ?? '', regras: config.loyalty_rules || ''
  });
  const offerMessage = (c, text) => `Olá, ${cap(first(c.name)) || 'tudo bem'}! ${text}\n\n— ${config.name || ''}\nSe não quiser mais receber ofertas, é só responder SAIR.`;

  function progressBar(l) {
    if (!l || !l.enabled) return '';
    const pct = Math.min(100, Math.round(100 * l.checkins / l.target));
    return `<div class="fs-loyal" title="Cartão fidelidade"><div class="fs-bar"><span style="width:${pct}%"></span></div><small>${l.complete ? '🎁 Prêmio liberado' : `${l.checkins}/${l.target} · faltam ${l.remaining}`}</small></div>`;
  }
  function feedback(text, error = false) {
    const n = $('panelFeedback'); if (!n) return; n.textContent = text; n.classList.toggle('error', error); n.hidden = !text;
  }
  function openDialog(html) { const d = $('editorDialog'); d.innerHTML = html; if (!d.open) d.showModal(); return d; }
  const header = t => `<div class="nv-heading"><h2 id="dialogTitle">${t}</h2><button type="button" class="nv-button secondary" data-close-dialog aria-label="Fechar">✕</button></div>`;

  // Abre o WhatsApp na hora do clique (antes de qualquer espera, para o navegador não bloquear)
  // e registra o envio.
  function sendWhats(phone, text, record) {
    const w = window.open(waLink(phone, text), '_blank'); if (w) w.opener = null;
    return api('/store/messages/sent', 'POST', record);
  }
  async function redeem(customerId, name) {
    if (!confirm(`Entregar o prêmio do cartão fidelidade para ${name}? As compras usadas serão zeradas.`)) return null;
    const r = await api(`/store/sales/customers/${customerId}/redeem`, 'POST');
    feedback(`Prêmio entregue: ${r.reward}.`); return r;
  }

  // ---------------- Caixa ----------------
  async function loadCash(box, alive) {
    const data = await api('/store/cash'); if (!alive()) return;
    if (!data.session) return drawClosed(box, data, alive);
    const s = data.session, sum = data.summary;
    const methods = Object.entries(sum.by_method).map(([k, v]) => `<span class="fs-pill">${METHODS[k]} <b>${brl(v.total_cents)}</b> <small>(${v.count})</small></span>`).join('') || '<span class="nv-help">Nenhuma venda ainda.</span>';
    box.innerHTML = `
      <section class="nv-card fs-cashbar"><div><div class="nv-card-label">Caixa aberto às ${hhmm(s.opened_at)} por ${esc(s.opened_by_name)}</div>
        <div class="fs-kpis"><div><small>Vendas</small><b>${sum.sales_count}</b></div><div><small>Total vendido</small><b>${brl(sum.sales_total_cents)}</b></div><div><small>Dinheiro na gaveta</small><b>${brl(sum.expected_cash_cents)}</b></div></div></div>
        <div class="fs-actions"><button class="nv-button secondary" id="fsWithdraw">− Sangria</button><button class="nv-button secondary" id="fsDeposit">+ Suprimento</button><button class="nv-button" id="fsClose">Fechar caixa</button></div></section>
      <div class="fs-grid">
        <section class="nv-card"><h2>Nova venda</h2><form id="fsSale" autocomplete="off">
          <div class="nv-field">Cliente<div id="fsCustomerBox"></div></div>
          <div id="fsOrderBox"></div>
          <div class="fs-row"><label class="nv-field">Valor<input name="total" inputmode="decimal" placeholder="0,00" required></label>
          <label class="nv-field fs-grow">Descrição (opcional)<input name="description" maxlength="300" placeholder="Ex.: película, carregador, conserto"></label></div>
          <fieldset class="fs-methods"><legend>Pagamento</legend>${Object.entries(METHODS).map(([k, v], i) => `<label><input type="radio" name="method" value="${k}" ${i === 1 ? 'checked' : ''}><span>${v}</span></label>`).join('')}</fieldset>
          <div id="fsChangeBox" class="fs-row fs-change" hidden><label class="nv-field">Valor recebido<input name="received" inputmode="decimal" placeholder="0,00"></label><div class="fs-change-out" id="fsChangeOut" aria-live="polite"></div></div>
          <button class="nv-button fs-wide" id="fsSaleBtn">Registrar venda</button><p role="status" id="fsSaleStatus" class="nv-help"></p></form>
          <div id="fsLast"></div></section>
        <section class="nv-card"><div class="nv-heading"><h2>Vendas deste caixa</h2></div><div class="fs-methods-sum">${methods}</div>
          <div class="nv-list">${data.sales.map(x => `<div class="fs-sale ${x.canceled_at ? 'canceled' : ''}"><div><b>#${x.sale_number}</b> · ${hhmm(x.created_at)} · ${esc(x.customer_name || 'Sem cliente')}${x.order_number ? ` · pedido ${esc(x.order_number)}` : ''}<br><small>${METHODS[x.payment_method]}${x.description ? ' · ' + esc(x.description) : ''}${x.canceled_at ? ' · cancelada: ' + esc(x.cancel_reason) : ''}</small></div><div class="fs-sale-end"><b>${brl(x.total_cents)}</b>${x.canceled_at ? '' : `<button class="nv-button secondary fs-small" data-fs-cancel="${x.id}">Cancelar</button>`}</div></div>`).join('') || '<p class="nv-help">As vendas registradas aparecem aqui.</p>'}</div>
          ${data.movements.length ? `<h3>Sangrias e suprimentos</h3>${data.movements.map(m => `<div class="fs-sale"><div>${m.kind === 'withdrawal' ? 'Sangria' : 'Suprimento'} · ${hhmm(m.created_at)}${m.note ? ' · ' + esc(m.note) : ''}</div><b>${m.kind === 'withdrawal' ? '−' : '+'}${brl(m.amount_cents)}</b></div>`).join('')}` : ''}
          <p class="nv-help">Troco inicial: ${brl(sum.opening_cents)}</p></section>
      </div>`;
    saleCustomer = null; drawCustomerPicker(); if (lastSale) drawLast();
    const sf = $('fsSale');
    const updChange = () => {
      const cash = sf.elements.method.value === 'cash'; $('fsChangeBox').hidden = !cash;
      const out = $('fsChangeOut'), total = parseMoney(sf.elements.total.value), got = parseMoney(sf.elements.received.value);
      if (!cash || !Number.isFinite(got)) { out.textContent = ''; return; }
      if (!Number.isFinite(total) || total <= 0) { out.textContent = 'Informe o valor da venda.'; return; }
      const d = got - total;
      out.innerHTML = d >= 0 ? `Troco: <b>${brl(d)}</b>` : `<span class="fs-neg">Faltam ${brl(-d)}</span>`;
    };
    sf.addEventListener('input', updChange); sf.addEventListener('change', updChange); updChange();
    $('fsSale').onsubmit = e => submitSale(e, box, alive);
    $('fsWithdraw').onclick = () => movement('withdrawal', box, alive);
    $('fsDeposit').onclick = () => movement('deposit', box, alive);
    $('fsClose').onclick = () => closeCash(sum, box, alive);
    box.querySelectorAll('[data-fs-cancel]').forEach(b => b.onclick = async () => {
      const reason = prompt('Motivo do cancelamento (ex.: lançada em dobro):'); if (!reason || reason.trim().length < 3) return;
      try { const r = await api(`/store/sales/${b.dataset.fsCancel}/cancel`, 'POST', { reason: reason.trim() }); feedback('Venda cancelada.' + (r.loyalty_already_redeemed ? ' A compra já tinha sido usada num prêmio e continua no histórico do cartão.' : '')); loadCash(box, alive); }
      catch (err) { feedback(err.message, true); }
    });
  }

  function drawClosed(box, data, alive) {
    const l = data.last_closed;
    const diff = l && l.counted_cash_cents != null ? l.counted_cash_cents - l.expected_cash_cents : null;
    box.innerHTML = `<section class="nv-card fs-open"><h2>Caixa fechado</h2><p class="nv-help">Abra o caixa para registrar as vendas do dia. Cada venda fica ligada a um cliente e soma no cartão fidelidade.</p>
      <form id="fsOpen" class="fs-row"><label class="nv-field">Troco inicial na gaveta<input name="opening" inputmode="decimal" placeholder="0,00"></label><button class="nv-button">Abrir caixa</button></form><p role="status" class="nv-help" id="fsOpenStatus"></p>
      ${l ? `<p class="nv-help">Último fechamento: ${dmy(l.closed_at)} às ${hhmm(l.closed_at)}${l.closed_by_name ? ' por ' + esc(l.closed_by_name) : ''} · esperado ${brl(l.expected_cash_cents)} · contado ${brl(l.counted_cash_cents)}${diff ? ` · <b class="${diff < 0 ? 'fs-neg' : 'fs-pos'}">diferença ${brl(diff)}</b>` : ' · sem diferença'}</p>` : ''}
      <button class="nv-button secondary" id="fsHistory">Histórico de caixas</button></section>`;
    $('fsOpen').onsubmit = async e => {
      e.preventDefault(); const raw = e.currentTarget.elements.opening.value; const v = raw.trim() ? parseMoney(raw) : 0;
      if (!Number.isFinite(v) || v < 0) { $('fsOpenStatus').textContent = 'Valor inválido.'; return; }
      try { await api('/store/cash/open', 'POST', { opening_cents: v }); feedback('Caixa aberto.'); loadCash(box, alive); } catch (err) { $('fsOpenStatus').textContent = err.message; }
    };
    $('fsHistory').onclick = history;
  }

  async function history() {
    const rows = await api('/store/cash/sessions');
    openDialog(`${header('Histórico de caixas')}<div class="fs-table"><table><thead><tr><th>Abertura</th><th>Fechamento</th><th>Vendas</th><th>Com cliente</th><th>Total</th><th>Gaveta (esperado / contado)</th></tr></thead><tbody>${rows.map(r => {
      const diff = r.counted_cash_cents != null ? r.counted_cash_cents - r.expected_cash_cents : null;
      return `<tr><td>${dmy(r.opened_at)} ${hhmm(r.opened_at)}<br><small>${esc(r.opened_by_name)}</small></td><td>${r.closed_at ? dmy(r.closed_at) + ' ' + hhmm(r.closed_at) : '<b>aberto</b>'}</td><td>${r.sales_count}</td><td>${r.sales_count ? Math.round(100 * r.linked_count / r.sales_count) + '%' : '—'}</td><td>${brl(r.sales_total_cents)}</td><td>${r.closed_at ? `${brl(r.expected_cash_cents)} / ${brl(r.counted_cash_cents)}${diff ? ` <b class="${diff < 0 ? 'fs-neg' : 'fs-pos'}">(${brl(diff)})</b>` : ''}` : '—'}${r.close_note ? `<br><small>${esc(r.close_note)}</small>` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="6">Nenhum caixa ainda.</td></tr>'}</tbody></table></div>`);
  }

  function drawCustomerPicker() {
    const box = $('fsCustomerBox'); if (!box) return;
    if (saleCustomer?.id || saleCustomer?.anonymous) {
      const c = saleCustomer;
      box.innerHTML = `<div class="fs-picked"><div><b>${c.anonymous ? 'Venda sem cliente' : esc(c.name)}</b>${c.phone ? ' · ' + esc(c.phone) : ''}${progressBar(c.loyalty)}</div><button type="button" class="nv-button secondary fs-small" id="fsChange">Trocar</button></div>`;
      $('fsChange').onclick = () => { saleCustomer = null; drawCustomerPicker(); $('fsOrderBox').innerHTML = ''; };
      return;
    }
    if (saleCustomer?.isNew) {
      box.innerHTML = `<div class="fs-row"><input id="fsNewName" placeholder="Nome do cliente" maxlength="120"><input id="fsNewPhone" placeholder="WhatsApp (85 9…)" inputmode="tel" maxlength="30"></div><button type="button" class="nv-button secondary fs-small" id="fsBack">Buscar cliente cadastrado</button>`;
      $('fsBack').onclick = () => { saleCustomer = null; drawCustomerPicker(); }; $('fsNewName').focus(); return;
    }
    box.innerHTML = `<input id="fsSearch" type="search" placeholder="Buscar por nome ou WhatsApp" aria-label="Buscar cliente"><div id="fsResults" class="fs-results"></div>
      <div class="fs-row fs-small-row"><button type="button" class="nv-button secondary fs-small" id="fsNew">+ Cliente novo</button><button type="button" class="nv-button secondary fs-small" id="fsAnon">Não quis se identificar</button></div>`;
    let timer;
    $('fsSearch').oninput = e => { clearTimeout(timer); timer = setTimeout(async () => {
      const term = e.target.value.trim(); const out = $('fsResults'); if (!out) return;
      if (term.length < 2) { out.innerHTML = ''; return; }
      try {
        const rows = await api('/store/sales/customers?q=' + encodeURIComponent(term));
        out.innerHTML = rows.map(r => `<button type="button" data-fs-pick="${r.id}"><b>${esc(r.name)}</b> <small>${esc(r.phone || 'sem telefone')}</small>${progressBar(r.loyalty)}</button>`).join('') || '<p class="nv-help">Nenhum cliente encontrado. Use "+ Cliente novo".</p>';
        out.querySelectorAll('[data-fs-pick]').forEach(b => b.onclick = () => pick(b.dataset.fsPick));
      } catch (err) { out.textContent = err.message; }
    }, 220); };
    $('fsNew').onclick = () => { const term = $('fsSearch').value.trim(); saleCustomer = { isNew: true }; drawCustomerPicker(); if (/\d{4,}/.test(term)) $('fsNewPhone').value = term; else $('fsNewName').value = term; };
    $('fsAnon').onclick = () => { saleCustomer = { anonymous: true }; drawCustomerPicker(); };
  }
  async function pick(id) {
    const c = await api('/store/sales/customers/' + id); saleCustomer = c; drawCustomerPicker();
    const box = $('fsOrderBox');
    box.innerHTML = c.orders.length ? `<label class="nv-field">É pagamento de um pedido de serviço? (opcional)<select id="fsOrder"><option value="">Não, venda avulsa</option>${c.orders.map(o => `<option value="${o.id}">Pedido ${esc(o.order_number || '')} · ${esc(o.details?.model || o.details?.brand || o.process || '')} · ${o.status === 'completed' ? 'finalizado' : 'em andamento'} · ${dmy(o.created_at)}</option>`).join('')}</select><small>Pedido de serviço já conta no cartão quando é finalizado; a venda dele não conta de novo.</small></label>` : '';
  }

  async function submitSale(e, box, alive) {
    e.preventDefault(); const f = e.currentTarget, status = $('fsSaleStatus'), btn = $('fsSaleBtn');
    const total = parseMoney(f.elements.total.value);
    if (!Number.isFinite(total) || total <= 0) { status.textContent = 'Informe o valor da venda.'; return; }
    const received = f.elements.method.value === 'cash' && f.elements.received.value.trim() ? parseMoney(f.elements.received.value) : null;
    if (received != null && (!Number.isFinite(received) || received < total)) { status.textContent = 'O valor recebido é menor que o valor da venda.'; return; }
    const body = { total_cents: total, payment_method: f.elements.method.value, description: f.elements.description.value.trim() };
    if (saleCustomer?.id) { body.customer_id = saleCustomer.id; const o = $('fsOrder')?.value; if (o) body.order_id = o; }
    else if (saleCustomer?.anonymous) body.anonymous = true;
    else if (saleCustomer?.isNew) { const name = $('fsNewName').value.trim(); if (name.length < 2) { status.textContent = 'Informe o nome do cliente.'; return; } body.new_customer = { name, phone: $('fsNewPhone').value.trim() }; }
    else { status.textContent = 'Escolha o cliente (ou marque "Não quis se identificar").'; return; }
    btn.disabled = true;
    try { lastSale = await api('/store/sales', 'POST', body); lastSale.change_cents = received != null ? received - total : null; feedback(`Venda #${lastSale.sale.sale_number} registrada: ${brl(lastSale.sale.total_cents)}.` + (lastSale.change_cents != null ? ` Troco: ${brl(lastSale.change_cents)}.` : '')); await loadCash(box, alive); }
    catch (err) { status.textContent = err.message; } finally { if (btn.isConnected) btn.disabled = false; }
  }
  function drawLast() {
    const box = $('fsLast'); if (!box || !lastSale) return; const s = lastSale, c = s.customer;
    if (!c) { box.innerHTML = `<div class="fs-last"><b>Venda #${s.sale.sale_number}</b> · ${brl(s.sale.total_cents)} · sem cliente${s.change_cents != null ? ` · <b>troco ${brl(s.change_cents)}</b>` : ''}</div>`; return; }
    const note = s.loyalty?.enabled ? (s.loyalty_counted ? 'Somou 1 compra no cartão.' : s.sale.order_id ? 'Pagamento de pedido: conta no cartão quando o pedido é finalizado.' : 'Abaixo do valor mínimo: não somou no cartão.') : '';
    box.innerHTML = `<div class="fs-last"><div><b>Venda #${s.sale.sale_number}</b> · ${brl(s.sale.total_cents)}${s.change_cents != null ? ` · <b>troco ${brl(s.change_cents)}</b>` : ''} · ${esc(c.name)}${s.customer_created ? ' <small>(cadastrado agora)</small>' : ''}<br><small>${note}</small>${progressBar(s.loyalty)}</div>
      <div class="fs-actions">${waPhone(c.phone) ? '<button type="button" class="nv-button fp-whats" id="fsSendNow">Enviar status no WhatsApp</button>' : '<small>Cliente sem WhatsApp cadastrado.</small>'}${s.loyalty?.complete ? '<button type="button" class="nv-button secondary" id="fsRedeemNow">Entregar prêmio</button>' : ''}</div></div>`;
    if ($('fsSendNow')) $('fsSendNow').onclick = async () => { const b = $('fsSendNow'); try { await sendWhats(c.phone, statusMessage({ ...c, loyalty: s.loyalty }), { customer_id: c.id, kind: 'status' }); b.textContent = 'Enviado ✓'; b.disabled = true; } catch (err) { feedback(err.message, true); } };
    if ($('fsRedeemNow')) $('fsRedeemNow').onclick = async () => { try { const r = await redeem(c.id, c.name); if (r) { lastSale = { ...s, loyalty: r.loyalty }; drawLast(); } } catch (err) { feedback(err.message, true); } };
  }

  function movement(kind, box, alive) {
    const title = kind === 'withdrawal' ? 'Sangria (retirar dinheiro da gaveta)' : 'Suprimento (colocar dinheiro na gaveta)';
    openDialog(`${header(title)}<form id="fsMove"><label class="nv-field">Valor<input name="amount" inputmode="decimal" required placeholder="0,00"></label><label class="nv-field">Motivo<input name="note" maxlength="200" placeholder="${kind === 'withdrawal' ? 'Ex.: pagamento de fornecedor' : 'Ex.: troco extra'}"></label><button class="nv-button">Confirmar</button><p role="status" class="nv-help"></p></form>`);
    $('fsMove').onsubmit = async e => {
      e.preventDefault(); const f = e.currentTarget, v = parseMoney(f.elements.amount.value);
      if (!Number.isFinite(v) || v <= 0) { f.querySelector('[role=status]').textContent = 'Valor inválido.'; return; }
      try { await api('/store/cash/movements', 'POST', { kind, amount_cents: v, note: f.elements.note.value.trim() }); $('editorDialog').close(); feedback('Registrado.'); loadCash(box, alive); }
      catch (err) { f.querySelector('[role=status]').textContent = err.message; }
    };
  }

  function closeCash(sum, box, alive) {
    const lines = Object.entries(sum.by_method).map(([k, v]) => `<tr><td>${METHODS[k]}</td><td>${v.count}</td><td>${brl(v.total_cents)}</td></tr>`).join('');
    openDialog(`${header('Fechar caixa')}<div class="fs-table"><table><thead><tr><th>Pagamento</th><th>Vendas</th><th>Total</th></tr></thead><tbody>${lines || '<tr><td colspan="3">Nenhuma venda.</td></tr>'}<tr><th>Total</th><th>${sum.sales_count}</th><th>${brl(sum.sales_total_cents)}</th></tr></tbody></table></div>
      <p class="nv-help">Dinheiro esperado na gaveta: troco ${brl(sum.opening_cents)} + vendas em dinheiro ${brl(sum.by_method.cash?.total_cents || 0)} + suprimentos ${brl(sum.deposits_cents)} − sangrias ${brl(sum.withdrawals_cents)} = <b>${brl(sum.expected_cash_cents)}</b></p>
      <form id="fsCloseForm"><label class="nv-field">Dinheiro contado na gaveta<input name="counted" inputmode="decimal" required placeholder="0,00"></label><p id="fsDiff" class="nv-help"></p><label class="nv-field">Observação (opcional)<input name="note" maxlength="400"></label><button class="nv-button">Fechar caixa</button><p role="status" class="nv-help"></p></form>`);
    const f = $('fsCloseForm');
    f.elements.counted.oninput = () => { const v = parseMoney(f.elements.counted.value); const d = v - sum.expected_cash_cents; $('fsDiff').innerHTML = Number.isFinite(v) ? (d === 0 ? 'Bateu certinho ✓' : `Diferença: <b class="${d < 0 ? 'fs-neg' : 'fs-pos'}">${brl(d)}</b> (${d < 0 ? 'faltando' : 'sobrando'})`) : ''; };
    f.onsubmit = async e => {
      e.preventDefault(); const v = parseMoney(f.elements.counted.value);
      if (!Number.isFinite(v) || v < 0) { f.querySelector('[role=status]').textContent = 'Informe o valor contado.'; return; }
      try { const r = await api('/store/cash/close', 'POST', { counted_cash_cents: v, note: f.elements.note.value.trim() }); $('editorDialog').close(); lastSale = null; feedback(`Caixa fechado. ${r.summary.sales_count} vendas, ${brl(r.summary.sales_total_cents)}.` + (r.difference_cents ? ` Diferença na gaveta: ${brl(r.difference_cents)}.` : '')); loadCash(box, alive); }
      catch (err) { f.querySelector('[role=status]').textContent = err.message; }
    };
  }

  // ---------------- Mensagens ----------------
  let msgTab = 'status', statusDay = '';
  async function loadMessages(box, alive) {
    box.innerHTML = `<section class="nv-card"><div class="fs-tabs" role="tablist">${[['status', 'Status do dia'], ['offers', 'Ofertas'], ['config', 'Configurar']].map(([k, v]) => `<button type="button" role="tab" aria-selected="${msgTab === k}" data-fs-tab="${k}">${v}</button>`).join('')}</div><div id="fsTab"></div></section>`;
    box.querySelectorAll('[data-fs-tab]').forEach(b => b.onclick = () => { msgTab = b.dataset.fsTab; loadMessages(box, alive); });
    const tab = $('fsTab');
    if (msgTab === 'status') return statusTab(tab, alive);
    if (msgTab === 'offers') return offersTab(tab, alive);
    return configTab(tab, alive);
  }

  async function statusTab(tab, alive) {
    const data = await api('/store/messages/status' + (statusDay ? '?day=' + statusDay : '')); if (!alive()) return;
    statusDay = data.day;
    const yesterday = (() => { const d = new Date(data.day + 'T12:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
    const rows = data.customers, sent = rows.filter(r => r.sent).length;
    tab.innerHTML = `<div class="fs-row fs-daybar"><label class="nv-field">Compras do dia<input type="date" id="fsDay" value="${data.day}"></label><button type="button" class="nv-button secondary fs-small" id="fsToday">Hoje</button><button type="button" class="nv-button secondary fs-small" id="fsYesterday">Ontem</button>
      <span class="fs-grow"></span><b>${sent} de ${rows.length} enviados</b>${rows.length > sent ? '<button type="button" class="nv-button fp-whats" id="fsNext">Enviar próximo</button>' : ''}</div>
      ${!config.google_review_url ? '<p class="nv-help fs-warn">Cadastre o link de avaliação do Google em "Configurar" para ele entrar na mensagem.</p>' : ''}
      <p class="nv-help">Clientes que compraram no dia (caixa e pedidos finalizados). "Enviar" abre o WhatsApp com a mensagem pronta: obrigado, cartão fidelidade e pedido de avaliação.</p>
      <div class="nv-list">${rows.map(r => `<div class="fs-msg ${r.sent ? 'sent' : ''}" data-fs-row="${r.id}"><div class="fs-grow"><b>${esc(r.name)}</b> <small>${esc(r.phone || 'sem WhatsApp')}</small><br><small>${r.purchases.map(p => p.kind === 'sale' ? `venda #${esc(p.ref)} ${brl(p.total_cents)}` : `pedido ${esc(p.ref)} finalizado`).join(' · ')}</small>${progressBar(r.loyalty)}
        <details><summary>Ver mensagem</summary><pre class="fs-pre">${esc(statusMessage(r))}</pre></details></div>
        <div class="fs-actions">${r.sent ? `<span class="fs-ok">Enviado ✓</span>` : ''}${waPhone(r.phone) ? `<button type="button" class="nv-button ${r.sent ? 'secondary' : 'fp-whats'} fs-small" data-fs-send="${r.id}">${r.sent ? 'Reenviar' : 'Enviar'}</button>` : ''}${r.loyalty?.complete ? `<button type="button" class="nv-button secondary fs-small" data-fs-redeem="${r.id}">Entregar prêmio</button>` : ''}</div></div>`).join('') || '<p class="nv-help">Nenhuma compra com cliente identificado neste dia.</p>'}</div>`;
    $('fsDay').onchange = e => { statusDay = e.target.value; statusTab(tab, alive); };
    $('fsToday').onclick = () => { statusDay = ''; statusTab(tab, alive); };
    $('fsYesterday').onclick = () => { statusDay = yesterday; statusTab(tab, alive); };
    const send = async id => {
      const r = rows.find(x => x.id === id); if (!r) return;
      try { await sendWhats(r.phone, statusMessage(r), { customer_id: r.id, kind: 'status' }); r.sent = true; statusTab(tab, alive); } catch (err) { feedback(err.message, true); }
    };
    tab.querySelectorAll('[data-fs-send]').forEach(b => b.onclick = () => send(b.dataset.fsSend));
    tab.querySelectorAll('[data-fs-redeem]').forEach(b => b.onclick = async () => { const r = rows.find(x => x.id === b.dataset.fsRedeem); try { if (await redeem(r.id, r.name)) statusTab(tab, alive); } catch (err) { feedback(err.message, true); } });
    if ($('fsNext')) $('fsNext').onclick = () => { const next = rows.find(r => !r.sent && waPhone(r.phone)); if (next) send(next.id); else feedback('Os clientes restantes não têm WhatsApp cadastrado.', true); };
  }

  const campaignKey = text => { let h = 0; for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0; return 'of-' + h.toString(36); };
  let offerText = '', offerDays = '';
  async function offersTab(tab, alive) {
    offerText = offerText || config.offer_message || '';
    tab.innerHTML = `<form id="fsOfferForm"><label class="nv-field">Texto da oferta<textarea name="text" rows="4" maxlength="800" placeholder="Ex.: Esta semana, película 3D com 20% de desconto. Válido até sábado.">${esc(offerText)}</textarea></label>
      <div class="fs-row"><label class="nv-field">Para quem<select name="days"><option value="">Todos os clientes com WhatsApp</option>${[30, 90, 180, 365].map(d => `<option value="${d}" ${String(d) === offerDays ? 'selected' : ''}>Compraram nos últimos ${d} dias</option>`).join('')}</select></label><button class="nv-button">Preparar lista</button></div></form>
      <p class="nv-help">O envio é um por um, pelo WhatsApp da loja. Para evitar bloqueio do WhatsApp, envie em ritmo tranquilo, priorize quem já conversa com a loja e respeite quem pedir para sair. A mensagem termina com "responda SAIR".</p><div id="fsOfferList"></div>`;
    $('fsOfferForm').onsubmit = async e => {
      e.preventDefault(); offerText = e.currentTarget.elements.text.value.trim(); offerDays = e.currentTarget.elements.days.value;
      if (offerText.length < 5) { feedback('Escreva a oferta.', true); return; }
      if (offerText !== config.offer_message && config.role === 'owner') { api('/store/sales/config', 'PATCH', { offer_message: offerText }).then(() => { config.offer_message = offerText; }).catch(() => {}); }
      drawOfferList(alive);
    };
    if (offerText) drawOfferList(alive);
  }
  async function drawOfferList(alive) {
    const out = $('fsOfferList'); if (!out) return; const key = campaignKey(offerText);
    const rows = await api(`/store/messages/offers?campaign=${encodeURIComponent(key)}${offerDays ? '&days=' + offerDays : ''}`); if (!alive()) return;
    const sent = rows.filter(r => r.sent).length;
    out.innerHTML = `<div class="fs-row fs-daybar"><b>${sent} de ${rows.length} enviados</b><span class="fs-grow"></span>${rows.length > sent ? '<button type="button" class="nv-button fp-whats" id="fsOfferNext">Enviar próximo</button>' : ''}</div>
      <details><summary>Ver mensagem</summary><pre class="fs-pre">${esc(offerMessage({ name: 'Maria' }, offerText))}</pre></details>
      <div class="nv-list">${rows.map(r => `<div class="fs-msg ${r.sent ? 'sent' : ''}"><div class="fs-grow"><b>${esc(r.name)}</b> <small>${esc(r.phone)}${r.last_buy ? ' · última compra ' + dmy(r.last_buy) : ''}</small></div><div class="fs-actions">${r.sent ? '<span class="fs-ok">Enviado ✓</span>' : `<button type="button" class="nv-button fp-whats fs-small" data-fs-offer="${r.id}">Enviar</button>`}<button type="button" class="nv-button secondary fs-small" data-fs-optout="${r.id}" title="Cliente pediu para não receber ofertas">Não quer ofertas</button></div></div>`).join('') || '<p class="nv-help">Nenhum cliente nesse filtro.</p>'}</div>`;
    const send = async id => { const r = rows.find(x => x.id === id); try { await sendWhats(r.phone, offerMessage(r, offerText), { customer_id: r.id, kind: 'offer', campaign: key }); drawOfferList(alive); } catch (err) { feedback(err.message, true); } };
    out.querySelectorAll('[data-fs-offer]').forEach(b => b.onclick = () => send(b.dataset.fsOffer));
    out.querySelectorAll('[data-fs-optout]').forEach(b => b.onclick = async () => { try { await api(`/store/sales/customers/${b.dataset.fsOptout}/offers`, 'PATCH', { opt_out: true }); feedback('Cliente não receberá mais ofertas.'); drawOfferList(alive); } catch (err) { feedback(err.message, true); } });
    if ($('fsOfferNext')) $('fsOfferNext').onclick = () => { const next = rows.find(r => !r.sent); if (next) send(next.id); };
  }

  async function configTab(tab, alive) {
    const loyalty = await api('/store/loyalty'); if (!alive()) return;
    const owner = config.role === 'owner', dis = owner ? '' : 'disabled';
    tab.innerHTML = `<form id="fsCfg">${owner ? '' : '<p class="nv-help fs-warn">Somente o responsável pela loja pode alterar estas configurações.</p>'}
      <section class="nv-form-panel"><h3>Avaliação no Google</h3><label class="nv-field">Link para avaliar a loja<input name="google_review_url" ${dis} placeholder="https://g.page/r/…/review" value="${esc(config.google_review_url || '')}"></label><small class="nv-help">No Google Perfil da Empresa: "Pedir avaliações" → copiar link.</small></section>
      <section class="nv-form-panel"><h3>Cartão fidelidade</h3><label class="fs-check"><input type="checkbox" name="loyalty_enabled" ${dis} ${loyalty.loyalty_enabled ? 'checked' : ''}> Cartão fidelidade ligado</label>
        <div class="fs-row"><label class="nv-field">Compras para ganhar<input type="number" min="2" max="100" name="loyalty_target" ${dis} value="${loyalty.loyalty_target}"></label><label class="nv-field fs-grow">Prêmio<input name="loyalty_reward" maxlength="240" ${dis} value="${esc(loyalty.loyalty_reward)}"></label></div>
        <div class="fs-row"><label class="nv-field">Valor mínimo da venda para contar<input name="min" inputmode="decimal" ${dis} value="${config.loyalty_min_sale_cents ? (config.loyalty_min_sale_cents / 100).toFixed(2).replace('.', ',') : ''}" placeholder="0,00"></label><label class="nv-field fs-grow">Regras de uso (vão na mensagem)<input name="loyalty_rules" maxlength="600" ${dis} value="${esc(config.loyalty_rules || '')}" placeholder="Ex.: Válido por 90 dias. Não cumulativo com outras promoções."></label></div>
        <small class="nv-help">Vendas do caixa e pedidos de serviço finalizados contam no mesmo cartão.</small></section>
      <section class="nv-form-panel"><h3>Mensagem de status</h3><label class="nv-field">Texto<textarea name="status_message" rows="6" maxlength="1000" ${dis}>${esc(config.status_message || DEFAULT_STATUS)}</textarea></label>
        <small class="nv-help">Use {cliente}, {loja}, {fidelidade} (progresso e regras do cartão), {avaliacao} (link do Google; a linha some se não houver link), {compras}, {meta}, {faltam}, {premio}, {regras}.</small>
        <h4>Prévia</h4><pre class="fs-pre" id="fsPreview"></pre></section>
      ${owner ? '<button class="nv-button">Salvar</button>' : ''}<p role="status" class="nv-help" id="fsCfgStatus"></p></form>`;
    const f = $('fsCfg');
    const preview = () => { const saved = { ...config }; config.status_message = f.elements.status_message.value; config.google_review_url = f.elements.google_review_url.value.trim(); config.loyalty_rules = f.elements.loyalty_rules.value.trim();
      const target = Number(f.elements.loyalty_target.value) || 10; $('fsPreview').textContent = statusMessage({ name: 'Maria Silva', loyalty: { enabled: f.elements.loyalty_enabled.checked, checkins: Math.min(3, target - 1), target, remaining: target - Math.min(3, target - 1), reward: f.elements.loyalty_reward.value, complete: false } }); Object.assign(config, saved); };
    f.oninput = preview; preview();
    f.onsubmit = async e => {
      e.preventDefault(); const st = $('fsCfgStatus');
      const min = f.elements.min.value.trim() ? parseMoney(f.elements.min.value) : 0;
      if (!Number.isFinite(min) || min < 0) { st.textContent = 'Valor mínimo inválido.'; return; }
      try {
        await api('/store/loyalty', 'PATCH', { loyalty_enabled: f.elements.loyalty_enabled.checked, loyalty_target: Number(f.elements.loyalty_target.value), loyalty_reward: f.elements.loyalty_reward.value.trim() });
        const status = f.elements.status_message.value.trim();
        const r = await api('/store/sales/config', 'PATCH', { google_review_url: f.elements.google_review_url.value.trim(), loyalty_rules: f.elements.loyalty_rules.value.trim(), loyalty_min_sale_cents: min, status_message: status === DEFAULT_STATUS ? '' : status });
        Object.assign(config, r, { loyalty_enabled: f.elements.loyalty_enabled.checked }); st.textContent = 'Salvo.';
      } catch (err) { st.textContent = err.message.includes('inválidos') ? 'Confira o link (precisa começar com https://) e o prêmio (mínimo 3 letras).' : err.message; }
    };
  }

  // ---------------- Integração com o painel ----------------
  const css = `.fs-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:16px}@media(max-width:900px){.fs-grid{grid-template-columns:1fr}}
  .fs-cashbar{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:16px}.fs-kpis{display:flex;gap:24px;flex-wrap:wrap;margin-top:6px}.fs-kpis div{display:flex;flex-direction:column}.fs-kpis small{color:var(--nv-muted)}.fs-kpis b{font-size:22px}
  .fs-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.fs-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}.fs-row>*{min-width:0}.fs-grow{flex:1 1 180px}.fs-small{padding:6px 10px!important;font-size:13px!important;min-height:0!important}.fs-small-row{margin-top:6px}.fs-wide{width:100%;margin-top:8px}
  .fs-methods{border:0;padding:0;margin:8px 0;display:flex;gap:6px;flex-wrap:wrap}.fs-methods legend{font-size:13px;color:var(--nv-text);margin-bottom:6px}.fs-methods label{cursor:pointer}.fs-methods input{position:absolute;opacity:0;pointer-events:none}.fs-methods span{display:inline-block;padding:8px 14px;border:1px solid var(--nv-border);border-radius:999px;background:var(--nv-surface)}.fs-methods input:checked+span{background:var(--nv-blue);border-color:var(--nv-blue);color:#fff}.fs-methods input:focus-visible+span{outline:2px solid var(--nv-blue);outline-offset:2px}
  .fs-results{display:flex;flex-direction:column;gap:4px;margin-top:4px}.fs-results button{text-align:left;border:1px solid var(--nv-border);border-radius:10px;background:var(--nv-surface);padding:8px 10px;cursor:pointer}.fs-results button:hover{border-color:var(--nv-blue)}
  .fs-picked,.fs-last{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;border:1px solid var(--nv-border);border-radius:12px;padding:10px 12px;background:var(--nv-blue-soft)}.fs-last{margin-top:14px}
  .fs-loyal{display:flex;align-items:center;gap:8px;margin-top:4px}.fs-bar{width:110px;height:6px;border-radius:9px;background:var(--nv-border);overflow:hidden}.fs-bar span{display:block;height:100%;background:var(--nv-green)}.fs-loyal small{color:var(--nv-muted)}
  .fs-sale,.fs-msg{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--nv-border)}.fs-sale small,.fs-msg small{color:var(--nv-muted)}.fs-sale.canceled{opacity:.55}.fs-sale.canceled b{text-decoration:line-through}.fs-sale-end{display:flex;gap:8px;align-items:center}.fs-msg.sent{opacity:.7}
  .fs-pill{display:inline-block;margin:0 6px 6px 0;padding:6px 10px;border-radius:999px;background:var(--nv-blue-soft);font-size:13px}.fs-methods-sum{margin-bottom:6px}
  .fs-tabs{display:flex;gap:4px;border-bottom:1px solid var(--nv-border);margin-bottom:14px;overflow-x:auto}.fs-tabs button{border:0;background:none;padding:10px 14px;cursor:pointer;border-bottom:2px solid transparent;color:var(--nv-muted);white-space:nowrap}.fs-tabs button[aria-selected=true]{border-bottom-color:var(--nv-blue);color:var(--nv-ink);font-weight:700}
  .fs-daybar{margin-bottom:10px}.fs-pre{white-space:pre-wrap;font:inherit;font-size:13px;background:var(--nv-bg);border-radius:10px;padding:10px;margin:6px 0}.fs-ok{color:var(--nv-green);font-weight:700;font-size:13px}.fs-warn{background:#fff6e5;border-radius:8px;padding:8px 10px;color:#7a4b00}
  .fs-neg{color:#b42318}.fs-pos{color:#027a48}.fs-check{display:flex;gap:8px;align-items:center;margin-bottom:8px}.fs-table{overflow:auto}.fs-table table{width:100%;border-collapse:collapse;font-size:14px}.fs-table th,.fs-table td{text-align:left;padding:8px;border-bottom:1px solid var(--nv-border);vertical-align:top}
  .fs-open{max-width:640px}.fs-change{align-items:center;margin-bottom:4px}.fs-change-out{font-size:20px;padding-top:18px}`;

  function injectNav() {
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    const orders = document.querySelector('.nv-menu [data-view="orders"]');
    if (orders) orders.insertAdjacentHTML('afterend', '<button data-view="cash">$ &nbsp;Caixa</button><button data-view="messages">✉ &nbsp;Mensagens</button>');
    const phone = document.querySelector('.nv-phone-nav');
    if (phone) { phone.querySelector('[data-view="cameras"]')?.remove(); phone.querySelector('[data-view="home"]')?.insertAdjacentHTML('afterend', '<button data-view="cash">$<div>Caixa</div></button>'); }
  }

  window.FPSales = {
    enabled: () => !!config?.enabled,
    titles: { cash: 'Caixa', messages: 'Mensagens' },
    moreItems: () => config?.enabled ? [['messages', 'Mensagens'], ['cameras', 'Câmeras']] : [],
    async load(view, box, alive) {
      if (!config?.enabled) { box.innerHTML = '<section class="nv-card">Recurso não habilitado para esta loja.</section>'; return; }
      if (view === 'cash') return loadCash(box, alive);
      return loadMessages(box, alive);
    }
  };
  if (token) api('/store/sales/config').then(c => { config = c; if (c.enabled) injectNav(); }).catch(() => {});
})();
