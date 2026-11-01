// Caixa, vendas ligadas a clientes, fidelidade e mensagens do dia (WhatsApp por clique).
// Só aparece quando a central liga "Caixa e mensagens" para a loja.
(() => {
  const token = sessionStorage.getItem('nv_token');
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const hhmm = d => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dmy = d => new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  // Primeiro nome para mensagens: "lucas cardeal" → "Lucas", "*Elias*" → "Elias", ".IRMA ADRIANA" → "Irma".
  // Nome que é só telefone ou "Contato 1234" (importados sem nome) não vira saudação.
  const greetName = name => {
    const raw = String(name || '').trim();
    if (!raw || /^contato\s+\d+$/i.test(raw)) return '';
    for (const word of raw.split(/\s+/)) {
      const m = word.match(/\p{L}[\p{L}\p{M}'’-]*/u);
      if (m) { if (m[0].length <= 3 && m[0] === m[0].toLocaleUpperCase('pt-BR')) return m[0]; const t = m[0].toLocaleLowerCase('pt-BR'); return t.charAt(0).toLocaleUpperCase('pt-BR') + t.slice(1); }
    }
    return '';
  };
  const METHODS = { cash: 'Dinheiro', pix: 'Pix', debit: 'Débito', credit: 'Crédito', other: 'Outro' };
  const MOVE_LABEL = { expense: 'Saída', withdrawal: 'Sangria', deposit: 'Suprimento' };
  const CATEGORIES = ['Fornecedor / peças', 'Mercadoria para revenda', 'Aluguel', 'Energia / água / internet', 'Salário / diária', 'Transporte / entrega', 'Alimentação', 'Impostos / taxas', 'Manutenção da loja', 'Retirada do dono', 'Outros'];
  const DEFAULT_STATUS = 'Olá, {cliente}! Obrigado pela preferência na {loja}!\n\n{fidelidade}\n\n{cashback}\n\nSua opinião ajuda muito: pode nos avaliar no Google? Leva 1 minutinho: {avaliacao}';
  const DEFAULT_CB_REMINDER = 'Olá, {cliente}! Você tem {valor} de cashback na {loja} que vence {quando}. Aproveite para usar na sua próxima compra!\n\n{regras}';
  let config = null, saleCustomer = null, lastSale = null, quickItems = null, quickCart = [];
  const basic = () => config?.access_level === 'basic';
  let cart = []; // [{ id, name, barcode, price_cents, quantity }] — produtos lidos pelo leitor na venda em montagem

  async function api(path, method = 'GET', body) {
    const r = await fetch('/api' + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(Error(data.error || 'Não foi possível concluir a operação'), { status: r.status });
    return data;
  }
  // 558532130953 -> (85) 3213-0953; 5585999998888 -> (85) 99999-8888
  const phoneBR = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length >= 12 && d.startsWith('55')) d = d.slice(2); return d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : String(p || ''); };
  const centsText = c => (Number(c || 0) / 100).toFixed(2).replace('.', ',');
  const looksLikeCode = v => /^[!-~]{3,64}$/.test(v) && /\d/.test(v);
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
    if (l.complete) return `Você completou o cartão fidelidade e já pode resgatar: ${l.reward}. É só pedir aqui na loja.` + rules;
    return `Cartão fidelidade: ${l.checkins} de ${l.target} compras. ${l.remaining === 1 ? 'Falta 1 compra' : 'Faltam ' + l.remaining + ' compras'} para ganhar: ${l.reward}.` + rules;
  }
  // ---------------- Cashback ----------------
  const ymdShort = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) : '';
  const cbOn = () => !!config?.cashback_enabled;
  const daysText = d => d % 30 === 0 ? (d === 30 ? '1 mês' : d / 30 + ' meses') : d + ' dias';
  const pctText = p => Number(p).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%';
  // Mesmo cálculo do servidor: limite por compra, saldo disponível e pelo menos R$ 0,01 a pagar.
  const cbAllowed = (total, balance) => Math.max(0, Math.min(balance || 0, Math.floor(total * (config?.cashback_max_use_percent || 0) / 100), total - 1));
  function cashbackRules() {
    if (!cbOn()) return '';
    const min = config.cashback_min_sale_cents ? ` Vale para compras a partir de ${brl(config.cashback_min_sale_cents)}.` : '';
    return `Como funciona: ${pctText(config.cashback_percent)} do valor de cada compra volta para você em cashback, válido por ${daysText(config.cashback_valid_days)}. Ele pode pagar até ${config.cashback_max_use_percent}% de uma nova compra.${min}` + (config.cashback_rules ? ' ' + config.cashback_rules : '');
  }
  // Texto do cashback na mensagem do dia: quanto ganhou hoje, saldo em reais e até quando vale.
  function cashbackText(cb) {
    if (!cbOn() || !cb) return '';
    const earned = cb.earned_cents || 0, bal = cb.balance_cents || 0, lines = [];
    if (earned > 0) lines.push(`Você ganhou ${brl(earned)} de cashback nesta compra.`);
    if (bal > 0) {
      const when = cb.next_expires_on ? (cb.next_expiring_cents < bal ? ` (${brl(cb.next_expiring_cents)} vence em ${ymdShort(cb.next_expires_on)})` : `, válido até ${ymdShort(cb.next_expires_on)}`) : '';
      lines.push(`Seu saldo de cashback é ${brl(bal)} para usar em compras aqui na loja${when}.`);
    }
    if (!lines.length) return '';
    return lines.join(' ') + '\n' + cashbackRules();
  }
  const cbBadge = cb => cbOn() && cb?.balance_cents > 0 ? `<span class="fs-cb-badge" title="Saldo de cashback">${FPIcon('wallet')}${brl(cb.balance_cents)}</span>` : '';
  const cbWhen = r => r.days_left <= 0 ? 'hoje' : r.days_left === 1 ? 'amanhã' : `em ${r.days_left} dias (${ymdShort(r.expires_on)})`;
  const reminderMessage = r => render(config.cashback_reminder_message || DEFAULT_CB_REMINDER, {
    cliente: greetName(r.name) || 'tudo bem', loja: config.name || 'loja', valor: brl(r.expiring_cents), saldo: brl(r.balance_cents),
    quando: cbWhen(r), vence: ymdShort(r.expires_on), dias: r.days_left, regras: cashbackRules()
  });

  function render(template, values) {
    let lines = template.split('\n');
    if (!values.avaliacao) lines = lines.filter(line => !line.includes('{avaliacao}'));
    return lines.join('\n').replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m)).replace(/\n{3,}/g, '\n\n').trim();
  }
  const statusTemplate = () => { const t = config.status_message || DEFAULT_STATUS; return t.includes('{cashback}') ? t : t.includes('{fidelidade}') ? t.replace('{fidelidade}', '{fidelidade}\n\n{cashback}') : t + '\n\n{cashback}'; };
  const statusMessage = c => render(statusTemplate(), {
    cliente: greetName(c.name) || 'tudo bem', loja: config.name || 'loja', fidelidade: loyaltyText(c.loyalty), avaliacao: config.google_review_url || '', cashback: cashbackText(c.cashback),
    compras: c.loyalty?.checkins ?? '', meta: c.loyalty?.target ?? '', faltam: c.loyalty?.remaining ?? '', premio: c.loyalty?.reward ?? '', regras: config.loyalty_rules || ''
  });
  const offerMessage = (c, text) => `Olá, ${greetName(c.name) || 'tudo bem'}! ${text}\n\n— ${config.name || ''}\nSe não quiser mais receber ofertas, é só responder SAIR.`;

  function progressBar(l) {
    if (!l || !l.enabled) return '';
    const pct = Math.min(100, Math.round(100 * l.checkins / l.target));
    return `<div class="fs-loyal" title="Cartão fidelidade"><div class="fs-bar"><span style="width:${pct}%"></span></div><small>${l.complete ? FPIcon('gift') + ' Prêmio liberado' : `${l.checkins}/${l.target} · faltam ${l.remaining}`}</small></div>`;
  }
  function feedback(text, error = false) {
    const n = $('panelFeedback'); if (!n) return; n.textContent = text; n.classList.toggle('error', error); n.hidden = !text;
  }
  function openDialog(html) { const d = $('editorDialog'); d.innerHTML = html; if (!d.open) d.showModal(); return d; }
  const header = t => `<div class="nv-heading"><h2 id="dialogTitle">${t}</h2><button type="button" class="nv-button secondary" data-close-dialog aria-label="Fechar">${FPIcon('x')}</button></div>`;

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
    const saleRow = x => { const svc = (x.items || []).find(i => i.service);
      return `<div class="fs-sale ${x.canceled_at ? 'canceled' : ''}"><div><b>#${x.sale_number}</b> · ${hhmm(x.created_at)} · ${esc(x.customer_name || 'Sem cliente')}${svc ? ' <span class="fs-tag-svc">' + FPIcon('wrench') + 'Serviço</span>' : ''}${x.seller_name ? ` · <span class="fs-seller-tag">${esc(x.seller_name)}</span>` : ''}${x.order_number ? ` · pedido ${esc(x.order_number)}` : ''}<br><small>${METHODS[x.payment_method]}${x.cashback_used_cents ? ` · <span class="fs-cb-note">cashback −${brl(x.cashback_used_cents)}</span>` : ''}${x.description ? ' · ' + esc(x.description) : ''}${x.canceled_at ? ` · <span class="fs-neg">cancelada por ${esc(x.canceled_by_name || '—')} às ${hhmm(x.canceled_at)}: ${esc(x.cancel_reason)}</span>` : ''}</small></div><div class="fs-sale-end"><b>${brl(x.total_cents)}</b><button type="button" class="nv-button secondary fs-small" data-fs-receipt="${x.id}" title="Imprimir comprovante" aria-label="Imprimir comprovante da venda ${x.sale_number}">${FPIcon('receipt')}</button>${x.canceled_at ? '' : `<button class="nv-button secondary fs-small" data-fs-cancel="${x.id}">Cancelar</button>`}</div></div>`; };
    box.innerHTML = `
      <section class="nv-card fs-cashbar"><div class="fs-cashbar-info"><div class="nv-card-label">Caixa aberto às ${hhmm(s.opened_at)} por ${esc(s.opened_by_name)}</div>
        <div class="fs-kpis"><div><small>Entradas (${sum.sales_count} vendas)</small><b class="fs-pos">${brl(sum.sales_total_cents)}</b></div><div><small>Saídas</small><b class="fs-neg">${brl(sum.expenses_total_cents)}</b></div><div><small>Saldo do dia</small><b>${brl(sum.balance_cents)}</b></div><div><small>Dinheiro na gaveta</small><b>${brl(sum.expected_cash_cents)}</b></div></div></div>
        <div class="fs-cashbar-side"><label class="fs-seller" hidden>Vendedor<select id="fsSeller" aria-label="Vendedor da venda"><option value="">…</option></select></label>
        <div class="fs-actions"><button type="button" class="nv-button secondary" id="fsEye"></button><button class="nv-button secondary" id="fsProducts">${FPIcon('package')}Estoque</button><button class="nv-button secondary" id="fsExpense">− Lançar saída</button><button class="nv-button secondary" id="fsWithdraw">Sangria</button><button class="nv-button secondary" id="fsDeposit">Suprimento</button><button class="nv-button secondary" id="fsPrint">${FPIcon('printer')}Relatório</button><button class="nv-button" id="fsClose">Fechar caixa</button></div></div></section>
      <div class="fs-grid">
        <div class="fs-col-report">
          <section class="nv-card"><div class="nv-heading"><h2>Vendas deste caixa</h2></div><div class="fs-methods-sum">${methods}</div>
            <div class="nv-list">${data.sales.map(saleRow).join('') || '<p class="nv-help">As vendas registradas aparecem aqui.</p>'}</div>
            <p class="nv-help fs-opening">Troco inicial: ${brl(sum.opening_cents)}</p></section>
          <section class="nv-card fs-moves"><div class="nv-heading"><h2>Saídas, sangrias e suprimentos</h2><button class="nv-button secondary fs-small" id="fsExpense2">− Lançar saída</button></div>
            ${Object.keys(sum.expenses_by_method).length ? `<div class="fs-methods-sum">${Object.entries(sum.expenses_by_method).map(([k, v]) => `<span class="fs-pill fs-pill-out">${METHODS[k]} <b>${brl(v.total_cents)}</b> <small>(${v.count})</small></span>`).join('')}</div>` : ''}
            <div class="nv-list">${data.movements.map(m => `<div class="fs-sale ${m.canceled_at ? 'canceled' : ''}"><div><b>${MOVE_LABEL[m.kind]}</b> · ${hhmm(m.created_at)}${m.category ? ' · ' + esc(m.category) : ''}${m.note ? ' · ' + esc(m.note) : ''}<br><small>${METHODS[m.method] || 'Dinheiro'} · lançado por ${esc(m.created_by_name)}${m.canceled_at ? ` · <span class="fs-neg">cancelado por ${esc(m.canceled_by_name || '—')} às ${hhmm(m.canceled_at)}: ${esc(m.cancel_reason)}</span>` : ''}</small></div><div class="fs-sale-end"><b class="${m.kind === 'deposit' ? 'fs-pos' : 'fs-neg'}">${m.kind === 'deposit' ? '+' : '−'}${brl(m.amount_cents)}</b>${m.canceled_at ? '' : `<button class="nv-button secondary fs-small" data-fs-move-cancel="${m.id}">Cancelar</button>`}</div></div>`).join('') || '<p class="nv-help">Pagamentos de fornecedor, contas, retiradas e outras saídas do dia aparecem aqui.</p>'}</div></section>
        </div>
        <section class="nv-card fs-newsale"><h2>Nova venda</h2>
          <div class="fs-mode" role="group" aria-label="O que está sendo vendido"><button type="button" data-fs-mode="product">${FPIcon('cart')}Produto</button><button type="button" data-fs-mode="service">${FPIcon('wrench')}Serviço</button></div>
          <form id="fsSale" autocomplete="off">
          <div class="fs-scan" data-only="product"><label class="nv-field">Produtos <small class="nv-help">bipe o código com o leitor (não precisa clicar aqui) ou busque pelo nome</small>
            <input id="fsScan" placeholder="Código de barras ou nome do produto" aria-label="Código de barras ou nome do produto" enterkeyhint="go"></label>
            <div id="fsScanResults" class="fs-results"></div><div id="fsCart" aria-live="polite"></div></div>
          <div id="fsSvc" data-only="service"></div>
          <div class="nv-field">Cliente<div id="fsCustomerBox"></div></div>
          <div id="fsOrderBox"></div>
          <div id="fsCbBox" aria-live="polite"></div>
          <div class="fs-quick" id="fsQuick" data-only="product"></div>
          <div class="fs-row" data-only="product"><label class="nv-field"><span id="fsTotalLabel">Valor</span><input name="total" inputmode="decimal" placeholder="0,00"></label>
          <label class="nv-field fs-grow">Descrição (opcional)<input name="description" maxlength="300" placeholder="Ex.: película, carregador, capinha"></label></div>
          <fieldset class="fs-methods"><legend>Pagamento</legend>${Object.entries(METHODS).map(([k, v], i) => `<label><input type="radio" name="method" value="${k}" ${i === 1 ? 'checked' : ''}><span>${v}</span></label>`).join('')}</fieldset>
          <div id="fsChangeBox" class="fs-row fs-change" hidden><label class="nv-field">Valor recebido<input name="received" inputmode="decimal" placeholder="0,00"></label><div class="fs-change-out" id="fsChangeOut" aria-live="polite"></div></div>
          <label class="fs-check fs-autoprint"><input type="checkbox" id="fsAutoPrint"> Imprimir comprovante ao registrar</label>
          <button class="nv-button fs-wide" id="fsSaleBtn">Registrar venda</button><p role="status" id="fsSaleStatus" class="nv-help"></p></form>
          <div id="fsLast"></div></section>
      </div>`;
    saleCustomer = null; drawCustomerPicker(); if (lastSale) drawLast(); loadSellers();
    const sf = $('fsSale');
    const updChange = () => {
      const cash = sf.elements.method.value === 'cash'; $('fsChangeBox').hidden = !cash;
      drawCashbackBox();
      const out = $('fsChangeOut'), total = payable(), got = parseMoney(sf.elements.received.value);
      if (!cash || !Number.isFinite(got)) { out.textContent = ''; return; }
      if (!Number.isFinite(total) || total <= 0) { out.textContent = 'Informe o valor da venda.'; return; }
      const d = got - total;
      out.innerHTML = d >= 0 ? `Troco: <b>${brl(d)}</b>` : `<span class="fs-neg">Faltam ${brl(-d)}</span>`;
    };
    sf.addEventListener('input', updChange); sf.addEventListener('change', updChange);
    setupScanInput(); drawCart(); drawService(); setMode(saleMode); updChange(); setupEye(box);
    box.querySelectorAll('[data-fs-mode]').forEach(b => b.onclick = () => setMode(b.dataset.fsMode, true));
    $('fsProducts').onclick = () => productsDialog();
    $('fsSale').onsubmit = e => submitSale(e, box, alive);
    const ap = $('fsAutoPrint'); ap.checked = autoPrint(); ap.onchange = () => { try { localStorage.setItem(RECEIPT_AUTO_KEY, ap.checked ? '1' : '0'); } catch { /* só nesta tela */ } };
    quickCart = []; lastAuto = ''; drawQuick();
    $('fsWithdraw').onclick = () => movement('withdrawal', box, alive);
    $('fsExpense').onclick = $('fsExpense2').onclick = () => movement('expense', box, alive);
    $('fsPrint').onclick = () => printReport(s.id);
    box.querySelectorAll('[data-fs-move-cancel]').forEach(b => b.onclick = async () => {
      const reason = prompt('Motivo do cancelamento do lançamento (ex.: valor errado):'); if (!reason || reason.trim().length < 3) return;
      try { await api(`/store/cash/movements/${b.dataset.fsMoveCancel}/cancel`, 'POST', { reason: reason.trim() }); feedback('Lançamento cancelado.'); loadCash(box, alive); }
      catch (err) { feedback(err.message, true); }
    });
    $('fsDeposit').onclick = () => movement('deposit', box, alive);
    $('fsClose').onclick = () => closeCash(sum, box, alive);
    box.querySelectorAll('[data-fs-receipt]').forEach(b => b.onclick = () => printReceipt(b.dataset.fsReceipt));
    box.querySelectorAll('[data-fs-cancel]').forEach(b => b.onclick = async () => {
      const reason = prompt('Motivo do cancelamento (ex.: lançada em dobro):'); if (!reason || reason.trim().length < 3) return;
      try { const r = await api(`/store/sales/${b.dataset.fsCancel}/cancel`, 'POST', { reason: reason.trim() }); feedback('Venda cancelada.' + (r.loyalty_already_redeemed ? ' A compra já tinha sido usada num prêmio e continua no histórico do cartão.' : '')
        + (r.cashback_returned_cents ? ` Voltaram ${brl(r.cashback_returned_cents)} de cashback para o cliente.` : '') + (r.cashback_removed_cents ? ` Saiu o cashback de ${brl(r.cashback_removed_cents)} que a venda gerou${r.cashback_already_spent_cents ? ` (${brl(r.cashback_already_spent_cents)} já tinham sido usados pelo cliente)` : ''}.` : '')); loadCash(box, alive); }
      catch (err) { feedback(err.message, true); }
    });
  }

  function drawClosed(box, data, alive) {
    const l = data.last_closed;
    const diff = l && l.counted_cash_cents != null ? l.counted_cash_cents - l.expected_cash_cents : null;
    box.innerHTML = `<section class="nv-card fs-open"><h2>Caixa fechado</h2><p class="nv-help">Abra o caixa para registrar as vendas do dia. Cada venda fica ligada a um cliente e soma no cartão fidelidade.</p>
      <form id="fsOpen" class="fs-row"><label class="nv-field">Troco inicial na gaveta<input name="opening" inputmode="decimal" placeholder="0,00"></label><button class="nv-button">Abrir caixa</button></form><p role="status" class="nv-help" id="fsOpenStatus"></p>
      ${l ? `<p class="nv-help fs-lastclose">Último fechamento: ${dmy(l.closed_at)} às ${hhmm(l.closed_at)}${l.closed_by_name ? ' por ' + esc(l.closed_by_name) : ''} · esperado ${brl(l.expected_cash_cents)} · contado ${brl(l.counted_cash_cents)}${diff ? ` · <b class="${diff < 0 ? 'fs-neg' : 'fs-pos'}">diferença ${brl(diff)}</b>` : ' · sem diferença'}</p>` : ''}
      <div class="fs-actions">${l ? '<button class="nv-button secondary" id="fsPrintLast">' + FPIcon('printer') + 'Relatório do último caixa</button>' : ''}<button class="nv-button secondary" id="fsHistory">Histórico de caixas</button><button type="button" class="nv-button secondary" id="fsEye"></button><button class="nv-button secondary" id="fsProducts">${FPIcon('package')}Produtos</button></div></section>`;
    $('fsProducts').onclick = () => productsDialog(); setupEye(box);
    $('fsOpen').onsubmit = async e => {
      e.preventDefault(); const raw = e.currentTarget.elements.opening.value; const v = raw.trim() ? parseMoney(raw) : 0;
      if (!Number.isFinite(v) || v < 0) { $('fsOpenStatus').textContent = 'Valor inválido.'; return; }
      try { await api('/store/cash/open', 'POST', { opening_cents: v }); feedback('Caixa aberto.'); loadCash(box, alive); } catch (err) { $('fsOpenStatus').textContent = err.message; }
    };
    $('fsHistory').onclick = history;
    if ($('fsPrintLast')) $('fsPrintLast').onclick = () => printReport(l.id);
  }

  async function history() {
    const rows = await api('/store/cash/sessions');
    openDialog(`${header('Histórico de caixas')}<div class="fs-table"><table><thead><tr><th>Abertura</th><th>Fechamento</th><th>Vendas</th><th>Com cliente</th><th>Entradas</th><th>Saídas</th><th>Gaveta (esperado / contado)</th><th></th></tr></thead><tbody>${rows.map(r => {
      const diff = r.counted_cash_cents != null ? r.counted_cash_cents - r.expected_cash_cents : null;
      return `<tr><td>${dmy(r.opened_at)} ${hhmm(r.opened_at)}<br><small>${esc(r.opened_by_name)}</small></td><td>${r.closed_at ? dmy(r.closed_at) + ' ' + hhmm(r.closed_at) : '<b>aberto</b>'}</td><td>${r.sales_count}</td><td>${r.sales_count ? Math.round(100 * r.linked_count / r.sales_count) + '%' : '—'}</td><td>${brl(r.sales_total_cents)}</td><td>${brl(r.expenses_total_cents)}</td><td>${r.closed_at ? `${brl(r.expected_cash_cents)} / ${brl(r.counted_cash_cents)}${diff ? ` <b class="${diff < 0 ? 'fs-neg' : 'fs-pos'}">(${brl(diff)})</b>` : ''}` : '—'}${r.close_note ? `<br><small>${esc(r.close_note)}</small>` : ''}</td><td><button type="button" class="nv-button secondary fs-small" data-fs-print="${r.id}" aria-label="Imprimir relatório">${FPIcon('printer')}</button></td></tr>`;
    }).join('') || '<tr><td colspan="8">Nenhum caixa ainda.</td></tr>'}</tbody></table></div>`);
    document.querySelectorAll('[data-fs-print]').forEach(b => b.onclick = () => printReport(b.dataset.fsPrint));
  }

  function drawCustomerPicker() {
    const box = $('fsCustomerBox'); if (!box) return;
    if (saleCustomer?.id || saleCustomer?.anonymous) {
      const c = saleCustomer;
      box.innerHTML = `<div class="fs-picked"><div><b>${c.anonymous ? 'Venda sem cliente' : esc(c.name)}</b>${c.phone ? ' · ' + esc(c.phone) : ''} ${cbBadge(c.cashback)}${progressBar(c.loyalty)}</div><button type="button" class="nv-button secondary fs-small" id="fsChange">Trocar</button></div>`;
      $('fsChange').onclick = () => { saleCustomer = null; cbWanted = false; drawCustomerPicker(); $('fsOrderBox').innerHTML = ''; $('fsSale')?.dispatchEvent(new Event('input')); };
      drawCashbackBox(); return;
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
        out.innerHTML = rows.map(r => `<button type="button" data-fs-pick="${r.id}"><b>${esc(r.name)}</b> <small>${esc(r.phone || 'sem telefone')}</small> ${cbBadge(r.cashback)}${progressBar(r.loyalty)}</button>`).join('') || '<p class="nv-help">Nenhum cliente encontrado. Use "+ Cliente novo".</p>';
        out.querySelectorAll('[data-fs-pick]').forEach(b => b.onclick = () => pick(b.dataset.fsPick));
      } catch (err) { out.textContent = err.message; }
    }, 220); };
    $('fsNew').onclick = () => { const term = $('fsSearch').value.trim(); saleCustomer = { isNew: true }; drawCustomerPicker(); if (/\d{4,}/.test(term)) $('fsNewPhone').value = term; else $('fsNewName').value = term; };
    $('fsAnon').onclick = () => { saleCustomer = { anonymous: true }; drawCustomerPicker(); };
  }
  async function pick(id) {
    const c = await api('/store/sales/customers/' + id); saleCustomer = c; cbWanted = false; drawCustomerPicker(); $('fsSale')?.dispatchEvent(new Event('input'));
    const box = $('fsOrderBox');
    box.innerHTML = c.orders.length ? `<label class="nv-field">É pagamento de um pedido de serviço? (opcional)<select id="fsOrder"><option value="">Não, venda avulsa</option>${c.orders.map(o => `<option value="${o.id}">Pedido ${esc(o.order_number || '')} · ${esc(o.details?.model || o.details?.brand || o.process || '')} · ${o.status === 'completed' ? 'finalizado' : 'em andamento'} · ${dmy(o.created_at)}</option>`).join('')}</select><small>Pedido de serviço já conta no cartão quando é finalizado; a venda dele não conta de novo.</small></label>` : '';
  }

  // ---------------- Cashback na venda ----------------
  // Cliente com saldo: o operador pergunta se quer usar. Marcado, abate até o limite por compra
  // e o cliente paga só a diferença. O que sobrar continua acumulado.
  let cbWanted = false;
  const cbBalance = () => cbOn() && saleCustomer?.id ? saleCustomer.cashback?.balance_cents || 0 : 0;
  const cbUse = () => { const t = currentTotal(); return cbWanted && Number.isFinite(t) && t > 0 ? cbAllowed(t, cbBalance()) : 0; };
  const payable = () => { const t = currentTotal(); return Number.isFinite(t) ? t - cbUse() : t; };
  function drawCashbackBox() {
    const box = $('fsCbBox'); if (!box) return;
    const bal = cbBalance(); if (!bal) { box.innerHTML = ''; box.dataset.html = ''; return; }
    const cb = saleCustomer.cashback, t = currentTotal(), can = Number.isFinite(t) && t > 0 ? cbAllowed(t, bal) : 0, use = cbUse();
    const when = cb.next_expires_on ? `${cb.next_expiring_cents < bal ? brl(cb.next_expiring_cents) + ' vence em' : 'Vale até'} ${ymdShort(cb.next_expires_on)}` : '';
    const html = `<div class="fs-cb"><div><b class="fs-cb-title">${FPIcon('wallet')}Cashback disponível: ${brl(bal)}</b><small>${when}</small></div>
      <label class="fs-check"><input type="checkbox" id="fsCbUse" ${cbWanted ? 'checked' : ''} ${can ? '' : 'disabled'}> ${can ? `Usar cashback nesta venda: <b>− ${brl(can)}</b>` : 'Informe o valor da venda para usar o cashback'}</label>
      ${use ? `<div class="fs-cb-pay">A pagar: <b>${brl(t - use)}</b> <small>(${brl(t)} − ${brl(use)} de cashback${bal - use > 0 ? ` · fica ${brl(bal - use)} de saldo` : ''})</small></div>` : can && can < bal ? `<small class="nv-help">Limite: até ${config.cashback_max_use_percent}% do valor da compra.</small>` : ''}</div>`;
    if (box.dataset.html === html) return; // evita redesenhar (e perder o foco) a cada tecla
    box.dataset.html = html; box.innerHTML = html;
    const cbx = $('fsCbUse'); if (cbx) cbx.onchange = () => { cbWanted = cbx.checked; $('fsSale')?.dispatchEvent(new Event('input')); };
  }

  // ---------------- Itens frequentes ----------------
  // Botões acima do valor: cada toque soma o preço no valor e escreve o item na descrição
  // ("2x Película, Capa"). Sem preço cadastrado, só entra na descrição.
  // Cada item tem quantidade e preço editáveis ("10x Xerox" a R$ 0,20 = R$ 2,00). O valor da venda é a
  // soma das linhas e vai ao servidor como itens, para o comprovante listar cada um com o valor cobrado.
  // Um valor já digitado antes do primeiro item vira a linha "Valor avulso".
  let lastAuto = '';
  const toInput = c => c > 0 ? (c / 100).toFixed(2).replace('.', ',') : '';
  const cartText = () => quickCart.map(x => (x.qty > 1 ? x.qty + 'x ' : '') + x.label).join(', ');
  const cartSum = () => quickCart.reduce((t, x) => t + (x.unit ?? 0) * x.qty, 0);
  function applyCart() {
    const f = $('fsSale'); if (!f) return;
    const desc = f.elements.description.value.trim(), text = cartText();
    // Descrição: reescreve enquanto for o texto automático; se o operador escreveu algo, não mexe.
    if (!desc || desc === lastAuto) f.elements.description.value = text;
    lastAuto = text;
    const input = f.elements.total;
    if (quickCart.length) { input.value = toInput(cartSum()); input.readOnly = true; input.dataset.quick = '1'; }
    else if (input.dataset.quick === '1') { input.value = ''; input.readOnly = false; input.dataset.quick = ''; }
    const tot = $('fsCartTotal'); if (tot) tot.textContent = brl(cartSum());
    f.dispatchEvent(new Event('input'));
  }
  async function loadQuick(force) {
    if (quickItems && !force) return quickItems;
    try { quickItems = await api('/store/sales/quick-items'); } catch { quickItems = quickItems || []; }
    return quickItems;
  }
  function cartRow(x) {
    const changed = x.price_cents != null && x.unit != null && x.unit !== x.price_cents;
    return `<div class="fs-cart-row" data-cart-id="${x.id}"><span class="fs-cart-name">${esc(x.label)}<span class="fs-unit-wrap">R$ <input class="fs-unit${x.unit == null ? ' fs-need' : ''}"${basic() && x.price_cents != null ? ' readonly' : ''} inputmode="decimal" value="${x.unit != null ? centsText(x.unit) : ''}" placeholder="preço" aria-label="Preço de cada ${esc(x.label)}"> cada${changed ? ` <s>${brl(x.price_cents)}</s>` : ''}</span></span>
      <span class="fs-qq"><button type="button" data-q="-1" aria-label="Diminuir ${esc(x.label)}">−</button><input class="fs-qn" type="number" inputmode="numeric" min="1" max="9999" value="${x.qty}" aria-label="Quantidade de ${esc(x.label)}"><button type="button" data-q="1" aria-label="Aumentar ${esc(x.label)}">+</button></span>
      <b class="fs-cart-sub">${x.unit != null ? brl(x.unit * x.qty) : '—'}</b><button type="button" class="fs-cart-del" data-del aria-label="Tirar ${esc(x.label)}">${FPIcon('x')}</button></div>`;
  }
  async function drawQuick() {
    const box = $('fsQuick'); if (!box) return;
    const items = await loadQuick(); if (!box.isConnected) return;
    const chips = items.map(i => `<button type="button" class="fs-chip" data-fs-quick="${i.id}"><b>${esc(i.label)}</b>${i.price_cents != null ? `<small>${brl(i.price_cents)}</small>` : ''}</button>`).join('');
    const quickSummary = quickCart.length ? `<div class="fs-cart">${quickCart.map(cartRow).join('')}<div class="fs-cart-foot"><span>Itens: <b id="fsCartTotal">${brl(cartSum())}</b></span><button type="button" class="nv-button secondary fs-small" id="fsQuickClear">Limpar itens</button></div></div>` : '';
    box.innerHTML = `<div class="fs-quick-head"><span>Itens frequentes</span><button type="button" class="fs-link" id="fsQuickManage">${items.length ? FPIcon('edit') + ' Editar' : '+ Cadastrar item frequente'}</button></div>
      ${cart.length ? '<p class="nv-help fs-quick-empty">Com produtos lidos pelo leitor, o valor é a soma dos produtos. Itens frequentes ficam para vendas sem leitor.</p>' : items.length ? `<div class="fs-chips">${chips}</div>` : '<p class="nv-help fs-quick-empty">Cadastre os itens que você mais vende (xerox, película, capa…) para lançar com um toque.</p>'}${quickSummary}`;
    box.querySelectorAll('[data-fs-quick]').forEach(b => b.onclick = () => addQuick(items.find(i => i.id === b.dataset.fsQuick)));
    $('fsQuickManage').onclick = manageQuick;
    box.querySelectorAll('[data-cart-id]').forEach(row => {
      const x = quickCart.find(c => c.id === row.dataset.cartId), input = row.querySelector('.fs-qn'), unit = row.querySelector('.fs-unit');
      const sub = () => { row.querySelector('.fs-cart-sub').textContent = x.unit != null ? brl(x.unit * x.qty) : '—'; };
      const set = qty => { x.qty = Math.max(1, Math.min(9999, Math.round(qty) || 1)); input.value = x.qty; sub(); applyCart(); };
      unit.oninput = () => { const v = parseMoney(unit.value); x.unit = unit.value.trim() && Number.isFinite(v) && v >= 0 ? v : null; unit.classList.toggle('fs-need', x.unit == null); sub(); applyCart(); };
      unit.onblur = () => drawQuick();
      row.querySelectorAll('[data-q]').forEach(b => b.onclick = () => set(x.qty + Number(b.dataset.q)));
      input.oninput = () => { if (input.value !== '') set(Number(input.value)); };
      input.onblur = () => { input.value = x.qty; };
      row.querySelector('[data-del]').onclick = () => { quickCart = quickCart.filter(c => c !== x); applyCart(); drawQuick(); };
    });
    if ($('fsQuickClear')) $('fsQuickClear').onclick = () => { quickCart = []; applyCart(); drawQuick(); };
  }
  function addQuick(item) {
    const f = $('fsSale'); if (!item || !f) return;
    if (cart.length) { feedback('Esta venda tem produtos lidos pelo leitor. Para incluir este item, cadastre-o como produto em "Produtos".', true); return; }
    if (!quickCart.length) { const cur = parseMoney(f.elements.total.value); lastAuto = ''; if (Number.isFinite(cur) && cur > 0 && f.elements.total.dataset.quick !== '1') quickCart.push({ id: 'avulso', label: 'Valor avulso', price_cents: null, unit: cur, qty: 1 }); }
    const hit = quickCart.find(x => x.id === item.id);
    if (hit) hit.qty++; else quickCart.push({ id: item.id, label: item.label, price_cents: item.price_cents, unit: item.price_cents, qty: 1 });
    applyCart();
    // Item novo: já deixa selecionado para digitar a quantidade (ex.: 10 cópias), ou o preço se não tem preço fixo.
    drawQuick().then(() => { if (hit) return; const row = document.querySelector(`[data-cart-id="${item.id}"]`); const i = row && (item.price_cents == null ? row.querySelector('.fs-unit') : row.querySelector('.fs-qn')); if (i) { i.focus(); i.select(); } });
  }
  async function manageQuick() {
    const items = await loadQuick(true);
    const f = $('fsSale'), suggestLabel = f && !quickCart.length ? f.elements.description.value.trim().slice(0, 60) : '';
    const suggestPrice = f && suggestLabel ? f.elements.total.value.trim() : '';
    openDialog(`${header('Itens frequentes')}<p class="nv-help">Aparecem como botões em "Nova venda". Toque no item para somar o preço e preencher a descrição.</p>
      <form id="fsQuickForm" class="fs-row" autocomplete="off"><label class="nv-field fs-grow">Item<input name="label" maxlength="60" required placeholder="Ex.: Película 3D" value="${esc(suggestLabel)}"></label>
      <label class="nv-field">Preço (opcional)<input name="price" inputmode="decimal" placeholder="0,00" value="${esc(suggestPrice)}"></label><button class="nv-button">Cadastrar</button></form><p role="status" class="nv-help" id="fsQuickStatus"></p>
      <div class="nv-list">${items.map(i => `<div class="fs-sale"><div><b>${esc(i.label)}</b><br><small>${i.price_cents != null ? brl(i.price_cents) : 'sem preço fixo'}</small></div><div class="fs-sale-end"><button type="button" class="nv-button secondary fs-small" data-fs-quick-del="${i.id}">Excluir</button></div></div>`).join('') || '<p class="nv-help">Nenhum item cadastrado ainda.</p>'}</div>`);
    $('fsQuickForm').onsubmit = async e => {
      e.preventDefault(); const form = e.currentTarget, st = $('fsQuickStatus');
      const label = form.elements.label.value.trim(), raw = form.elements.price.value.trim();
      const price = raw ? parseMoney(raw) : null;
      if (!label) { st.textContent = 'Informe o nome do item.'; return; }
      if (raw && (!Number.isFinite(price) || price < 0)) { st.textContent = 'Preço inválido.'; return; }
      try { await api('/store/sales/quick-items', 'POST', { label, price_cents: price }); await manageQuick(); drawQuick(); $('fsQuickStatus').textContent = `"${label}" cadastrado.`; }
      catch (err) { st.textContent = err.message; }
    };
    document.querySelectorAll('[data-fs-quick-del]').forEach(b => b.onclick = async () => {
      const item = items.find(i => i.id === b.dataset.fsQuickDel); if (!confirm(`Excluir "${item?.label}" dos itens frequentes?`)) return;
      try { await api('/store/sales/quick-items/' + b.dataset.fsQuickDel, 'DELETE'); quickCart = quickCart.filter(x => x.id !== b.dataset.fsQuickDel); applyCart(); await manageQuick(); drawQuick(); }
      catch (err) { $('fsQuickStatus').textContent = err.message; }
    });
  }

  // ---------------- Vendedor ----------------
  // Logins ativos da loja (cadastrados na central). Fica selecionado quem fez a última venda.
  let lastSellerId = null;
  async function loadSellers() {
    const sel = $('fsSeller'); if (!sel) return;
    let d; try { d = await api('/store/sales/sellers'); } catch { sel.innerHTML = '<option value="">—</option>'; return; }
    if (!sel.isConnected) return;
    const pick = [lastSellerId, d.last_seller_id, d.me].find(id => id && d.sellers.some(x => x.id === id)) || '';
    sel.innerHTML = d.sellers.map(x => `<option value="${x.id}"${x.id === pick ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    sel.closest('.fs-seller').hidden = d.sellers.length < 2; // loja com um login só: não precisa escolher (fica no canto do topo do caixa)
    sel.onchange = () => { lastSellerId = sel.value; };
  }

  async function submitSale(e, box, alive) {
    e.preventDefault(); const f = e.currentTarget, status = $('fsSaleStatus'), btn = $('fsSaleBtn');
    const service = saleMode === 'service';
    const total = currentTotal();
    if (service) { const err = serviceError(); if (err) { status.textContent = err; return; } }
    if (!Number.isFinite(total) || total <= 0) { status.textContent = service ? 'Informe o preço de venda do serviço.' : 'Informe o valor da venda.'; return; }
    const received = f.elements.method.value === 'cash' && f.elements.received.value.trim() ? parseMoney(f.elements.received.value) : null;
    const toPay = payable();
    if (received != null && (!Number.isFinite(received) || received < toPay)) { status.textContent = 'O valor recebido é menor que o valor a pagar.'; return; }
    // Com produtos, o servidor calcula o total pelos preços cadastrados.
    const body = service ? serviceBody(f.elements.method.value)
      : cart.length
      ? { items: cart.map(i => ({ product_id: i.id, quantity: i.quantity, ...(i.variant ? { variant_name: i.variant } : {}), ...(unitOf(i) !== i.price_cents ? { unit_price_cents: unitOf(i) } : {}) })), discount_cents: Math.min(discountCents(cartGross()), Math.max(0, cartGross() - 1)), payment_method: f.elements.method.value, description: f.elements.description.value.trim() }
      : quickCart.length
        ? { items: quickCart.map(x => ({ name: x.label, quantity: x.qty, unit_price_cents: x.unit })), payment_method: f.elements.method.value, description: f.elements.description.value.trim() }
        : { total_cents: total, payment_method: f.elements.method.value, description: f.elements.description.value.trim() };
    const noPrice = quickCart.find(x => x.unit == null);
    if (!service && !cart.length && noPrice) { status.textContent = `Informe o preço de "${noPrice.label}".`; return; }
    const seller = $('fsSeller')?.value; if (seller) body.seller_id = seller;
    if (saleCustomer?.id) { body.customer_id = saleCustomer.id; const o = $('fsOrder')?.value; if (o) body.order_id = o; const use = cbUse(); if (use > 0) body.cashback_use_cents = use; }
    else if (saleCustomer?.anonymous) body.anonymous = true;
    else if (saleCustomer?.isNew) { const name = $('fsNewName').value.trim(); if (name.length < 2) { status.textContent = 'Informe o nome do cliente.'; return; } body.new_customer = { name, phone: $('fsNewPhone').value.trim() }; }
    else { status.textContent = 'Escolha o cliente (ou marque "Não quis se identificar").'; return; }
    btn.disabled = true;
    try { lastSale = await api('/store/sales', 'POST', body); cbWanted = false; if (service) { svc = {}; servicesCache = null; } else { cart = []; cartDiscount = ''; } if (seller) lastSellerId = seller; lastSale.change_cents = received != null ? received - lastSale.sale.total_cents : null;
      receiptExtras.set(lastSale.sale.id, { received_cents: received, change_cents: lastSale.change_cents });
      if ($('fsAutoPrint')?.checked) printReceipt(lastSale.sale.id); feedback(`${service ? 'Serviço' : 'Venda'} #${lastSale.sale.sale_number} registrado${service ? '' : 'a'}: ${brl(lastSale.sale.total_cents)}.` + (lastSale.change_cents != null ? ` Troco: ${brl(lastSale.change_cents)}.` : '')); await loadCash(box, alive); }
    catch (err) { status.textContent = err.message; } finally { if (btn.isConnected) btn.disabled = false; }
  }
  function drawLast() {
    const box = $('fsLast'); if (!box || !lastSale) return; const s = lastSale, c = s.customer;
    const receiptBtn = '<button type="button" class="nv-button secondary" id="fsReceiptNow">' + FPIcon('receipt') + 'Imprimir comprovante</button>';
    const wireReceipt = () => { if ($('fsReceiptNow')) $('fsReceiptNow').onclick = () => printReceipt(s.sale.id); };
    if (!c) { box.innerHTML = `<div class="fs-last"><div><b>Venda #${s.sale.sale_number}</b> · ${brl(s.sale.total_cents)} · sem cliente${s.change_cents != null ? ` · <b>troco ${brl(s.change_cents)}</b>` : ''}</div><div class="fs-actions">${receiptBtn}</div></div>`; wireReceipt(); return; }
    const note = s.loyalty?.enabled ? (s.loyalty_counted ? 'Somou 1 compra no cartão.' : s.sale.order_id ? 'Pagamento de pedido: conta no cartão quando o pedido é finalizado.' : 'Abaixo do valor mínimo: não somou no cartão.') : '';
    const cb = s.cashback, cbNote = cbOn() && cb ? [cb.used_cents ? `Usou ${brl(cb.used_cents)} de cashback.` : '', cb.earned_cents ? `Ganhou ${brl(cb.earned_cents)} de cashback.` : 'Não gerou cashback (abaixo do valor mínimo).', `Saldo: <b>${brl(cb.balance_cents)}</b>.`].filter(Boolean).join(' ') : '';
    box.innerHTML = `<div class="fs-last"><div><b>Venda #${s.sale.sale_number}</b> · ${brl(s.sale.total_cents)}${s.change_cents != null ? ` · <b>troco ${brl(s.change_cents)}</b>` : ''} · ${esc(c.name)}${s.customer_created ? ' <small>(cadastrado agora)</small>' : ''}<br><small>${note}</small>${cbNote ? `<br><small class="fs-cb-note">${FPIcon('wallet')} ${cbNote}</small>` : ''}${progressBar(s.loyalty)}</div>
      <div class="fs-actions">${receiptBtn}${waPhone(c.phone) ? '<button type="button" class="nv-button fp-whats" id="fsSendNow">Enviar status no WhatsApp</button>' : '<small>Cliente sem WhatsApp cadastrado.</small>'}${s.loyalty?.complete ? '<button type="button" class="nv-button secondary" id="fsRedeemNow">Entregar prêmio</button>' : ''}</div></div>`;
    wireReceipt();
    if ($('fsSendNow')) $('fsSendNow').onclick = async () => { const b = $('fsSendNow'); try { await sendWhats(c.phone, statusMessage({ ...c, loyalty: s.loyalty, cashback: s.cashback }), { customer_id: c.id, kind: 'status' }); b.innerHTML = FPIcon('check') + 'Enviado'; b.disabled = true; } catch (err) { feedback(err.message, true); } };
    if ($('fsRedeemNow')) $('fsRedeemNow').onclick = async () => { try { const r = await redeem(c.id, c.name); if (r) { lastSale = { ...s, loyalty: r.loyalty }; drawLast(); } } catch (err) { feedback(err.message, true); } };
  }

  // ---------------- Serviço (troca de tela, bateria, conserto…) ----------------
  // "Produto" é a venda de balcão (leitor, itens frequentes, valor). "Serviço" registra o que foi feito no
  // aparelho: preço cobrado, custo, fornecedor, aparelho e garantia. Peça do estoque é opcional: preenche
  // aparelho, fornecedor e custo, e a venda baixa uma unidade dela.
  let saleMode = 'product', svc = {}, servicesCache = null, serviceItems = null;
  const WARRANTY = [['', 'Sem garantia'], ['7', '7 dias'], ['30', '30 dias'], ['90', '90 dias'], ['180', '6 meses'], ['365', '1 ano']];
  const PART_NAMES = ['Tela', 'Bateria', 'Conector de carga', 'Tampa traseira', 'Vidro da câmera', 'Câmera', 'Alto-falante', 'Microfone', 'Flex', 'Botão'];
  function currentTotal() {
    const f = $('fsSale'); if (!f) return NaN;
    return saleMode === 'service' ? parseMoney(svc.price) : parseMoney(f.elements.total.value);
  }
  function setMode(mode, focus) {
    saleMode = mode === 'service' ? 'service' : 'product';
    document.querySelectorAll('[data-fs-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.fsMode === saleMode)));
    document.querySelectorAll('#fsSale [data-only]').forEach(n => { n.hidden = n.dataset.only !== saleMode; });
    const btn = $('fsSaleBtn'); if (btn) btn.textContent = saleMode === 'service' ? 'Registrar serviço' : 'Registrar venda';
    if ($('fsSaleStatus')) $('fsSaleStatus').textContent = '';
    $('fsSale')?.dispatchEvent(new Event('input'));
    if (focus) (saleMode === 'service' ? $('fsSvcName') : $('fsScan'))?.focus();
  }
  // Campo com sugestões dos nomes já usados (os mais usados primeiro). O que não existe fica salvo ao registrar.
  function suggestField(input, path, onPick) {
    const list = document.createElement('div'); list.className = 'fs-results fs-drop'; input.after(list);
    let timer, rows = [];
    const close = () => { list.innerHTML = ''; };
    const load = async () => {
      const t = input.value.trim();
      try { rows = await api(path + '?q=' + encodeURIComponent(t)); } catch { return; }
      if (!list.isConnected || document.activeElement !== input) return;
      const exact = rows.some(r => r.name.toLowerCase() === t.toLowerCase());
      list.innerHTML = rows.slice(0, 8).map((r, n) => `<button type="button" data-n="${n}">${esc(r.name)}${r.uses ? ` <small>${r.uses}×</small>` : ''}</button>`).join('')
        + (t && !exact ? `<p class="nv-help">Novo: "${esc(t)}" fica salvo para as próximas vezes.</p>` : '');
      list.querySelectorAll('[data-n]').forEach(b => b.onmousedown = e => { e.preventDefault(); input.value = rows[b.dataset.n].name; close(); onPick?.(rows[b.dataset.n]); });
    };
    input.addEventListener('focus', load);
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 150); });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', e => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && list.innerHTML) { e.preventDefault(); close(); } });
  }
  // Serviços pré-cadastrados: um toque preenche o serviço, o preço (do cadastro ou o último cobrado) e o custo.
  async function loadServiceItems(force) {
    if (serviceItems && !force) return serviceItems;
    try { serviceItems = await api('/store/sales/service-items'); } catch { serviceItems = serviceItems || []; }
    return serviceItems;
  }
  async function drawServiceChips() {
    const box = $('fsSvcQuick'); if (!box) return;
    const [items, history] = await Promise.all([loadServiceItems(), servicesCache ? servicesCache : api('/store/sales/services').then(r => (servicesCache = r)).catch(() => [])]);
    if (!box.isConnected) return;
    const last = name => history.find(h => h.name.toLowerCase() === name.toLowerCase())?.last_price_cents ?? null;
    const priceOf = i => i.price_cents ?? last(i.name);
    const current = String(svc.name || '').trim().toLowerCase();
    box.innerHTML = `<div class="fs-quick-head"><span>Serviços</span><button type="button" class="fs-link" id="fsSvcManage">${items.length ? FPIcon('edit') + ' Editar' : '+ Cadastrar serviço'}</button></div>
      ${items.length ? `<div class="fs-chips">${items.map(i => { const p = priceOf(i); return `<button type="button" class="fs-chip${i.name.toLowerCase() === current ? ' fs-chip-on' : ''}" data-fs-svc="${i.id}" aria-pressed="${i.name.toLowerCase() === current}"><b>${esc(i.name)}</b><small>${p != null ? brl(p) + (i.price_cents == null ? ' (último)' : '') : 'definir preço'}</small></button>`; }).join('')}</div>` : '<p class="nv-help fs-quick-empty">Cadastre os serviços que a loja faz (troca de tela, bateria…) para lançar com um toque.</p>'}`;
    box.querySelectorAll('[data-fs-svc]').forEach(b => b.onclick = () => {
      const i = items.find(x => x.id === b.dataset.fsSvc); if (!i) return;
      const p = priceOf(i);
      svc.name = i.name; svc.price = p != null ? centsText(p) : '';
      // Custo: o da peça escolhida vale mais; sem peça, usa o custo cadastrado no serviço.
      if (!svc.part) svc.cost = i.cost_cents != null ? centsText(i.cost_cents) : (svc.cost || '');
      drawService(); $('fsSale')?.dispatchEvent(new Event('input'));
      if (p == null) { $('fsSvcPrice')?.focus(); }
    });
    $('fsSvcManage').onclick = manageServices;
  }
  async function manageServices(editId) {
    const items = await loadServiceItems(true);
    const ed = typeof editId === 'string' ? items.find(i => i.id === editId) : null;
    openDialog(`${header('Serviços')}<p class="nv-help">Aparecem como botões no modo "Serviço" do caixa. O preço e o custo vêm preenchidos e podem ser mudados na hora. Sem preço, o botão usa o último valor cobrado.</p>
      <form id="fsSvcForm" class="fs-row" autocomplete="off"><label class="nv-field fs-grow">Serviço<input name="name" maxlength="80" required placeholder="Ex.: Troca de tela" value="${esc(ed?.name || '')}"></label>
      <label class="nv-field">Preço<input name="price" inputmode="decimal" placeholder="0,00" value="${ed?.price_cents != null ? centsText(ed.price_cents) : ''}"></label>
      <label class="nv-field">Custo (opcional)<input name="cost" inputmode="decimal" placeholder="0,00" value="${ed?.cost_cents != null ? centsText(ed.cost_cents) : ''}"></label>
      <button class="nv-button">${ed ? 'Salvar' : 'Cadastrar'}</button>${ed ? '<button type="button" class="nv-button secondary" id="fsSvcCancelEdit">Cancelar</button>' : ''}</form><p role="status" class="nv-help" id="fsSvcStatus"></p>
      <div class="nv-list">${items.map(i => `<div class="fs-sale"><div><b>${esc(i.name)}</b><br><small>${i.price_cents != null ? brl(i.price_cents) : 'sem preço fixo'}${i.cost_cents != null ? ' · custo ' + brl(i.cost_cents) : ''}</small></div><div class="fs-sale-end"><button type="button" class="nv-button secondary fs-small" data-svc-edit="${i.id}">Editar</button><button type="button" class="nv-button secondary fs-small" data-svc-del="${i.id}">Excluir</button></div></div>`).join('') || '<p class="nv-help">Nenhum serviço cadastrado.</p>'}</div>`);
    const f = $('fsSvcForm'), st = $('fsSvcStatus');
    if (ed) { f.elements.price.focus(); $('fsSvcCancelEdit').onclick = () => manageServices(); }
    f.onsubmit = async e => {
      e.preventDefault();
      const name = f.elements.name.value.trim(), pr = f.elements.price.value.trim(), co = f.elements.cost.value.trim();
      const price = pr ? parseMoney(pr) : null, cost = co ? parseMoney(co) : null;
      if (name.length < 2) { st.textContent = 'Informe o serviço.'; return; }
      if ((pr && !(price >= 0)) || (co && !(cost >= 0))) { st.textContent = 'Preço ou custo inválido.'; return; }
      try {
        await api(ed ? '/store/sales/service-items/' + ed.id : '/store/sales/service-items', ed ? 'PATCH' : 'POST', { name, price_cents: price, cost_cents: cost });
        await manageServices(); drawServiceChips(); $('fsSvcStatus').textContent = `"${name}" ${ed ? 'salvo' : 'cadastrado'}.`;
      } catch (err) { st.textContent = err.message; }
    };
    document.querySelectorAll('[data-svc-edit]').forEach(b => b.onclick = () => manageServices(b.dataset.svcEdit));
    document.querySelectorAll('[data-svc-del]').forEach(b => b.onclick = async () => {
      const i = items.find(x => x.id === b.dataset.svcDel); if (!confirm(`Excluir "${i?.name}" dos serviços?`)) return;
      try { await api('/store/sales/service-items/' + i.id, 'DELETE'); await manageServices(); drawServiceChips(); } catch (err) { st.textContent = err.message; }
    });
  }
  const partLabel = p => p.name + (p.device_model ? ' · ' + p.device_model : '');
  function drawService() {
    const box = $('fsSvc'); if (!box) return;
    box.innerHTML = `<div class="fs-quick" id="fsSvcQuick"></div>
      <div class="fs-sugg"><label class="nv-field">Serviço<input id="fsSvcName" maxlength="120" list="fsSvcNames" placeholder="Ex.: Troca de tela, troca de bateria" value="${esc(svc.name || '')}"></label><datalist id="fsSvcNames"></datalist></div>
      <div class="nv-field">Peça do estoque <small class="nv-help">opcional · preenche aparelho, fornecedor e custo, e baixa do estoque</small><div id="fsSvcPart"></div></div>
      <div class="fs-row"><label class="nv-field fs-grow fs-sugg">Aparelho (marca / modelo)<input id="fsSvcModel" maxlength="80" placeholder="Ex.: Galaxy A12, iPhone 11" value="${esc(svc.model || '')}"></label>
        <label class="nv-field fs-grow fs-sugg">Fornecedor<input id="fsSvcSupplier" maxlength="80" placeholder="De quem veio a peça" value="${esc(svc.supplier || '')}"></label></div>
      <div class="fs-row"><label class="nv-field fs-grow">Preço de venda<input id="fsSvcPrice" inputmode="decimal" placeholder="0,00" value="${esc(svc.price || '')}"></label>
        <label class="nv-field fs-grow">Preço de custo<input id="fsSvcCost" inputmode="decimal" placeholder="0,00" value="${esc(svc.cost || '')}"></label>
        <label class="nv-field">Garantia<select id="fsSvcWarranty">${WARRANTY.map(([v, t]) => `<option value="${v}"${String(svc.warranty || '') === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label></div>
      <p class="nv-help" id="fsSvcProfit"></p>
      <label class="nv-field">Observação (opcional)<input id="fsSvcNote" maxlength="200" placeholder="Ex.: tela original; cliente busca amanhã" value="${esc(svc.note || '')}"></label>`;
    const read = () => { svc = { ...svc, name: $('fsSvcName').value, model: $('fsSvcModel').value, supplier: $('fsSvcSupplier').value, price: $('fsSvcPrice').value, cost: $('fsSvcCost').value, warranty: $('fsSvcWarranty').value, note: $('fsSvcNote').value }; profit(); };
    const profit = () => {
      const p = parseMoney(svc.price), c = parseMoney(svc.cost), out = $('fsSvcProfit'); if (!out) return;
      out.innerHTML = Number.isFinite(p) && Number.isFinite(c) ? `Lucro do serviço: <b class="${p - c < 0 ? 'fs-neg' : 'fs-pos'}">${brl(p - c)}</b>${p > 0 ? ` (${margin(p, c)}% do preço)` : ''}` : '';
    };
    box.oninput = box.onchange = read;
    suggestField($('fsSvcModel'), '/store/device-models', read);
    suggestField($('fsSvcSupplier'), '/store/suppliers', read);
    // Serviço já feito antes: sugere o nome e, se o preço estiver vazio, o último preço cobrado.
    (servicesCache ? Promise.resolve(servicesCache) : api('/store/sales/services').then(r => (servicesCache = r)).catch(() => [])).then(rows => {
      const dl = $('fsSvcNames'); if (!dl) return; dl.innerHTML = rows.map(r => `<option value="${esc(r.name)}">`).join('');
      $('fsSvcName').onchange = () => { const hit = rows.find(r => r.name.toLowerCase() === $('fsSvcName').value.trim().toLowerCase()); if (hit && !$('fsSvcPrice').value.trim() && hit.last_price_cents) $('fsSvcPrice').value = centsText(hit.last_price_cents); read(); $('fsSale')?.dispatchEvent(new Event('input')); };
    });
    drawPartPicker(); drawServiceChips(); read();
  }
  function drawPartPicker() {
    const box = $('fsSvcPart'); if (!box) return;
    if (svc.part) {
      const p = svc.part;
      box.innerHTML = `<div class="fs-picked"><div><b>${esc(partLabel(p))}</b><br><small>${p.supplier_name ? esc(p.supplier_name) + ' · ' : ''}custo ${p.cost_cents != null ? brl(p.cost_cents) : '—'}${p.stock_qty != null ? ` · <span class="${p.stock_qty <= 0 ? 'fs-neg' : ''}">estoque ${p.stock_qty}</span>` : ''}</small></div><button type="button" class="nv-button secondary fs-small" id="fsSvcPartOff">Tirar peça</button></div>`;
      $('fsSvcPartOff').onclick = () => { svc.part = null; drawPartPicker(); };
      return;
    }
    box.innerHTML = `<div class="fs-sugg"><input id="fsSvcPartQ" type="search" placeholder="Buscar peça: tela a12, bateria iphone…" aria-label="Buscar peça do estoque"><div id="fsSvcPartList" class="fs-results fs-drop"></div></div>`;
    const input = $('fsSvcPartQ'), list = $('fsSvcPartList'); let timer;
    const load = async () => {
      const t = input.value.trim(); let rows = [];
      try { rows = await api('/store/products?kind=part&q=' + encodeURIComponent(t || svc.model || '')); } catch (err) { list.textContent = err.message; return; }
      if (!list.isConnected || document.activeElement !== input) return;
      list.innerHTML = rows.slice(0, 10).map((p, n) => `<button type="button" data-n="${n}"><b>${esc(partLabel(p))}</b> <small>${p.supplier_name ? esc(p.supplier_name) + ' · ' : ''}${p.cost_cents != null ? 'custo ' + brl(p.cost_cents) : 'sem custo'} · estoque ${p.stock_qty ?? '—'}</small></button>`).join('')
        + `<p class="nv-help">${rows.length ? '' : 'Nenhuma peça encontrada. '}<button type="button" class="fs-link" id="fsSvcPartNew">+ Cadastrar peça no estoque</button></p>`;
      list.querySelectorAll('[data-n]').forEach(b => b.onmousedown = e => { e.preventDefault(); usePart(rows[b.dataset.n]); });
      $('fsSvcPartNew').onmousedown = e => { e.preventDefault(); partDialog({ device_model: svc.model || '', supplier_name: svc.supplier || '', name: PART_NAMES.find(n => fp(t).startsWith(fp(n))) || '' }, p => usePart(p)); };
    };
    input.onfocus = load; input.oninput = () => { clearTimeout(timer); timer = setTimeout(load, 150); };
    input.onblur = () => setTimeout(() => { if (list.isConnected) list.innerHTML = ''; }, 150);
  }
  const fp = v => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Peça escolhida: aparelho, fornecedor e custo vêm dela; preço sugerido só entra se o preço estiver vazio.
  function usePart(p) {
    svc.part = p;
    if (p.device_model) svc.model = p.device_model;
    if (p.supplier_name) svc.supplier = p.supplier_name;
    if (p.cost_cents != null) svc.cost = centsText(p.cost_cents);
    if (!String(svc.price || '').trim() && p.price_cents > 0) svc.price = centsText(p.price_cents);
    if (!String(svc.name || '').trim()) svc.name = 'Troca de ' + p.name.toLowerCase();
    drawService(); $('fsSale')?.dispatchEvent(new Event('input'));
  }
  function serviceError() {
    if (String(svc.name || '').trim().length < 2) return 'Informe o serviço (ex.: troca de tela).';
    const c = String(svc.cost || '').trim();
    if (c && (!Number.isFinite(parseMoney(c)) || parseMoney(c) < 0)) return 'Preço de custo inválido.';
    return '';
  }
  function serviceBody(method) {
    const item = { service: svc.name.trim(), unit_price_cents: parseMoney(svc.price) };
    const c = String(svc.cost || '').trim(); if (c) item.cost_cents = parseMoney(c);
    if (String(svc.supplier || '').trim()) item.supplier = svc.supplier.trim();
    if (String(svc.model || '').trim()) item.device_model = svc.model.trim();
    if (svc.part) item.part_id = svc.part.id;
    if (svc.warranty) item.warranty_days = Number(svc.warranty);
    return { items: [item], payment_method: method, description: String(svc.note || '').trim() };
  }

  // Cadastro de peça (tela, bateria…): cada peça tem aparelho, fornecedor, custo e estoque.
  function partDialog(initial = {}, onSaved) {
    const editing = !!initial.id;
    openDialog(`${header(editing ? 'Editar peça' : 'Cadastrar peça')}<form id="fsPart" autocomplete="off">
      <p class="nv-help">Peças usadas nos serviços (telas, baterias…). Cadastre uma peça para cada modelo de aparelho e fornecedor.</p>
      <div class="fs-row"><label class="nv-field fs-grow">Peça<input name="name" maxlength="120" required list="fsPartNames" value="${esc(initial.name || '')}" placeholder="Ex.: Tela, Bateria"></label><datalist id="fsPartNames">${PART_NAMES.map(n => `<option value="${n}">`).join('')}</datalist>
        <label class="nv-field fs-grow fs-sugg">Aparelho (marca / modelo)<input id="fsPartModel" name="device_model" maxlength="80" value="${esc(initial.device_model || '')}" placeholder="Ex.: Galaxy A12"></label></div>
      <label class="nv-field fs-sugg">Fornecedor<input id="fsPartSupplier" name="supplier" maxlength="80" value="${esc(initial.supplier_name || '')}" placeholder="De quem a loja compra esta peça"></label>
      <div class="fs-row"><label class="nv-field fs-grow">Preço de custo<input name="cost" inputmode="decimal" value="${initial.cost_cents != null ? centsText(initial.cost_cents) : ''}" placeholder="0,00"></label>
        <label class="nv-field fs-grow">Preço do serviço com esta peça <small class="nv-help">(opcional)</small><input name="price" inputmode="decimal" value="${initial.price_cents > 0 ? centsText(initial.price_cents) : ''}" placeholder="0,00"></label>
        ${editing ? '' : '<label class="nv-field" style="flex:0 0 130px">Quantidade na loja<input name="stock" inputmode="numeric" placeholder="Ex.: 3"></label>'}</div>
      ${editing ? `<p class="nv-help">Estoque atual: <b>${initial.stock_qty ?? '—'}</b>. Para somar ou corrigir, use "+ Estoque" na lista de peças.</p>` : ''}
      <button class="nv-button">${editing ? 'Salvar' : onSaved && !onSaved.list ? 'Cadastrar e usar no serviço' : 'Cadastrar'}</button><p role="status" class="nv-help"></p></form>`);
    const f = $('fsPart'), st = f.querySelector('[role=status]');
    suggestField($('fsPartModel'), '/store/device-models'); suggestField($('fsPartSupplier'), '/store/suppliers');
    (initial.name ? $('fsPartModel') : f.elements.name).focus();
    f.onsubmit = async e => {
      e.preventDefault();
      const name = f.elements.name.value.trim(), costRaw = f.elements.cost.value.trim(), priceRaw = f.elements.price.value.trim(), stockRaw = f.elements.stock?.value.trim() || '';
      const cost = costRaw ? parseMoney(costRaw) : null, price = priceRaw ? parseMoney(priceRaw) : 0, stock = stockRaw === '' ? null : Number(stockRaw);
      if (name.length < 2) { st.textContent = 'Informe a peça (ex.: Tela).'; return; }
      if (costRaw && (!Number.isFinite(cost) || cost < 0)) { st.textContent = 'Preço de custo inválido.'; return; }
      if (priceRaw && (!Number.isFinite(price) || price < 0)) { st.textContent = 'Preço do serviço inválido.'; return; }
      if (stock != null && !Number.isInteger(stock)) { st.textContent = 'Quantidade: use um número inteiro.'; return; }
      const body = { name, cost_cents: cost, price_cents: price, supplier: f.elements.supplier.value.trim(), device_model: f.elements.device_model.value.trim() };
      if (!editing) { body.kind = 'part'; body.stock_qty = stock ?? 0; }
      try {
        const p = await api(editing ? '/store/products/' + initial.id : '/store/products', editing ? 'PATCH' : 'POST', body);
        $('editorDialog').close(); feedback(`Peça ${editing ? 'atualizada' : 'cadastrada'}: ${partLabel(p)}.`); onSaved?.(p);
      } catch (err) { st.textContent = err.message; }
    };
  }
  async function partsTab(box, term = '') {
    box.innerHTML = `<div class="fs-row"><input id="fsPartSearch" class="fs-grow" type="search" placeholder="Buscar peça ou modelo (ex.: tela a12)" value="${esc(term)}" aria-label="Buscar peça"><button type="button" class="nv-button" id="fsPartNew">+ Nova peça</button></div>
      <p class="nv-help">Peças que a loja tem para os serviços. Ao registrar um serviço com a peça, o estoque baixa sozinho e a peça entra na reposição.</p><div id="fsPartList" class="nv-list"></div>`;
    const input = $('fsPartSearch'), list = $('fsPartList'); let timer, rows = [];
    const reopen = () => productsDialog(input.value.trim(), 'parts'); reopen.list = true;
    const draw = async () => {
      try { rows = await api('/store/products?kind=part&q=' + encodeURIComponent(input.value.trim())); } catch (err) { list.textContent = err.message; return; }
      if (!list.isConnected) return;
      list.innerHTML = rows.map(p => `<div class="fs-sale fs-prod"><div><b>${esc(partLabel(p))}</b><br><small>${p.supplier_name ? 'Fornecedor: ' + esc(p.supplier_name) : 'sem fornecedor'} · custo ${p.cost_cents != null ? brl(p.cost_cents) : '—'}${p.price_cents > 0 ? ' · serviço ' + brl(p.price_cents) : ''}</small><br>
          <small>Estoque: <b class="${p.stock_qty != null && p.stock_qty <= 0 ? 'fs-neg' : ''}">${p.stock_qty ?? '—'}</b>${p.restock_pending ? ` · <span class="fs-neg">repor ${p.restock_pending}</span>` : ''}</small></div>
        <div class="fs-sale-end"><button type="button" class="nv-button secondary fs-small" data-p-edit="${p.id}">Editar</button><button type="button" class="nv-button secondary fs-small" data-p-stock="${p.id}">+ Estoque</button><button type="button" class="nv-button secondary fs-small" data-p-hist="${p.id}">Histórico</button><button type="button" class="nv-button secondary fs-small" data-p-del="${p.id}">Excluir</button></div></div>`).join('')
        || `<p class="nv-help">${input.value.trim() ? 'Nenhuma peça encontrada.' : 'Nenhuma peça cadastrada ainda. Ex.: Tela Galaxy A12, do fornecedor João, custo R$ 80, 3 na loja.'}</p>`;
      const byId = id => rows.find(p => p.id === id);
      list.querySelectorAll('[data-p-edit]').forEach(b => b.onclick = () => partDialog(byId(b.dataset.pEdit), reopen));
      list.querySelectorAll('[data-p-stock]').forEach(b => b.onclick = () => { const p = byId(b.dataset.pStock); stockDialog({ ...p, name: partLabel(p) }, reopen); });
      list.querySelectorAll('[data-p-hist]').forEach(b => b.onclick = () => { const p = byId(b.dataset.pHist); logFilter = { product_id: p.id, name: partLabel(p) }; productsDialog('', 'log'); });
      list.querySelectorAll('[data-p-del]').forEach(b => b.onclick = async () => {
        const p = byId(b.dataset.pDel); if (!confirm(`Excluir a peça "${partLabel(p)}"? Serviços antigos continuam com ela no histórico.`)) return;
        try { await api('/store/products/' + p.id, 'DELETE'); if (svc.part?.id === p.id) svc.part = null; draw(); } catch (err) { feedback(err.message, true); }
      });
    };
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(draw, 200); };
    $('fsPartNew').onclick = () => partDialog({}, reopen);
    input.focus(); draw();
  }
  // Fornecedores e modelos de aparelho que aparecem nas sugestões. Excluir só tira da lista de sugestões.
  async function suppliersTab(box) {
    let sups = [], models = [];
    try { [sups, models] = await Promise.all([api('/store/suppliers'), api('/store/device-models')]); } catch (err) { box.textContent = err.message; return; }
    if (!box.isConnected) return;
    const row = (x, kind) => `<div class="fs-sale"><div><b>${esc(x.name)}</b><br><small>${x.phone ? esc(x.phone) + ' · ' : ''}${x.uses ? `usado ${x.uses}×` : 'ainda não usado em serviço'}</small></div><div class="fs-sale-end"><button type="button" class="nv-button secondary fs-small" data-s-del="${kind}:${x.id}">Tirar da lista</button></div></div>`;
    box.innerHTML = `<p class="nv-help">Os nomes entram aqui sozinhos ao registrar serviços e cadastrar peças, e são sugeridos pelos mais usados.</p>
      <form id="fsSupNew" class="fs-row" autocomplete="off"><label class="nv-field fs-grow">Novo fornecedor<input name="name" maxlength="80" required placeholder="Ex.: João Peças"></label><label class="nv-field">WhatsApp (opcional)<input name="phone" maxlength="30" inputmode="tel"></label><button class="nv-button">Adicionar</button></form>
      <h3>Fornecedores (${sups.length})</h3><div class="nv-list">${sups.map(x => row(x, 'suppliers')).join('') || '<p class="nv-help">Nenhum fornecedor ainda.</p>'}</div>
      <h3>Modelos de aparelho (${models.length})</h3><div class="nv-list">${models.map(x => row(x, 'device-models')).join('') || '<p class="nv-help">Nenhum modelo ainda.</p>'}</div>`;
    $('fsSupNew').onsubmit = async e => { e.preventDefault(); const f = e.currentTarget; try { await api('/store/suppliers', 'POST', { name: f.elements.name.value.trim(), phone: f.elements.phone.value.trim() }); suppliersTab(box); } catch (err) { feedback(err.message, true); } };
    box.querySelectorAll('[data-s-del]').forEach(b => b.onclick = async () => { const [kind, id] = b.dataset.sDel.split(':'); try { await api(`/store/${kind}/${id}`, 'DELETE'); suppliersTab(box); } catch (err) { feedback(err.message, true); } });
  }

  // ---------------- Olho: esconder/mostrar valores do caixa ----------------
  // Começa escondido para o cliente no balcão não ver quanto entrou. A escolha fica salva neste
  // navegador. A venda em montagem (produtos, total, troco) continua sempre visível.
  const EYE_KEY = 'fp_cash_values_hidden';
  let eyeMemory = true; // usado se o navegador bloquear o armazenamento
  const valuesHidden = () => { try { const v = localStorage.getItem(EYE_KEY); return v == null ? eyeMemory : v !== '0'; } catch { return eyeMemory; } };
  function setupEye(box) {
    const btn = $('fsEye'); if (!btn) return;
    const apply = () => {
      const hidden = valuesHidden(); box.classList.toggle('fs-private', hidden);
      btn.innerHTML = hidden ? FPIcon('eye') + 'Mostrar valores' : FPIcon('eyeOff') + 'Esconder valores';
      btn.setAttribute('aria-pressed', String(!hidden)); btn.title = hidden ? 'Mostrar os valores do caixa' : 'Esconder os valores do caixa';
    };
    btn.onclick = () => { eyeMemory = !valuesHidden(); try { localStorage.setItem(EYE_KEY, eyeMemory ? '1' : '0'); } catch { /* fica só na memória */ } apply(); };
    apply();
  }

  // ---------------- Produtos e leitor de código de barras ----------------
  // O leitor USB funciona como teclado: "digita" o código muito rápido e aperta Enter.
  let audioCtx;
  function beep(ok) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = ok ? 1250 : 320; g.gain.value = 0.06; o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + (ok ? 0.07 : 0.3));
    } catch { /* sem som não impede a venda */ }
  }

  function addToCart(p, quantity = 1, variant = null) {
    if (quickCart.length) { feedback('Esta venda já tem itens frequentes (valor digitado). Registre-a ou clique em "Limpar" nos itens frequentes antes de bipar produtos.', true); beep(false); return false; }
    // Produto com modelos (código geral de película/capinha): pergunta o modelo antes de pôr na venda.
    if (p.ask_variant && !variant) { variantPicker(p, v => addToCart(p, quantity, v)); return true; }
    const vname = variant?.name || null;
    const item = cart.find(i => i.id === p.id && (i.variant || null) === vname);
    const stock = variant ? variant.stock_qty ?? null : p.stock_qty ?? null;
    if (item) { item.quantity += quantity; Object.assign(item, { name: p.name, price_cents: p.price_cents, cost_cents: p.cost_cents ?? null, stock_qty: stock }); }
    else cart.push({ id: p.id, name: p.name, variant: vname, barcode: p.barcode, price_cents: p.price_cents, cost_cents: p.cost_cents ?? null, stock_qty: stock, quantity });
    drawCart(p.id); return true;
  }
  // Pergunta o modelo: sugere os mais vendidos e filtra enquanto digita; modelo novo fica salvo na venda.
  function variantPicker(p, onPick) {
    openDialog(`${header('Qual modelo? · ' + esc(p.name))}<form id="fsVar" autocomplete="off"><label class="nv-field">Modelo aplicado<input name="m" maxlength="80" placeholder="Ex.: Galaxy A12, iPhone 13…" required></label>
      <div id="fsVarList" class="fs-results"></div><button class="nv-button">Pôr na venda</button><p role="status" class="nv-help"></p></form>`);
    const f = $('fsVar'), input = f.elements.m, list = $('fsVarList'); let rows = [], timer;
    const pick = v => { $('editorDialog').close(); onPick(v); beep(true); };
    const load = async () => {
      try { rows = await api(`/store/products/${p.id}/variants?q=` + encodeURIComponent(input.value.trim())); } catch (err) { list.textContent = err.message; return; }
      if (!list.isConnected) return;
      list.innerHTML = rows.slice(0, 12).map((v, n) => `<button type="button" data-fs-var="${n}"><b>${esc(v.name)}</b> <small>${v.stock_qty != null ? 'estoque ' + v.stock_qty + ' · ' : ''}${v.sold_count} vendida(s)</small></button>`).join('')
        || `<p class="nv-help">${input.value.trim() ? `Modelo novo: "${esc(input.value.trim())}". Ele fica salvo para as próximas vendas.` : 'Nenhum modelo vendido ainda. Digite o modelo aplicado.'}</p>`;
      list.querySelectorAll('[data-fs-var]').forEach(b => b.onclick = () => pick(rows[b.dataset.fsVar]));
    };
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(load, 150); };
    f.onsubmit = e => {
      e.preventDefault(); const t = input.value.trim().replace(/\s+/g, ' ');
      if (!t) { if (rows[0]) pick(rows[0]); else f.querySelector('[role=status]').textContent = 'Informe o modelo.'; return; }
      pick(rows.find(v => v.name.toLowerCase() === t.toLowerCase()) || { name: t, stock_qty: null });
    };
    input.focus(); load();
  }

  // Desconto: em R$ ("5,00") ou em % ("10%") sobre a soma dos produtos.
  let cartDiscount = '';
  // Custo camuflado para o balcão: 15,00 → 000X15 · 130,00 → 000X130 · 1,50 → 000X1.5.
  // Só aparece no carrinho do caixa; nunca vai para o comprovante.
  const costCode = c => c == null ? '' : '000X' + String(Math.round(c) / 100);
  const discountCents = sub => {
    const t = String(cartDiscount || '').trim(); if (!t) return 0;
    const v = t.endsWith('%') ? Math.round(sub * (parseFloat(t.replace(',', '.')) || 0) / 100) : parseMoney(t);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  // Preço de cada produto na venda: o do cadastro, a não ser que o vendedor mude ali mesmo.
  const unitOf = i => i.unit ?? i.price_cents;
  const cartGross = () => cart.reduce((a, i) => a + unitOf(i) * i.quantity, 0);
  function drawCart(flashId) {
    const out = $('fsCart'), f = $('fsSale'); if (!out || !f) return;
    const sub = cartGross();
    const disc = Math.min(discountCents(sub), Math.max(0, sub - 1)), total = sub - disc;
    const knownCost = cart.every(i => i.cost_cents != null), cost = cart.reduce((a, i) => a + (i.cost_cents || 0) * i.quantity, 0);
    const below = knownCost && cost > 0 && total < cost;
    out.innerHTML = cart.length ? `<div class="fs-pcart">${cart.map((i, n) => `<div class="fs-item${i.id === flashId ? ' fs-flash' : ''}"><div class="fs-grow"><b>${esc(i.name)}${i.variant ? ` <span class="fs-var">${esc(i.variant)}</span>` : ''}</b><br><small><span class="fs-unit-wrap">R$ <input class="fs-unit" data-fs-unit="${n}"${basic() ? ' readonly' : ''} inputmode="decimal" value="${centsText(unitOf(i))}" aria-label="Preço de cada ${esc(i.name)}"> cada${unitOf(i) !== i.price_cents ? ` <s>${brl(i.price_cents)}</s>` : ''}</span>${i.cost_cents != null && unitOf(i) < i.cost_cents ? ' <b class="fs-neg">abaixo do custo</b>' : ''}${i.barcode ? ' · ' + esc(i.barcode) : ''}${i.cost_cents != null ? ` <span class="fs-costcode" title="Código interno da loja">${costCode(i.cost_cents)}</span>` : ''}${i.stock_qty != null ? ` · <span class="${i.stock_qty - i.quantity < 0 ? 'fs-neg' : ''}">estoque ${i.stock_qty}</span>` : ''}</small></div>
      <div class="fs-qty"><button type="button" class="nv-button secondary fs-small" data-fs-dec="${n}" aria-label="Diminuir">−</button><b>${i.quantity}</b><button type="button" class="nv-button secondary fs-small" data-fs-inc="${n}" aria-label="Aumentar">+</button></div>
      <b class="fs-item-total">${brl(unitOf(i) * i.quantity)}</b><button type="button" class="nv-button secondary fs-small" data-fs-del="${n}" aria-label="Tirar da venda">${FPIcon('x')}</button></div>`).join('')}
      <div class="fs-pcart-total"><span>${cart.reduce((a, i) => a + i.quantity, 0)} item(ns)</span><b>${brl(sub)}</b></div>
      <div class="fs-disc"><label>Desconto <input id="fsDiscount" inputmode="decimal" placeholder="0,00 ou 10%" value="${esc(cartDiscount)}" autocomplete="off"></label></div>
      ${below ? '<div class="fs-costsum fs-below"><b>Atenção: total abaixo do custo.</b></div>' : ''}
      ${disc ? `<div class="fs-pcart-total"><span>Total com desconto</span><b>${brl(total)}</b></div>` : ''}</div>` : '';
    out.querySelectorAll('[data-fs-inc]').forEach(b => b.onclick = () => { cart[b.dataset.fsInc].quantity++; drawCart(); });
    out.querySelectorAll('[data-fs-dec]').forEach(b => b.onclick = () => { const i = cart[b.dataset.fsDec]; if (i.quantity > 1) i.quantity--; else cart.splice(b.dataset.fsDec, 1); drawCart(); });
    out.querySelectorAll('[data-fs-del]').forEach(b => b.onclick = () => { cart.splice(b.dataset.fsDel, 1); drawCart(); });
    if ($('fsDiscount')) $('fsDiscount').onchange = e => { cartDiscount = e.target.value.trim(); drawCart(); };
    if ($('fsDiscount')) $('fsDiscount').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
    out.querySelectorAll('[data-fs-unit]').forEach(inp => {
      inp.onchange = () => { const i = cart[inp.dataset.fsUnit], v = parseMoney(inp.value); if (i) i.unit = inp.value.trim() && Number.isFinite(v) && v >= 0 ? v : null; drawCart(); };
      inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } };
      inp.onfocus = () => inp.select();
    });
    if (!cart.length) cartDiscount = '';
    // Com produtos, o valor é a soma dos itens menos o desconto (não editável); sem produtos, volta a ser digitado.
    const input = f.elements.total, auto = input.dataset.auto === '1';
    if (cart.length) { input.value = centsText(total); input.readOnly = true; input.dataset.auto = '1'; $('fsTotalLabel').textContent = disc ? 'Valor (produtos − desconto)' : 'Valor (soma dos produtos)'; }
    else if (auto) { input.value = ''; input.readOnly = false; input.dataset.auto = ''; $('fsTotalLabel').textContent = 'Valor'; }
    f.dispatchEvent(new Event('input')); drawQuick();
  }

  // Código lido (pelo leitor ou digitado): acha o produto e põe na venda; se não existe, oferece cadastrar.
  let lookingUp = Promise.resolve();
  function handleCode(code) {
    lookingUp = lookingUp.then(async () => {
      try { const p = await api('/store/products/barcode/' + encodeURIComponent(code)); if (addToCart(p)) beep(true); }
      catch (err) {
        if (err.status !== 404) { feedback(err.message, true); beep(false); return; }
        beep(false); if (quickCart.length) { addToCart({}); return; }
        productDialog({ barcode: code }, p => { if (addToCart(p)) beep(true); }, true);
      }
    });
    return lookingUp;
  }

  function setupScanInput() {
    const input = $('fsScan'), out = $('fsScanResults'); if (!input) return;
    let timer;
    const showResults = rows => {
      out.innerHTML = rows.map(p => `<button type="button" data-fs-prod="${p.id}"><b>${esc(p.name)}</b> <small>${brl(p.price_cents)}${p.barcode ? ' · ' + esc(p.barcode) : ''}</small></button>`).join('')
        || `<p class="nv-help">Nenhum produto encontrado. <button type="button" class="nv-button secondary fs-small" id="fsQuickNew">+ Cadastrar produto</button></p>`;
      out.querySelectorAll('[data-fs-prod]').forEach(b => b.onclick = () => { addToCart(rows.find(p => p.id === b.dataset.fsProd)); input.value = ''; out.innerHTML = ''; input.focus(); });
      if ($('fsQuickNew')) $('fsQuickNew').onclick = () => { const t = input.value.trim(); productDialog(looksLikeCode(t) && !/\s/.test(t) ? { barcode: t } : { name: t }, p => { addToCart(p); input.value = ''; out.innerHTML = ''; }, true); };
      return rows;
    };
    const search = async () => { const t = input.value.trim(); if (t.length < 2) { out.innerHTML = ''; return []; } try { return showResults(await api('/store/products?q=' + encodeURIComponent(t))); } catch (err) { out.textContent = err.message; return []; } };
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(search, 220); };
    // Enter digitado à mão: código → procura pelo código; nome → se só um produto bate, adiciona.
    input.onkeydown = async e => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); const t = input.value.trim(); if (!t) return;
      clearTimeout(timer);
      if (looksLikeCode(t)) { input.value = ''; out.innerHTML = ''; return handleCode(t); }
      const rows = await search(); if (rows.length === 1) { addToCart(rows[0]); input.value = ''; out.innerHTML = ''; }
    };
  }

  const margin = (price, cost) => price > 0 && cost != null ? Math.round(100 * (price - cost) / price) : null;
  function productDialog(initial = {}, onSaved, forSale = false) {
    const editing = !!initial.id;
    openDialog(`${header(editing ? 'Editar produto' : 'Cadastrar produto')}<form id="fsProd" autocomplete="off">
      ${!editing && initial.barcode ? `<p class="nv-help fs-warn">O código <b>${esc(initial.barcode)}</b> ainda não está cadastrado. Informe nome e preço: o produto entra na venda e, nas próximas vezes, o leitor já reconhece.</p>` : ''}
      <label class="nv-field">Código de barras<input name="barcode" maxlength="64" value="${esc(initial.barcode || '')}" placeholder="Bipe o produto com o leitor (opcional)"${initial.generated_barcode ? ' readonly' : ''}></label>
      ${initial.generated_barcode ? '<small class="nv-help">Código gerado pelo sistema (não muda, para as etiquetas impressas continuarem valendo).</small>' : ''}
      <label class="nv-field">Nome do produto<input name="name" maxlength="120" required value="${esc(initial.name || '')}" placeholder="Ex.: Película 3D Galaxy A12"></label>
      <div class="fs-row"><label class="nv-field fs-grow">Preço de venda<input name="price" inputmode="decimal" required value="${initial.price_cents != null ? centsText(initial.price_cents) : ''}" placeholder="0,00"></label>
      <label class="nv-field fs-grow">Preço de custo<input name="cost" inputmode="decimal" value="${initial.cost_cents != null ? centsText(initial.cost_cents) : ''}" placeholder="0,00"></label></div>
      <p class="nv-help" id="fsMargin"></p>
      <label class="fs-check"><input type="checkbox" name="ask_variant"${initial.ask_variant ? ' checked' : ''}> Código geral com modelos (película, capinha…): na venda, pergunta o modelo aplicado</label>
      <label class="nv-field" id="fsStockField">Estoque (quantidade na loja)<input name="stock" inputmode="numeric" value="${initial.stock_qty != null ? initial.stock_qty : ''}" placeholder="Deixe vazio para não controlar"></label>
      <small class="nv-help" id="fsVarHelp">O estoque fica por modelo: use "+ Estoque" na lista de produtos e informe o modelo (ex.: 10 películas Galaxy A12).</small>
      <button class="nv-button">${editing ? 'Salvar' : forSale ? 'Cadastrar e pôr na venda' : 'Cadastrar'}</button><p role="status" class="nv-help"></p></form>`);
    const f = $('fsProd'), st = f.querySelector('[role=status]');
    const syncVar = () => { const on = f.elements.ask_variant.checked; $('fsStockField').hidden = on; $('fsVarHelp').hidden = !on; };
    f.elements.ask_variant.onchange = syncVar; syncVar();
    const showMargin = () => { const p = parseMoney(f.elements.price.value), c = parseMoney(f.elements.cost.value); const m = Number.isFinite(p) && Number.isFinite(c) ? margin(p, c) : null;
      $('fsMargin').innerHTML = m == null ? 'Com o custo, o caixa mostra até quanto dá para descontar sem prejuízo.' : `Lucro por unidade: <b class="${p - c < 0 ? 'fs-neg' : 'fs-pos'}">${brl(p - c)}</b> (${m}% do preço)`; };
    f.oninput = showMargin; showMargin();
    // O leitor manda Enter no fim: no campo do código, Enter só passa para o próximo campo.
    f.elements.barcode.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); f.elements.name.focus(); } };
    (initial.barcode && !initial.name ? f.elements.name : f.elements.barcode.value ? f.elements.name : f.elements.barcode).focus();
    f.onsubmit = async e => {
      e.preventDefault();
      const price = parseMoney(f.elements.price.value), name = f.elements.name.value.trim(), barcode = f.elements.barcode.value.trim();
      const costRaw = f.elements.cost.value.trim(), cost = costRaw ? parseMoney(costRaw) : null, stockRaw = f.elements.stock.value.trim(), stock = stockRaw === '' ? null : Number(stockRaw);
      if (name.length < 2) { st.textContent = 'Informe o nome do produto.'; return; }
      if (!Number.isFinite(price) || price < 0) { st.textContent = 'Informe o preço de venda.'; return; }
      if (costRaw && (!Number.isFinite(cost) || cost < 0)) { st.textContent = 'Preço de custo inválido.'; return; }
      if (stock != null && !Number.isInteger(stock)) { st.textContent = 'Estoque: use um número inteiro (ou deixe vazio).'; return; }
      if (barcode && !/^[!-~]{3,64}$/.test(barcode)) { st.textContent = 'Código de barras inválido (sem espaços, de 3 a 64 caracteres).'; return; }
      try {
        const askVariant = f.elements.ask_variant.checked;
        const body = { name, price_cents: price, cost_cents: cost, stock_qty: askVariant ? null : stock, ask_variant: askVariant }; if (!initial.generated_barcode) body.barcode = barcode;
        const p = await api(editing ? '/store/products/' + initial.id : '/store/products', editing ? 'PATCH' : 'POST', body);
        $('editorDialog').close(); feedback(`Produto ${editing ? 'atualizado' : 'cadastrado'}: ${p.name} · ${brl(p.price_cents)}.`);
        if (onSaved) onSaved(p);
      } catch (err) { st.textContent = err.message; }
    };
  }

  // ---------------- Código de barras e etiquetas ----------------
  // EAN-13 para códigos de 13 dígitos válidos (os gerados pelo sistema); Code 128 para os demais.
  const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
  const EAN_P = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  const C128 = '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'.split(' ');
  const validEan13 = c => /^\d{13}$/.test(c) && Number(c[12]) === (10 - (c.slice(0, 12).split('').reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0) % 10)) % 10;
  function barcodeModules(code) {
    if (validEan13(code)) {
      const d = code.split('').map(Number), par = EAN_P[d[0]];
      let bits = '101'; for (let i = 1; i <= 6; i++) bits += (par[i - 1] === 'L' ? EAN_L : EAN_G)[d[i]];
      bits += '01010'; for (let i = 7; i <= 12; i++) bits += EAN_R[d[i]]; bits += '101';
      return { bits, ean: true };
    }
    const vals = [104, ...[...code].map(ch => ch.charCodeAt(0) - 32)];
    vals.push(vals.reduce((a, v, i) => a + v * (i || 1), 0) % 103, 106);
    let bits = ''; for (const v of vals) [...C128[v]].forEach((w, i) => { bits += (i % 2 ? '0' : '1').repeat(Number(w)); });
    return { bits, ean: false };
  }
  function barcodeSvg(code, height = 50) {
    const { bits, ean } = barcodeModules(code), quiet = ean ? 9 : 10, w = bits.length + quiet * 2;
    let rects = '', x = 0;
    while (x < bits.length) { if (bits[x] === '1') { let e = x; while (bits[e] === '1') e++; rects += `<rect x="${x + quiet}" y="0" width="${e - x}" height="${height}"/>`; x = e; } else x++; }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges" class="bc">${rects}</svg>`;
  }
  // Imprime etiquetas de um ou vários produtos na mesma página: folha A4 (3 colunas) ou impressora de etiquetas
  // (uma por página, 50×30 mm). Na A4 dá para pular as posições já usadas de uma folha aproveitada.
  // items: [{ p: produto, n: quantidade }]
  function printLabelSheet(items, title) {
    items = items.filter(x => x.p?.barcode && x.n > 0).map(x => ({ p: x.p, n: Math.max(1, Math.min(500, x.n | 0)) }));
    if (!items.length) { feedback('Nenhuma etiqueta para imprimir (produto sem código de barras?).', true); return false; }
    const total = items.reduce((a, x) => a + x.n, 0);
    if (total > 1500) { feedback('No máximo 1.500 etiquetas por vez.', true); return false; }
    const w = window.open('', '_blank'); if (!w) { feedback('Libere pop-ups para imprimir as etiquetas.', true); return false; }
    const label = p => `<div class="lb"><div class="nm">${esc(p.name)}</div><div class="pr">${brl(p.price_cents)}</div>${barcodeSvg(p.barcode)}<div class="cd">${esc(p.barcode)}</div></div>`;
    const labels = items.map(x => label(x.p).repeat(x.n)).join('');
    const name = title || (items.length === 1 ? items[0].p.name : `${items.length} produtos`);
    w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Etiquetas · ${esc(name)}</title><style id="pg"></style><style>
      *{box-sizing:border-box}body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff}
      .bar{padding:10px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #ddd;font-size:14px}.bar button{font:inherit;padding:8px 14px;cursor:pointer}.bar input[type=number]{width:60px;font:inherit;padding:4px}
      .lb{display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;text-align:center;break-inside:avoid;page-break-inside:avoid}
      .nm{font-size:10pt;font-weight:700;line-height:1.15;max-height:2.3em;overflow:hidden;width:100%}.pr{font-size:13pt;font-weight:700;margin:1mm 0}.bc{width:100%;height:12mm;fill:#000}.cd{font-size:8pt;letter-spacing:.5px}
      body.a4 .sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:0}body.a4 .lb{height:33.9mm;padding:2mm 4mm;border:1px dashed #ccc}body.a4 .skip{height:33.9mm;border:1px dashed #eee;background:repeating-linear-gradient(45deg,#fafafa 0 6px,#f0f0f0 6px 12px)}
      body.th .lb{width:50mm;height:30mm;padding:1.5mm 2mm;page-break-after:always}body.th .bc{height:10mm}body.th .skip,body.th .askip{display:none}
      @media print{.bar{display:none}body.a4 .lb{border-color:transparent}body.a4 .skip{border-color:transparent;background:none}}
    </style></head><body class="a4"><div class="bar"><b>${total} etiqueta(s) · ${esc(name)}</b>
      <label><input type="radio" name="fmt" value="a4" checked> Folha A4 (3 por linha)</label><label><input type="radio" name="fmt" value="th"> Impressora de etiquetas 50×30 mm</label>
      <label class="askip">Pular <input type="number" id="skip" min="0" max="80" value="0"> posições já usadas da folha</label>
      <button onclick="print()">Imprimir</button></div><div class="sheet"><span id="skips" style="display:contents"></span>${labels}</div>
      <script>const pg=document.getElementById('pg');const set=v=>{document.body.className=v;pg.textContent=v==='th'?'@page{size:50mm 30mm;margin:0}':'@page{size:A4;margin:10mm 7mm}'};document.querySelectorAll('[name=fmt]').forEach(r=>r.onchange=()=>set(r.value));set('a4');
      const sk=document.getElementById('skip');sk.oninput=()=>{const n=Math.max(0,Math.min(80,parseInt(sk.value,10)||0));document.getElementById('skips').innerHTML='<div class="skip"></div>'.repeat(n)};<\/script></body></html>`);
    w.document.close();
    return true;
  }
  const printLabels = (p, count) => printLabelSheet([{ p, n: count }]);
  const queueLabels = async (p, n) => {
    try { await api('/store/labels', 'POST', { product_id: p.id, add: n }); feedback(`${n} etiqueta(s) de ${p.name} na fila. Imprima pela aba "Etiquetas".`); return true; }
    catch (err) { feedback(err.message, true); return false; }
  };
  // Escolha de etiquetas ao cadastrar ou dar entrada: nenhuma, 1 só (produto fixo na loja) ou uma por unidade;
  // e imprimir agora ou juntar na fila (para não gastar uma folha só com este produto). A escolha fica lembrada.
  const LAB_KEY = 'fp_label_choice';
  const savedLab = () => { try { return JSON.parse(localStorage.getItem(LAB_KEY) || 'null'); } catch { return null; } };
  function labelChoiceHtml(defaultHow = 'none') {
    const s = savedLab(), how = s?.how || defaultHow, queue = !!s?.queue;
    const opt = (v, t) => `<label><input type="radio" name="lab_how" value="${v}"${how === v ? ' checked' : ''}> ${t}</label>`;
    return `<fieldset class="fs-labchoice"><legend>Etiquetas</legend>${opt('none', 'Não imprimir')}${opt('one', '1 etiqueta só <small>(o produto fica fixo na loja com o código; vende pela quantidade)</small>')}${opt('each', '1 etiqueta por unidade')}
      <label class="fs-check fs-labqueue"><input type="checkbox" name="lab_queue"${queue ? ' checked' : ''}> Juntar na fila e imprimir depois com outros produtos <small>(aba "Etiquetas")</small></label></fieldset>`;
  }
  // Depois de salvar: imprime ou põe na fila conforme a escolha. n = unidades que chegaram.
  async function applyLabelChoice(form, p, n) {
    const how = form.querySelector('[name=lab_how]:checked')?.value || 'none', queue = !!form.querySelector('[name=lab_queue]')?.checked;
    try { localStorage.setItem(LAB_KEY, JSON.stringify({ how, queue })); } catch {}
    if (how === 'none' || !p?.barcode) return;
    const qty = how === 'one' ? 1 : Math.max(0, n | 0); if (!qty) return;
    if (queue) await queueLabels(p, qty); else printLabels(p, qty);
  }
  function labelsDialog(p, defaultQty, title) {
    openDialog(`${header(title || 'Imprimir etiquetas')}<form id="fsLab"><p class="nv-help"><b>${esc(p.name)}</b> · ${brl(p.price_cents)} · código ${esc(p.barcode)}${p.stock_qty != null ? ` · estoque ${p.stock_qty}` : ''}</p>
      <label class="nv-field">Quantas etiquetas?<input name="n" inputmode="numeric" value="${defaultQty || 1}"></label>
      <p class="nv-help">Vários produtos iguais com o mesmo código? Uma etiqueta basta: deixe o produto fixo na loja e venda pela quantidade.</p>
      <div class="fs-row"><button class="nv-button">${FPIcon('printer')}Imprimir agora</button><button type="button" class="nv-button secondary" id="fsLabQueue">${FPIcon('tag')}Pôr na fila (imprimir junto com outros)</button></div></form>`);
    const qty = () => Math.max(1, Math.min(500, Number($('fsLab').elements.n.value) || 1));
    $('fsLab').onsubmit = e => { e.preventDefault(); printLabels(p, qty()); };
    $('fsLabQueue').onclick = async () => { if (await queueLabels(p, qty())) $('editorDialog').close(); };
  }

  // Fila de etiquetas: escolhe produtos e quantidades e imprime tudo na mesma folha.
  async function labelsTab(box) {
    let rows = []; try { rows = await api('/store/labels'); } catch (err) { box.textContent = err.message; return; }
    const sel = new Set(rows.map(r => r.id));
    box.innerHTML = `<p class="nv-help">Junte etiquetas de vários produtos e imprima tudo numa folha só. Produtos entram aqui pela opção "Juntar na fila" ao cadastrar, pelo botão "Etiquetas" da lista ou bipando/buscando abaixo.</p>
      <div class="fs-sugg"><label class="nv-field">Adicionar produto<input id="fsLbQ" placeholder="Bipe o código ou digite o nome" autocomplete="off" enterkeyhint="go"></label><div id="fsLbSug" class="fs-results fs-drop"></div></div>
      <div id="fsLbList" class="nv-list"></div><div id="fsLbFoot"></div>`;
    const list = $('fsLbList'), foot = $('fsLbFoot'), q = $('fsLbQ'), sug = $('fsLbSug');
    const reload = async () => { try { rows = await api('/store/labels'); } catch (err) { feedback(err.message, true); return; } rows.forEach(r => { if (!known.has(r.id)) { sel.add(r.id); known.add(r.id); } }); draw(); };
    const known = new Set(rows.map(r => r.id));
    const setQty = async (r, n) => { try { const u = await api('/store/labels', 'POST', { product_id: r.id, qty: n }); Object.assign(r, u); } catch (err) { feedback(err.message, true); } };
    const draw = () => {
      if (!list.isConnected) return;
      rows = rows.filter(r => r.labels_pending > 0);
      list.innerHTML = rows.map(r => `<div class="fs-sale fs-lbrow" data-lb="${r.id}"><label class="fs-lbchk"><input type="checkbox" data-lb-sel${sel.has(r.id) ? ' checked' : ''} aria-label="Imprimir ${esc(r.name)}"></label>
        <div class="fs-grow"><b>${esc(r.name)}</b><br><small>${brl(r.price_cents)} · ${esc(r.barcode)}${r.stock_qty != null ? ` · estoque ${r.stock_qty}` : ''}</small></div>
        <span class="fs-qq"><button type="button" data-lb-q="-1" aria-label="Menos etiquetas de ${esc(r.name)}">−</button><input class="fs-qn" type="number" inputmode="numeric" min="1" max="500" value="${r.labels_pending}" aria-label="Etiquetas de ${esc(r.name)}"><button type="button" data-lb-q="1" aria-label="Mais etiquetas de ${esc(r.name)}">+</button></span>
        <button type="button" class="fs-cart-del" data-lb-del aria-label="Tirar ${esc(r.name)} da fila">${FPIcon('x')}</button></div>`).join('') || '<p class="nv-help">A fila está vazia.</p>';
      const chosen = rows.filter(r => sel.has(r.id)), n = chosen.reduce((a, r) => a + r.labels_pending, 0);
      foot.innerHTML = rows.length ? `<div class="fs-row fs-lbfoot"><label class="fs-check fs-grow"><input type="checkbox" id="fsLbAll"${chosen.length === rows.length ? ' checked' : ''}> Todos</label>
        <b>${n} etiqueta(s) de ${chosen.length} produto(s)${n ? ` · cerca de ${Math.ceil(n / 24)} folha(s) A4` : ''}</b><button type="button" class="nv-button" id="fsLbPrint"${n ? '' : ' disabled'}>${FPIcon('printer')}Imprimir selecionadas</button></div><div id="fsLbDone"></div>` : '';
      list.querySelectorAll('[data-lb]').forEach(el => {
        const r = rows.find(x => x.id === el.dataset.lb), inp = el.querySelector('.fs-qn');
        el.querySelector('[data-lb-sel]').onchange = e => { e.target.checked ? sel.add(r.id) : sel.delete(r.id); draw(); };
        el.querySelectorAll('[data-lb-q]').forEach(b => b.onclick = async () => { const v = Math.max(1, Math.min(500, r.labels_pending + Number(b.dataset.lbQ))); if (v !== r.labels_pending) { await setQty(r, v); draw(); } });
        inp.onchange = async () => { const v = Math.max(1, Math.min(500, Number(inp.value) || 1)); await setQty(r, v); draw(); };
        el.querySelector('[data-lb-del]').onclick = async () => { await setQty(r, 0); sel.delete(r.id); draw(); };
      });
      if ($('fsLbAll')) $('fsLbAll').onchange = e => { rows.forEach(r => e.target.checked ? sel.add(r.id) : sel.delete(r.id)); draw(); };
      if ($('fsLbPrint')) $('fsLbPrint').onclick = () => {
        const items = rows.filter(r => sel.has(r.id)); if (!printLabelSheet(items.map(r => ({ p: r, n: r.labels_pending })))) return;
        $('fsLbDone').innerHTML = `<div class="fs-last"><div>As etiquetas abriram em outra janela. <b>Saíram certinho?</b></div><div class="fs-actions"><button type="button" class="nv-button" id="fsLbClear">Sim, tirar da fila</button><button type="button" class="nv-button secondary" id="fsLbKeep">Não, manter na fila</button></div></div>`;
        $('fsLbClear').onclick = async () => { try { await api('/store/labels/printed', 'POST', { product_ids: items.map(r => r.id) }); feedback('Etiquetas impressas saíram da fila.'); items.forEach(r => { r.labels_pending = 0; sel.delete(r.id); }); draw(); } catch (err) { feedback(err.message, true); } };
        $('fsLbKeep').onclick = () => { $('fsLbDone').innerHTML = ''; };
      };
    };
    const add = async p => { if (!p.barcode) { feedback(`${p.name} não tem código de barras. Use "Gerar códigos" ou edite o produto.`, true); return; }
      try { const u = await api('/store/labels', 'POST', { product_id: p.id, add: 1 }); beep(true); sel.add(u.id); known.add(u.id); q.value = ''; sug.innerHTML = ''; await reload(); q.focus(); } catch (err) { feedback(err.message, true); beep(false); } };
    let timer, found = [];
    const search = async () => { const t = q.value.trim(); if (t.length < 2) { sug.innerHTML = ''; return []; }
      try { found = (await api('/store/products?q=' + encodeURIComponent(t))).filter(p => p.barcode).slice(0, 8); } catch { return []; }
      if (q.value.trim() !== t) return found;
      sug.innerHTML = found.map((p, i) => `<button type="button" data-lb-add="${i}"><b>${esc(p.name)}</b> <small>${brl(p.price_cents)} · ${esc(p.barcode)}</small></button>`).join('') || '<p class="nv-help">Nenhum produto com código de barras encontrado.</p>';
      sug.querySelectorAll('[data-lb-add]').forEach(b => b.onclick = () => add(found[Number(b.dataset.lbAdd)])); return found; };
    q.oninput = () => { clearTimeout(timer); timer = setTimeout(search, 220); };
    q.onkeydown = async e => { if (e.key !== 'Enter') return; e.preventDefault(); clearTimeout(timer); const t = q.value.trim(); if (!t) return;
      if (looksLikeCode(t) && !/\s/.test(t)) { try { return add(await api('/store/products/barcode/' + encodeURIComponent(t))); } catch (err) { if (err.status !== 404) { feedback(err.message, true); return; } } }
      const r = await search(); if (r.length === 1) add(r[0]); };
    draw(); q.focus();
  }

  // Histórico (log) do estoque: toda entrada, venda, cancelamento, ajuste, correção, exclusão e reativação.
  let logFilter = null; // { product_id, name } quando aberto pelo botão "Histórico" de um produto
  const LOG_KIND = { entry: 'Entrada', sale: 'Venda', cancel: 'Venda cancelada', adjust: 'Ajuste', edit: 'Correção no cadastro', restore: 'Reativado', delete: 'Excluído' };
  async function logTab(box) {
    const today = new Date(), ymdLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const from0 = new Date(today); from0.setDate(from0.getDate() - 30);
    box.innerHTML = `${logFilter ? `<p class="fs-picked"><span>Só o produto <b>${esc(logFilter.name)}</b></span><button type="button" class="nv-button secondary fs-small" id="fsLogAll">Ver todos</button></p>` : ''}
      <form id="fsLogF" class="fs-row fs-logf" autocomplete="off">${logFilter ? '' : '<label class="nv-field fs-grow">Produto<input name="q" type="search" placeholder="Nome, modelo ou código"></label>'}
        <label class="nv-field">Tipo<select name="kind"><option value="">Todos</option>${Object.entries(LOG_KIND).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="nv-field">De<input name="from" type="date" value="${logFilter ? '' : ymdLocal(from0)}"></label><label class="nv-field">Até<input name="to" type="date"></label></form>
      <div class="fs-logwrap"><table class="fs-log"><thead><tr><th>Quando</th><th>Produto</th><th>Movimento</th><th class="n">Qtd.</th><th class="n">Estoque</th><th>Quem</th></tr></thead><tbody id="fsLogBody"></tbody></table></div>
      <p class="nv-help" id="fsLogInfo"></p><button type="button" class="nv-button secondary" id="fsLogMore" hidden>Carregar mais</button>`;
    if ($('fsLogAll')) $('fsLogAll').onclick = () => { logFilter = null; logTab(box); };
    const f = $('fsLogF'), body = $('fsLogBody'); let last = null, timer, seq = 0;
    const qs = () => { const p = new URLSearchParams(); if (logFilter) p.set('product_id', logFilter.product_id); const t = f.elements.q?.value.trim(); if (t) p.set('q', t);
      ['kind', 'from', 'to'].forEach(k => { if (f.elements[k].value) p.set(k, f.elements[k].value); }); return p; };
    const n = v => v == null ? '—' : String(v);
    const row = m => { const when = new Date(m.created_at);
      const what = [m.kind === 'sale' || m.kind === 'cancel' ? (m.sale_number ? `venda #${m.sale_number}` : '') : '', m.unit_cost_cents != null && m.kind === 'entry' ? `custo ${brl(m.unit_cost_cents)} cada` : '', m.note && m.kind !== 'cancel' ? esc(m.note) : m.kind === 'cancel' && m.note ? esc(m.note.replace(/^Venda cancelada: /, 'motivo: ')) : ''].filter(Boolean).join(' · ');
      return `<tr><td>${dmy(m.created_at)}<br><small>${hhmm(m.created_at)}</small></td><td><b>${esc(m.name)}</b>${m.variant ? ` <span class="fs-var">${esc(m.variant)}</span>` : ''}${m.device_model ? ` <small>${esc(m.device_model)}</small>` : ''}${m.product_kind === 'part' ? ' <span class="fs-tag-svc">peça</span>' : ''}</td>
        <td>${LOG_KIND[m.kind] || m.kind}${what ? `<br><small>${what}</small>` : ''}</td><td class="n"><b class="${m.quantity < 0 ? 'fs-neg' : m.quantity > 0 ? 'fs-pos' : ''}">${m.quantity > 0 ? '+' : ''}${m.quantity}</b></td>
        <td class="n">${n(m.stock_before)} → <b>${n(m.stock_after)}</b></td><td>${esc(m.who || '—')}</td></tr>`; };
    const load = async more => {
      const my = ++seq, p = qs(); if (more && last) p.set('before', last);
      let r; try { r = await api('/store/stock/log?' + p); } catch (err) { $('fsLogInfo').textContent = err.message; return; }
      if (my !== seq || !body.isConnected) return;
      if (!more) body.innerHTML = '';
      body.insertAdjacentHTML('beforeend', r.rows.map(row).join(''));
      last = r.rows.length ? r.rows[r.rows.length - 1].created_at : last;
      $('fsLogMore').hidden = !r.more;
      $('fsLogInfo').textContent = body.children.length ? `${body.children.length} movimento(s)${r.more ? ' (há mais)' : ''}` : 'Nenhum movimento neste período.';
    };
    f.oninput = () => { clearTimeout(timer); timer = setTimeout(() => load(false), 250); };
    f.onsubmit = e => { e.preventDefault(); load(false); };
    $('fsLogMore').onclick = () => load(true);
    load(false);
  }
  // Entrada de estoque (compra). Produto com modelos: informa o modelo. O custo entra no relatório de compras.
  function stockDialog(p, onDone, variantName = '') {
    openDialog(`${header('Entrada de estoque')}<form id="fsStock" autocomplete="off"><p class="nv-help"><b>${esc(p.name)}</b>${p.ask_variant ? '' : ` · estoque atual: <b>${p.stock_qty ?? 'não controla'}</b>`}${p.restock_pending ? ` · vendido e não reposto: <b>${p.restock_pending}</b>` : ''}</p>
      ${p.ask_variant ? `<label class="nv-field">Modelo<input name="m" maxlength="80" required list="fsStockVars" value="${esc(variantName)}" placeholder="Ex.: Galaxy A12"></label><datalist id="fsStockVars"></datalist>` : ''}
      <div class="fs-row"><label class="nv-field fs-grow">Quantidade que chegou<input name="n" inputmode="numeric" required placeholder="Ex.: 10"></label>
      <label class="nv-field fs-grow">Custo de cada (compra)<input name="cost" inputmode="decimal" value="${p.cost_cents != null ? centsText(p.cost_cents) : ''}" placeholder="0,00"></label></div>
      <small class="nv-help">Para corrigir para menos, use número negativo (ex.: −2). O custo entra no total de compras de estoque do relatório.</small>
      ${p.barcode ? labelChoiceHtml(p.generated_barcode && !p.ask_variant ? 'each' : 'none') : ''}
      <button class="nv-button">Somar ao estoque</button><p role="status" class="nv-help"></p></form>`);
    const f = $('fsStock');
    if (p.ask_variant) { api(`/store/products/${p.id}/variants`).then(rows => { const dl = $('fsStockVars'); if (dl) dl.innerHTML = rows.map(v => `<option value="${esc(v.name)}">`).join(''); }).catch(() => {}); (variantName ? f.elements.n : f.elements.m).focus(); }
    else f.elements.n.focus();
    f.onsubmit = async e => {
      e.preventDefault(); const n = Number(f.elements.n.value.replace('−', '-').trim()), st = f.querySelector('[role=status]');
      if (!Number.isInteger(n) || n === 0) { st.textContent = 'Informe a quantidade (número inteiro).'; return; }
      const costRaw = f.elements.cost.value.trim(), cost = costRaw ? parseMoney(costRaw) : null;
      if (costRaw && (!Number.isFinite(cost) || cost < 0)) { st.textContent = 'Custo inválido.'; return; }
      const body = { add: n, unit_cost_cents: cost }; if (p.ask_variant) body.variant_name = f.elements.m.value.trim();
      if (p.ask_variant && !body.variant_name) { st.textContent = 'Informe o modelo.'; return; }
      try { const r = await api(`/store/products/${p.id}/stock`, 'POST', body); feedback(r.variant ? `Estoque de ${r.name} ${r.variant.name}: ${r.variant.stock_qty}.` : `Estoque de ${r.name}: ${r.stock_qty}.`); $('editorDialog').close(); if (n > 0) await applyLabelChoice(f, r, n); onDone?.(); }
      catch (err) { st.textContent = err.message; }
    };
  }
  // Modelos de um produto (película, capinha): estoque e reposição por modelo.
  async function variantsDialog(p, onBack) {
    let rows = []; try { rows = await api(`/store/products/${p.id}/variants`); } catch (err) { feedback(err.message, true); return; }
    openDialog(`${header('Modelos · ' + esc(p.name))}<div class="fs-row"><button type="button" class="nv-button" id="fsVarAdd">+ Entrada de estoque</button><button type="button" class="nv-button secondary" id="fsVarBack">${FPIcon('back')}Produtos</button></div>
      <p class="nv-help">Os modelos aparecem aqui ao vender ou ao dar entrada no estoque. Os mais vendidos são sugeridos primeiro no caixa.</p>
      <div class="nv-list">${rows.map(v => `<div class="fs-sale"><div><b>${esc(v.name)}</b><br><small>Estoque: <b class="${v.stock_qty != null && v.stock_qty <= 0 ? 'fs-neg' : ''}">${v.stock_qty ?? '—'}</b> · vendidas: ${v.sold_count}${v.restock_pending ? ` · <span class="fs-neg">repor ${v.restock_pending}</span>` : ''}</small></div>
        <div class="fs-sale-end"><button type="button" class="nv-button secondary fs-small" data-fs-vin="${esc(v.name)}">+ Estoque</button><button type="button" class="nv-button secondary fs-small" data-fs-vdel="${v.id}">Excluir</button></div></div>`).join('') || '<p class="nv-help">Nenhum modelo ainda.</p>'}</div>`);
    const again = () => variantsDialog(p, onBack);
    $('fsVarAdd').onclick = () => stockDialog(p, again); $('fsVarBack').onclick = onBack;
    document.querySelectorAll('[data-fs-vin]').forEach(b => b.onclick = () => stockDialog(p, again, b.dataset.fsVin));
    document.querySelectorAll('[data-fs-vdel]').forEach(b => b.onclick = async () => { if (!confirm('Tirar este modelo da lista de sugestões?')) return; try { await api(`/store/products/${p.id}/variants/${b.dataset.fsVdel}`, 'DELETE'); again(); } catch (err) { feedback(err.message, true); } });
  }
  // Reposição: o que foi vendido e ainda não teve entrada de estoque. Imprime para levar às compras.
  async function restockTab(box) {
    let rows = []; try { rows = await api('/store/stock/restock'); } catch (err) { box.textContent = err.message; return; }
    box.innerHTML = `<div class="fs-row"><p class="nv-help fs-grow">Vendido e ainda não reposto (some quando você dá entrada no estoque).</p><button type="button" class="nv-button" id="fsRestockPrint"${rows.length ? '' : ' disabled'}>${FPIcon('printer')}Imprimir lista de reposição</button></div>
      <div class="nv-list">${rows.map(r => `<div class="fs-sale"><div><b>${esc(r.name)}${r.variant ? ' · ' + esc(r.variant) : ''}</b>${r.kind === 'part' ? ' <span class="fs-tag-svc">peça</span>' : ''}<br><small>Estoque atual: ${r.stock_qty ?? '—'}${r.cost_cents != null ? ' · custo ' + brl(r.cost_cents) : ''}${r.supplier_name ? ' · fornecedor ' + esc(r.supplier_name) : ''}</small></div><div class="fs-sale-end"><b class="fs-neg">repor ${r.pending}</b></div></div>`).join('') || '<p class="nv-help">Nada para repor.</p>'}</div>`;
    if ($('fsRestockPrint')) $('fsRestockPrint').onclick = () => {
      const w = window.open('', '_blank'); if (!w) { feedback('Libere pop-ups para imprimir.', true); return; }
      const total = rows.reduce((a, r) => a + (r.cost_cents || 0) * r.pending, 0);
      w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Reposição de estoque</title><style>body{font:13px Arial,sans-serif;margin:16px}h1{font-size:18px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left}td.n,th.n{text-align:right}.ck{width:28px}.box{display:inline-block;width:12px;height:12px;border:1.5px solid #111;border-radius:2px}</style></head><body>
        <h1>Reposição de estoque · ${esc(config?.name || '')}</h1><div>${new Date().toLocaleString('pt-BR')}</div>
        <table><thead><tr><th class="ck">OK</th><th>Produto</th><th>Modelo</th><th>Fornecedor</th><th class="n">Repor</th><th class="n">Estoque atual</th><th class="n">Custo estimado</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td class="ck"><span class="box"></span></td><td>${esc(r.name)}</td><td>${esc(r.variant || '')}</td><td>${esc(r.supplier_name || '')}</td><td class="n"><b>${r.pending}</b></td><td class="n">${r.stock_qty ?? '—'}</td><td class="n">${r.cost_cents != null ? brl(r.cost_cents * r.pending) : '—'}</td></tr>`).join('')}
        </tbody></table><p><b>Total estimado: ${brl(total)}</b> (pelo custo cadastrado)</p><script>setTimeout(()=>print(),200)<\/script></body></html>`);
      w.document.close();
    };
  }

  // ---------------- Entrada rápida (cadastro e reposição em lote) ----------------
  // Bipa uma unidade e informa quantas chegaram. Código conhecido → soma ao estoque; desconhecido → cadastra com o código.
  // Digitar o nome sugere produtos já cadastrados (mesmo com estoque zerado ou excluídos), para não cadastrar de novo.
  // Bipar de novo o mesmo produto enquanto o formulário está aberto soma 1 na quantidade.
  let entryLog = []; // entradas feitas nesta tela desde que o painel abriu: { name, qty, cost_cents, isNew }
  function entryTab(box) {
    box.innerHTML = `<p class="nv-help">Bipe <b>uma</b> unidade e informe quantas chegaram. Produto novo é cadastrado com o código lido; produto já cadastrado só soma ao estoque. Sem código? Digite o nome: o sistema sugere os que já foram cadastrados.</p>
      <label class="nv-field">Produto<input id="fsEnScan" placeholder="Bipe o produto ou digite o nome" aria-label="Bipe o produto ou digite o nome" autocomplete="off" enterkeyhint="go"></label><div id="fsEnSug" class="fs-results"></div>
      <div id="fsEnForm"></div><div id="fsEnLog"></div>`;
    const scan = $('fsEnScan'), sug = $('fsEnSug'), formBox = $('fsEnForm');
    let timer, rows = [], current = null; // current: { product?, barcode } do formulário aberto
    const drawLog = () => {
      const el = $('fsEnLog'); if (!el) return;
      if (!entryLog.length) { el.innerHTML = ''; return; }
      const units = entryLog.reduce((s, e) => s + e.qty, 0), withCost = entryLog.filter(e => e.cost_cents != null), total = withCost.reduce((s, e) => s + e.qty * e.cost_cents, 0);
      el.innerHTML = `<div class="fs-row" style="margin-top:14px"><b class="fs-grow">Nesta entrada: ${entryLog.length} produto(s) · ${units} unidade(s)${withCost.length ? ' · custo ' + brl(total) : ''}</b><button type="button" class="nv-button secondary fs-small" id="fsEnClear">Limpar lista</button></div>
        <div class="nv-list">${entryLog.map(e => `<div class="fs-sale"><div><b>${esc(e.name)}</b>${e.isNew ? ' <span class="fs-tag-svc">novo</span>' : ''}<br><small>${e.cost_cents != null ? 'custo ' + brl(e.cost_cents) + ' cada' : 'sem custo'}${e.stock != null ? ' · estoque agora ' + e.stock : ''}</small></div><div class="fs-sale-end"><b>+${e.qty}</b></div></div>`).join('')}</div>`;
      $('fsEnClear').onclick = () => { entryLog = []; drawLog(); scan.focus(); };
    };
    const done = (name, qty, cost, isNew, stock) => {
      entryLog.unshift({ name, qty, cost_cents: cost, isNew, stock }); beep(true);
      feedback(`${isNew ? 'Cadastrado' : 'Entrada'}: ${qty}× ${name}${stock != null ? ' · estoque ' + stock : ''}.`);
      current = null; formBox.innerHTML = ''; sug.innerHTML = ''; scan.value = ''; drawLog(); scan.focus();
    };
    const cancel = () => { current = null; formBox.innerHTML = ''; scan.value = ''; sug.innerHTML = ''; scan.focus(); };
    // Leitor bipado com um formulário aberto: o mesmo produto soma 1; outro produto pede para terminar antes.
    const scannedWhileOpen = code => {
      const qty = formBox.querySelector('[name=n]'), st = formBox.querySelector('[role=status]');
      if (current && (current.barcode === code || current.product?.barcode === code) && qty) { qty.value = String((Number(qty.value) || 0) + 1); beep(true); if (st) st.textContent = ''; return true; }
      if (st) st.textContent = `Termine este produto (botão verde) ou cancele antes de bipar outro. Código lido: ${code}`; beep(false); return true;
    };
    // Quantidade nunca tem 8+ caracteres: é o leitor bipando um produto com o cursor neste campo.
    // O que estava digitado antes da rajada do leitor (teclas a menos de 60 ms) é a quantidade a manter.
    const trackQty = input => {
      let prev = input.value, stable = input.value, lastT = 0;
      input.addEventListener('input', () => { const now = Date.now(); if (now - lastT > 60) stable = prev; prev = input.value; lastT = now; });
      input.onkeydown = e => {
        if (e.key !== 'Enter') return; const v = input.value.trim();
        if (!(v.length >= 8 && /^[!-~]+$/.test(v) && /\d/.test(v))) return;
        e.preventDefault();
        const known = [current?.barcode, current?.product?.barcode].find(c => c && v.endsWith(c));
        const code = known || (stable && v.startsWith(stable) ? v.slice(stable.length) : v);
        const before = known ? v.slice(0, v.length - known.length) : stable;
        input.value = /^-?\d{0,5}$/.test(before.trim()) ? before.trim() : ''; prev = stable = input.value;
        scannedWhileOpen(known || code);
      };
    };
    const moneyOrNull = (raw, label, st) => { const s = raw.trim(); if (!s) return null; const v = parseMoney(s); if (!Number.isFinite(v) || v < 0) { st.textContent = label + ' inválido.'; return undefined; } return v; };

    // Produto já cadastrado: quantidade + custo (+ preço de venda, se mudou). Código bipado vai junto quando o produto não tinha.
    const stockForm = (p, code = '') => {
      current = { product: p, barcode: code || p.barcode || '' }; sug.innerHTML = '';
      const attach = code && code !== p.barcode;
      formBox.innerHTML = `<form id="fsEnStock" class="fs-picked" style="display:block;margin-top:10px" autocomplete="off">
        <p><b>${esc(p.name)}</b>${p.ask_variant ? '' : ` · estoque atual: <b>${p.stock_qty ?? 'não controla'}</b>`}${p.barcode ? `<br><small>${esc(p.barcode)}</small>` : ''}</p>
        ${attach ? `<p class="nv-help fs-warn">${p.barcode ? `Este produto tem o código <b>${esc(p.barcode)}</b>. Ao salvar, passa a usar <b>${esc(code)}</b>.` : `O código <b>${esc(code)}</b> será salvo neste produto: da próxima vez o leitor já reconhece.`}</p>` : ''}
        ${p.ask_variant ? `<label class="nv-field">Modelo<input name="m" maxlength="80" required list="fsEnVars" placeholder="Ex.: Galaxy A12"></label><datalist id="fsEnVars"></datalist>` : ''}
        <div class="fs-row"><label class="nv-field" style="flex:0 0 170px">Quantidade que chegou<input name="n" inputmode="numeric" required placeholder="Ex.: 30"></label>
        <label class="nv-field fs-grow">Custo de cada<input name="cost" inputmode="decimal" value="${p.cost_cents != null ? centsText(p.cost_cents) : ''}" placeholder="0,00"></label>
        <label class="nv-field fs-grow">Preço de venda<input name="price" inputmode="decimal" value="${centsText(p.price_cents)}"${basic() ? ' readonly' : ''}></label></div>
        ${p.barcode || attach ? labelChoiceHtml(p.generated_barcode && !p.ask_variant ? 'each' : 'none') : ''}
        <div class="fs-row"><button class="nv-button">Somar ao estoque</button><button type="button" class="nv-button secondary" id="fsEnCancel">Cancelar</button></div><p role="status" class="nv-help"></p></form>`;
      const f = $('fsEnStock'), st = f.querySelector('[role=status]');
      $('fsEnCancel').onclick = cancel; trackQty(f.elements.n);
      if (p.ask_variant) { api(`/store/products/${p.id}/variants`).then(vs => { const dl = $('fsEnVars'); if (dl) dl.innerHTML = vs.map(v => `<option value="${esc(v.name)}">`).join(''); }).catch(() => {}); f.elements.m.focus(); }
      else f.elements.n.focus();
      f.onsubmit = async e => {
        e.preventDefault(); st.textContent = '';
        const n = Number(f.elements.n.value.replace('−', '-').trim());
        if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 99999) { st.textContent = 'Informe a quantidade (número inteiro).'; return; }
        const cost = moneyOrNull(f.elements.cost.value, 'Custo', st); if (cost === undefined) return;
        const price = moneyOrNull(f.elements.price.value, 'Preço de venda', st); if (price === undefined) return;
        const variant = p.ask_variant ? f.elements.m.value.trim() : ''; if (p.ask_variant && !variant) { st.textContent = 'Informe o modelo.'; return; }
        const btn = f.querySelector('button'); btn.disabled = true;
        try {
          const patch = {}; if (attach) patch.barcode = code; if (price != null && price !== p.price_cents) patch.price_cents = price;
          let prod = p; if (Object.keys(patch).length) prod = await api('/store/products/' + p.id, 'PATCH', patch);
          const body = { add: n, unit_cost_cents: cost }; if (variant) body.variant_name = variant;
          const r = await api(`/store/products/${p.id}/stock`, 'POST', body);
          if (n > 0) await applyLabelChoice(f, { ...prod, ...r }, n);
          done(p.name + (variant ? ' ' + variant : ''), n, cost, false, r.variant ? r.variant.stock_qty : r.stock_qty);
        } catch (err) { st.textContent = err.message; btn.disabled = false; }
      };
    };

    // Produto novo: o nome digitado sugere cadastros parecidos (evita duplicar); tocar num deles vira entrada nele.
    const newForm = (init = {}) => {
      current = { barcode: init.barcode || '' }; sug.innerHTML = '';
      formBox.innerHTML = `<form id="fsEnNew" class="fs-picked" style="display:block;margin-top:10px" autocomplete="off">
        <p><b>Produto novo</b>${init.barcode ? ` · código <b>${esc(init.barcode)}</b> ainda não cadastrado` : ''}</p>
        <label class="nv-field">Código de barras<input name="barcode" maxlength="64" value="${esc(init.barcode || '')}" placeholder="Bipe a embalagem (opcional)"></label>
        <div class="fs-sugg"><label class="nv-field">Nome do produto<input name="name" maxlength="120" required value="${esc(init.name || '')}" placeholder="Ex.: Cabo USB Tipo-C 1m Kaidi"></label><div id="fsEnSame" class="fs-results"></div></div>
        <div class="fs-row"><label class="nv-field" style="flex:0 0 170px">Quantidade que chegou<input name="n" inputmode="numeric" required placeholder="Ex.: 30"></label>
        <label class="nv-field fs-grow">Custo de cada<input name="cost" inputmode="decimal" placeholder="0,00"></label>
        <label class="nv-field fs-grow">Preço de venda<input name="price" inputmode="decimal" required placeholder="0,00"></label></div>
        <p class="nv-help" id="fsEnMargin"></p>
        ${labelChoiceHtml('none')}
        <div class="fs-row"><button class="nv-button">Cadastrar e somar ao estoque</button><button type="button" class="nv-button secondary" id="fsEnCancel">Cancelar</button></div><p role="status" class="nv-help"></p></form>`;
      const f = $('fsEnNew'), st = f.querySelector('[role=status]'), same = $('fsEnSame');
      $('fsEnCancel').onclick = cancel; trackQty(f.elements.n);
      f.elements.barcode.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); current.barcode = f.elements.barcode.value.trim(); f.elements.name.focus(); } };
      f.elements.barcode.oninput = () => { current.barcode = f.elements.barcode.value.trim(); };
      let t2;
      f.elements.name.oninput = () => { clearTimeout(t2); t2 = setTimeout(async () => {
        const t = f.elements.name.value.trim(); if (t.length < 3) { same.innerHTML = ''; return; }
        let found = []; try { found = await api('/store/products?include_deleted=1&q=' + encodeURIComponent(t)); } catch { return; }
        if (!same.isConnected || f.elements.name.value.trim() !== t) return;
        found = found.slice(0, 6);
        same.innerHTML = found.length ? `<small class="nv-help">Já cadastrado? Toque para dar entrada nele em vez de criar outro:</small>` + found.map((p, i) => `<button type="button" data-en-same="${i}"><b>${esc(p.name)}</b> <small>${p.active ? `estoque ${p.stock_qty ?? '—'} · ${brl(p.price_cents)}` : 'excluído · reativar'}${p.barcode ? ' · ' + esc(p.barcode) : ''}</small></button>`).join('') : '';
        same.querySelectorAll('[data-en-same]').forEach(b => b.onclick = () => pick(found[Number(b.dataset.enSame)], f.elements.barcode.value.trim()));
      }, 250); };
      const showMargin = () => { const p = parseMoney(f.elements.price.value), c = parseMoney(f.elements.cost.value); const m = Number.isFinite(p) && Number.isFinite(c) ? margin(p, c) : null;
        $('fsEnMargin').innerHTML = m == null ? '' : `Lucro por unidade: <b class="${p - c < 0 ? 'fs-neg' : 'fs-pos'}">${brl(p - c)}</b> (${m}% do preço)`; };
      f.elements.price.oninput = showMargin; f.elements.cost.oninput = showMargin;
      (init.barcode || !init.name ? (init.barcode ? f.elements.name : f.elements.barcode) : f.elements.n).focus();
      if (init.name) f.elements.name.oninput();
      f.onsubmit = async e => {
        e.preventDefault(); st.textContent = '';
        const name = f.elements.name.value.trim(), barcode = f.elements.barcode.value.trim(), n = Number(f.elements.n.value.trim());
        if (name.length < 2) { st.textContent = 'Informe o nome do produto.'; return; }
        if (barcode && !/^[!-~]{3,64}$/.test(barcode)) { st.textContent = 'Código de barras inválido (sem espaços, de 3 a 64 caracteres).'; return; }
        if (!Number.isInteger(n) || n < 0 || n > 99999) { st.textContent = 'Informe a quantidade que chegou (número inteiro).'; return; }
        const price = parseMoney(f.elements.price.value); if (!Number.isFinite(price) || price < 0) { st.textContent = 'Informe o preço de venda.'; return; }
        const cost = moneyOrNull(f.elements.cost.value, 'Custo', st); if (cost === undefined) return;
        const btn = f.querySelector('button'); btn.disabled = true;
        try {
          const p = await api('/store/products', 'POST', { name, barcode, price_cents: price, cost_cents: cost, stock_qty: n });
          if (n > 0) await applyLabelChoice(f, p, n);
          done(p.name, n, cost, true, p.stock_qty);
        } catch (err) {
          btn.disabled = false; st.textContent = err.message;
          if (err.status === 409 && barcode) { try { const p = await api('/store/products/barcode/' + encodeURIComponent(barcode)); st.innerHTML = `Este código já é de <b>${esc(p.name)}</b>. <button type="button" class="nv-button secondary fs-small" id="fsEnUseIt">Dar entrada nele</button>`; $('fsEnUseIt').onclick = () => stockForm(p); } catch { /* fica a mensagem */ } }
        }
      };
    };

    // Escolha numa sugestão: excluído volta para a lista (com o cadastro antigo) e segue para a entrada.
    const pick = async (p, code = '') => {
      if (!p.active) {
        if (!confirm(`"${p.name}" foi excluído antes. Reativar com o cadastro antigo e dar entrada?`)) return;
        try { p = await api(`/store/products/${p.id}/restore`, 'POST', {}); } catch (err) { feedback(err.message, true); return; }
      }
      stockForm(p, code && code !== p.barcode ? code : '');
    };
    const handleCode = async code => {
      if (current) { scannedWhileOpen(code); scan.value = ''; return; }
      scan.value = ''; sug.innerHTML = '';
      try { const p = await api('/store/products/barcode/' + encodeURIComponent(code)); beep(true); stockForm(p); }
      catch (err) { if (err.status === 404) { beep(true); newForm({ barcode: code }); } else { feedback(err.message, true); beep(false); } }
    };
    const suggest = async () => {
      const t = scan.value.trim(); if (t.length < 2) { sug.innerHTML = ''; return []; }
      try { rows = (await api('/store/products?include_deleted=1&q=' + encodeURIComponent(t))).slice(0, 8); } catch (err) { sug.textContent = err.message; return []; }
      if (scan.value.trim() !== t) return rows;
      sug.innerHTML = rows.map((p, i) => `<button type="button" data-en-pick="${i}"><b>${esc(p.name)}</b> <small>${p.active ? `estoque ${p.ask_variant ? 'por modelo' : p.stock_qty ?? '—'} · ${brl(p.price_cents)}` : 'excluído · reativar'}${p.barcode ? ' · ' + esc(p.barcode) : ''}</small></button>`).join('')
        + `<button type="button" id="fsEnNewName">+ Cadastrar produto novo: <b>${esc(t)}</b></button>`;
      sug.querySelectorAll('[data-en-pick]').forEach(b => b.onclick = () => { scan.value = ''; pick(rows[Number(b.dataset.enPick)]); });
      $('fsEnNewName').onclick = () => { scan.value = ''; newForm({ name: t }); };
      return rows;
    };
    scan.oninput = () => { clearTimeout(timer); const t = scan.value.trim(); if (looksLikeCode(t) && /^\d{8,}$/.test(t)) { sug.innerHTML = ''; return; } timer = setTimeout(suggest, 220); };
    scan.onkeydown = async e => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); clearTimeout(timer); const t = scan.value.trim(); if (!t) return;
      if (looksLikeCode(t)) return handleCode(t);
      if (current) return;
      const found = await suggest(); if (found.length === 1) { scan.value = ''; pick(found[0]); }
    };
    // Cursor fora dos campos (depois de clicar num botão): a próxima tecla, inclusive do leitor, volta para o campo certo.
    const d = stockHost();
    if (!d.dataset.enKeys) {
      d.dataset.enKeys = '1';
      d.addEventListener('keydown', e => {
        const s = $('fsEnScan'); if (!s || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        ($('fsEnForm')?.querySelector('[name=n]') || s).focus();
      }, true);
    }
    drawLog(); scan.focus();
  }

  // Estoque abre como página (menu lateral "Estoque") ou como janela (botão "Estoque" dentro do Caixa).
  // Com a página na tela, tudo que "reabre o estoque" redesenha a página e fecha a janela por cima.
  let stockPage = null;
  const stockOnPage = () => !!stockPage?.isConnected;
  const stockHost = () => stockOnPage() ? stockPage : $('editorDialog');
  async function productsDialog(term = '', tab = 'list') {
    const tabs = [['list', 'Produtos'], ['entry', FPIcon('inbox') + 'Entrada rápida'], ['labels', FPIcon('tag') + 'Etiquetas'], ['parts', FPIcon('wrench') + 'Peças'], ['suppliers', FPIcon('truck') + 'Fornecedores'], ['gen', FPIcon('tag') + 'Gerar códigos'], ['restock', FPIcon('refresh') + 'Reposição'], ['log', FPIcon('receipt') + 'Histórico']];
    const body = `<div class="fs-tabs" role="tablist">${tabs.map(([k, v]) => `<button type="button" role="tab" data-ptab="${k}" aria-selected="${tab === k}">${v}</button>`).join('')}</div><div id="fsPTab"></div>`;
    if (stockOnPage()) { const d = $('editorDialog'); if (d.open) d.close(); stockPage.innerHTML = body; }
    else openDialog(header('Estoque') + body);
    stockHost().querySelectorAll('[data-ptab]').forEach(b => b.onclick = () => { if (b.dataset.ptab !== 'log') logFilter = null; productsDialog('', b.dataset.ptab); });
    const box = $('fsPTab');
    if (tab === 'labels') return labelsTab(box);
    if (tab === 'log') return logTab(box);
    if (tab === 'restock') return restockTab(box);
    if (tab === 'entry') return entryTab(box);
    if (tab === 'parts') return partsTab(box, term);
    if (tab === 'suppliers') return suppliersTab(box);
    if (tab === 'gen') {
      box.innerHTML = `<p class="nv-help">Para produto <b>sem código de barras</b>: o sistema cria o código, já cadastra o produto com o estoque e abre as etiquetas para imprimir (uma por unidade). Depois é só colar no produto: o leitor reconhece na venda e o estoque baixa sozinho.</p>
        <form id="fsGen" autocomplete="off"><label class="nv-field">Nome do produto<input name="name" maxlength="120" required placeholder="Ex.: Capinha Galaxy A12 transparente"></label>
        <div class="fs-row"><label class="nv-field fs-grow">Preço de venda<input name="price" inputmode="decimal" required placeholder="0,00"></label><label class="nv-field fs-grow">Preço de custo<input name="cost" inputmode="decimal" placeholder="0,00"></label><label class="nv-field" style="flex:0 0 120px">Quantidade<input name="qty" inputmode="numeric" required value="1"></label></div>
        ${labelChoiceHtml('each')}<p class="nv-help" id="fsGenInfo"></p><button class="nv-button">Gerar código e cadastrar</button><p role="status" class="nv-help"></p></form>`;
      const f = $('fsGen'), st = f.querySelector('[role=status]');
      f.oninput = () => { const p = parseMoney(f.elements.price.value), c = parseMoney(f.elements.cost.value), q = Number(f.elements.qty.value);
        $('fsGenInfo').innerHTML = [Number.isInteger(q) && q > 0 ? `estoque inicial de ${q}` : '', Number.isFinite(p) && Number.isFinite(c) ? `lucro por unidade ${brl(p - c)} (${margin(p, c)}%)` : ''].filter(Boolean).join(' · '); };
      f.oninput(); f.elements.name.focus();
      f.onsubmit = async e => {
        e.preventDefault();
        const name = f.elements.name.value.trim(), price = parseMoney(f.elements.price.value), costRaw = f.elements.cost.value.trim(), cost = costRaw ? parseMoney(costRaw) : null, qty = Number(f.elements.qty.value);
        if (name.length < 2) { st.textContent = 'Informe o nome do produto.'; return; }
        if (!Number.isFinite(price) || price < 0) { st.textContent = 'Informe o preço de venda.'; return; }
        if (costRaw && (!Number.isFinite(cost) || cost < 0)) { st.textContent = 'Preço de custo inválido.'; return; }
        if (!Number.isInteger(qty) || qty < 1 || qty > 500) { st.textContent = 'Quantidade de 1 a 500.'; return; }
        try {
          const p = await api('/store/products/generate', 'POST', { name, price_cents: price, cost_cents: cost, quantity: qty });
          await applyLabelChoice(f, p, qty);
          box.innerHTML = `<div class="fs-last"><div><b>${esc(p.name)}</b> cadastrado com o código <b>${esc(p.barcode)}</b> e estoque ${p.stock_qty}.</div>
            <div class="fs-actions"><button type="button" class="nv-button" id="fsGenPrint">${FPIcon('tag')}Etiquetas deste produto</button><button type="button" class="nv-button secondary" id="fsGenMore">Gerar outro produto</button></div></div>`;
          $('fsGenPrint').onclick = () => labelsDialog(p, 1); $('fsGenMore').onclick = () => productsDialog('', 'gen');
        } catch (err) { st.textContent = err.message; }
      };
      return;
    }
    box.innerHTML = `<div class="fs-row"><input id="fsProdSearch" class="fs-grow" type="search" placeholder="Bipe o código ou busque pelo nome" value="${esc(term)}" aria-label="Buscar produto"><button type="button" class="nv-button" id="fsProdNew">+ Novo produto</button></div>
      <p class="nv-help">Chegou mercadoria? Use a aba <b>"Entrada rápida"</b>: bipa uma unidade e informa a quantidade. Produto sem código: aba "Gerar códigos".</p><div id="fsProdList" class="nv-list"></div>`;
    const input = $('fsProdSearch'), list = $('fsProdList'); let timer, rows = [];
    const reopen = () => productsDialog(input.value.trim());
    const draw = async () => {
      const t = input.value.trim();
      try { rows = await api('/store/products' + (t ? '?q=' + encodeURIComponent(t) : '')); } catch (err) { list.textContent = err.message; return; }
      if (!list.isConnected) return;
      list.innerHTML = rows.map(p => { const m = margin(p.price_cents, p.cost_cents);
        return `<div class="fs-sale fs-prod"><div><b>${esc(p.name)}</b><br><small>${p.barcode ? esc(p.barcode) + (p.generated_barcode ? ' (gerado)' : '') : 'sem código de barras'}</small><br>
          <small>Custo: ${p.cost_cents != null ? brl(p.cost_cents) + (m != null ? ` · lucro ${m}%` : '') : '—'} · ${p.ask_variant ? 'Estoque por modelo' : `Estoque: <b class="${p.stock_qty != null && p.stock_qty <= 0 ? 'fs-neg' : ''}">${p.stock_qty ?? 'não controla'}</b>`}${p.restock_pending ? ` · <span class="fs-neg">repor ${p.restock_pending}</span>` : ''}</small></div>
          <div class="fs-sale-end"><b>${brl(p.price_cents)}</b><button type="button" class="nv-button secondary fs-small" data-fs-edit="${p.id}">Editar</button>${p.ask_variant ? `<button type="button" class="nv-button secondary fs-small" data-fs-vars="${p.id}">Modelos</button>` : ''}<button type="button" class="nv-button secondary fs-small" data-fs-stock="${p.id}">+ Estoque</button>${p.barcode ? `<button type="button" class="nv-button secondary fs-small" data-fs-lab="${p.id}">${FPIcon('tag')}Etiquetas</button>` : ''}<button type="button" class="nv-button secondary fs-small" data-fs-hist="${p.id}">Histórico</button><button type="button" class="nv-button secondary fs-small" data-fs-pdel="${p.id}">Excluir</button></div></div>`; }).join('')
        || (t ? `<p class="nv-help">Nenhum produto encontrado.${looksLikeCode(t) ? ` <button type="button" class="nv-button secondary fs-small" id="fsProdNewCode">Cadastrar com o código ${esc(t)}</button>` : ''}</p>` : '<p class="nv-help">Nenhum produto cadastrado ainda.</p>');
      const byId = id => rows.find(p => p.id === id);
      list.querySelectorAll('[data-fs-edit]').forEach(b => b.onclick = () => productDialog(byId(b.dataset.fsEdit), reopen));
      list.querySelectorAll('[data-fs-stock]').forEach(b => b.onclick = () => stockDialog(byId(b.dataset.fsStock), reopen));
      list.querySelectorAll('[data-fs-vars]').forEach(b => b.onclick = () => variantsDialog(byId(b.dataset.fsVars), reopen));
      list.querySelectorAll('[data-fs-lab]').forEach(b => b.onclick = () => { const p = byId(b.dataset.fsLab); labelsDialog(p, 1); });
      list.querySelectorAll('[data-fs-hist]').forEach(b => b.onclick = () => { const p = byId(b.dataset.fsHist); logFilter = { product_id: p.id, name: p.name }; productsDialog('', 'log'); });
      list.querySelectorAll('[data-fs-pdel]').forEach(b => b.onclick = async () => {
        const p = byId(b.dataset.fsPdel); if (!confirm(`Excluir o produto "${p.name}"? As vendas antigas continuam com ele no histórico.`)) return;
        try { await api('/store/products/' + p.id, 'DELETE'); cart = cart.filter(i => i.id !== p.id); drawCart(); draw(); } catch (err) { feedback(err.message, true); }
      });
      if ($('fsProdNewCode')) $('fsProdNewCode').onclick = () => productDialog({ barcode: t }, reopen);
    };
    input.oninput = () => { clearTimeout(timer); timer = setTimeout(draw, 220); };
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); draw(); } };
    $('fsProdNew').onclick = () => productDialog({}, reopen);
    input.focus(); draw();
  }

  // Captura global: com o Caixa na tela, uma sequência rápida de teclas terminada em Enter é o leitor,
  // mesmo que o cursor esteja em outro campo (ou em nenhum). Digitação humana é bem mais lenta.
  (() => {
    let buf = '', first = 0, last = 0;
    const GAP = 50, AVG = 30, MIN = 4;
    document.addEventListener('keydown', e => {
      const sale = $('fsSale'), closed = $('fsOpen');
      if ((!sale && !closed) || $('editorDialog')?.open || e.isComposing) { buf = ''; return; }
      const now = performance.now();
      if (e.key === 'Enter') {
        const isScan = buf.length >= MIN && now - last < GAP * 2 && (last - first) / (buf.length - 1) < AVG;
        const code = buf; buf = '';
        if (!isScan || !/^[!-~]{3,64}$/.test(code)) return;
        e.preventDefault(); e.stopPropagation();
        // Tira do campo o que o leitor "digitou" nele.
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.readOnly && t.value.endsWith(code)) { t.value = t.value.slice(0, -code.length); t.dispatchEvent(new Event('input', { bubbles: true })); }
        if (!sale) { feedback('Abra o caixa para registrar a venda deste produto.', true); beep(false); return; }
        if ($('fsScanResults')) $('fsScanResults').innerHTML = '';
        if (saleMode === 'service') { setMode('product'); feedback('Produto lido pelo leitor: o caixa passou para "Produto". O serviço digitado continua guardado.'); }
        handleCode(code);
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (now - last > GAP || !buf) { buf = ''; first = now; }
        buf += e.key; last = now;
      } else if (e.key !== 'Shift') buf = '';
    }, true);
  })();

  function movement(kind, box, alive) {
    const title = kind === 'expense' ? 'Lançar saída (despesa)' : kind === 'withdrawal' ? 'Sangria (tirar dinheiro da gaveta)' : 'Suprimento (colocar dinheiro na gaveta)';
    const expense = kind === 'expense';
    openDialog(`${header(title)}<form id="fsMove" autocomplete="off">
      ${expense ? '<p class="nv-help">Tudo que saiu de dinheiro da loja hoje: fornecedor, conta, diária, entrega… Em dinheiro, sai da gaveta; em Pix ou cartão, entra só no relatório.</p>' : `<p class="nv-help">${kind === 'withdrawal' ? 'Dinheiro tirado da gaveta para guardar (cofre, depósito). Não é despesa: para pagamentos use "Lançar saída".' : 'Dinheiro colocado na gaveta durante o dia (ex.: mais troco).'}</p>`}
      <div class="fs-row"><label class="nv-field">Valor<input name="amount" inputmode="decimal" required placeholder="0,00"></label>
      ${expense ? `<label class="nv-field fs-grow">Categoria<select name="category">${CATEGORIES.map(c => `<option>${c}</option>`).join('')}</select></label>` : ''}</div>
      ${expense ? `<fieldset class="fs-methods"><legend>Pago com</legend>${Object.entries(METHODS).map(([k, v], i) => `<label><input type="radio" name="method" value="${k}" ${i === 0 ? 'checked' : ''}><span>${v}</span></label>`).join('')}</fieldset>` : ''}
      <label class="nv-field">${expense ? 'Descrição' : 'Motivo'}<input name="note" maxlength="200" placeholder="${expense ? 'Ex.: tela Samsung A12 do fornecedor João' : kind === 'withdrawal' ? 'Ex.: levado para o cofre' : 'Ex.: troco extra'}"></label>
      <button class="nv-button">Confirmar</button><p role="status" class="nv-help"></p></form>`);
    $('fsMove').onsubmit = async e => {
      e.preventDefault(); const f = e.currentTarget, v = parseMoney(f.elements.amount.value);
      if (!Number.isFinite(v) || v <= 0) { f.querySelector('[role=status]').textContent = 'Valor inválido.'; return; }
      const body = { kind, amount_cents: v, note: f.elements.note.value.trim() };
      if (expense) { body.method = f.elements.method.value; body.category = f.elements.category.value; }
      try { await api('/store/cash/movements', 'POST', body); $('editorDialog').close(); feedback(`${MOVE_LABEL[kind]} de ${brl(v)} registrada.`); loadCash(box, alive); }
      catch (err) { f.querySelector('[role=status]').textContent = err.message; }
    };
  }

  function closeCash(sum, box, alive) {
    const keys = [...new Set([...Object.keys(sum.by_method), ...Object.keys(sum.expenses_by_method)])];
    const lines = Object.keys(METHODS).filter(k => keys.includes(k)).map(k => `<tr><td>${METHODS[k]}</td><td class="fs-pos">${brl(sum.by_method[k]?.total_cents || 0)}</td><td class="fs-neg">${brl(sum.expenses_by_method[k]?.total_cents || 0)}</td><td>${brl((sum.by_method[k]?.total_cents || 0) - (sum.expenses_by_method[k]?.total_cents || 0))}</td></tr>`).join('');
    openDialog(`${header('Fechar caixa')}<div class="fs-table"><table><thead><tr><th>Forma</th><th>Entradas</th><th>Saídas</th><th>Saldo</th></tr></thead><tbody>${lines || '<tr><td colspan="4">Nenhum lançamento.</td></tr>'}<tr><th>Total</th><th class="fs-pos">${brl(sum.sales_total_cents)}</th><th class="fs-neg">${brl(sum.expenses_total_cents)}</th><th>${brl(sum.balance_cents)}</th></tr></tbody></table></div>
      <p class="nv-help">Dinheiro esperado na gaveta: troco ${brl(sum.opening_cents)} + vendas em dinheiro ${brl(sum.by_method.cash?.total_cents || 0)} + suprimentos ${brl(sum.deposits_cents)} − sangrias ${brl(sum.withdrawals_cents)} − saídas em dinheiro ${brl(sum.expenses_by_method.cash?.total_cents || 0)} = <b>${brl(sum.expected_cash_cents)}</b></p>
      <form id="fsCloseForm"><label class="nv-field">Dinheiro contado na gaveta<input name="counted" inputmode="decimal" required placeholder="0,00"></label><p id="fsDiff" class="nv-help"></p><label class="nv-field">Observação (opcional)<input name="note" maxlength="400"></label><label class="fs-check"><input type="checkbox" name="print" checked> Imprimir relatório ao fechar</label><button class="nv-button">Fechar caixa</button><p role="status" class="nv-help"></p></form>`);
    const f = $('fsCloseForm');
    f.elements.counted.oninput = () => { const v = parseMoney(f.elements.counted.value); const d = v - sum.expected_cash_cents; $('fsDiff').innerHTML = Number.isFinite(v) ? (d === 0 ? FPIcon('check') + ' Bateu certinho' : `Diferença: <b class="${d < 0 ? 'fs-neg' : 'fs-pos'}">${brl(d)}</b> (${d < 0 ? 'faltando' : 'sobrando'})`) : ''; };
    f.onsubmit = async e => {
      e.preventDefault(); const v = parseMoney(f.elements.counted.value);
      if (!Number.isFinite(v) || v < 0) { f.querySelector('[role=status]').textContent = 'Informe o valor contado.'; return; }
      const wantPrint = f.elements.print.checked;
      try { const r = await api('/store/cash/close', 'POST', { counted_cash_cents: v, note: f.elements.note.value.trim() }); $('editorDialog').close(); lastSale = null; feedback(`Caixa fechado. Entradas ${brl(r.summary.sales_total_cents)}, saídas ${brl(r.summary.expenses_total_cents)}, saldo ${brl(r.summary.balance_cents)}.` + (r.difference_cents ? ` Diferença na gaveta: ${brl(r.difference_cents)}.` : '')); loadCash(box, alive); if (wantPrint) printReport(r.session.id); }
      catch (err) { f.querySelector('[role=status]').textContent = err.message; }
    };
  }

  // ---------------- Comprovante da venda (térmica 80 mm, ex.: Epson TM-T20) ----------------
  // Imprime pela impressora padrão do Windows. A altura da página é medida pelo conteúdo,
  // para a bobina avançar só o necessário e a guilhotina cortar logo após o texto.
  const RECEIPT_AUTO_KEY = 'fp_receipt_autoprint';
  const autoPrint = () => { try { return localStorage.getItem(RECEIPT_AUTO_KEY) === '1'; } catch { return false; } };
  const receiptExtras = new Map(); // troco e valor recebido desta sessão do navegador (não ficam no banco)
  async function printReceipt(saleId) {
    let r; try { r = await api(`/store/sales/${saleId}/receipt`); } catch (err) { feedback(err.message, true); return; }
    const extra = receiptExtras.get(saleId) || {};
    const when = new Date(r.created_at).toLocaleString('pt-BR', { timeZone: r.timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const now = new Date().toLocaleString('pt-BR', { timeZone: r.timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const reprint = Date.now() - new Date(r.created_at).getTime() > 10 * 60 * 1000;
    const place = [r.city, r.state].filter(Boolean).join('/');
    const items = r.items.length
      ? `<div class="row small"><span>QTD  ITEM</span><span>VALOR</span></div>` + r.items.map(i => `<div class="it"><div class="row"><span><b>${i.quantity}</b>  ${esc(i.name)}</span><span>${brl(i.total_cents)}</span></div>${i.quantity > 1 ? `<div class="small">${i.quantity} x ${brl(i.total_cents / i.quantity)}</div>` : ''}${i.service && i.warranty_days ? `<div class="small">Garantia: ${i.warranty_days} dias</div>` : ''}</div>`).join('')
      : `<div class="it"><div>${esc(r.description || 'Venda')}</div><div class="row"><span></span><span>${brl(r.total_cents)}</span></div></div>`;
    const l = r.loyalty;
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Comprovante venda ${r.sale_number}</title><style>
      @page{size:80mm 200mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000}
      body{width:72mm;margin:0 auto;padding:2mm 0 6mm;font:12px/1.35 Arial,Helvetica,sans-serif}
      .c{text-align:center}.store{font-size:16px;font-weight:700}.hr{border-top:1px dashed #000;margin:6px 0}
      .row{display:flex;justify-content:space-between;gap:8px}.row span:last-child{white-space:nowrap;text-align:right}
      .it{margin:3px 0}.tot{font-size:17px;font-weight:700}.title{font-weight:700;letter-spacing:.04em}
      .cancel{border:2px solid #000;font-weight:700;text-align:center;padding:4px;margin:6px 0;font-size:15px}.small{font-size:11px}
    </style></head><body>
      <div class="c store">${esc(r.store_name)}</div>
      ${place || r.whatsapp ? `<div class="c small">${esc(place)}${place && r.whatsapp ? ' · ' : ''}${r.whatsapp ? 'WhatsApp ' + esc(phoneBR(r.whatsapp)) : ''}</div>` : ''}
      <div class="hr"></div><div class="c title">COMPROVANTE DE VENDA</div>
      ${r.canceled_at ? '<div class="cancel">VENDA CANCELADA</div>' : ''}
      <div class="row"><span>Venda nº ${r.sale_number}</span><span>${when}</span></div>
      <div>Vendedor: ${esc(r.seller_name || r.created_by_name)}</div>
      ${r.customer_name ? `<div>Cliente: ${esc(r.customer_name)}</div>` : ''}
      ${r.order_number ? `<div>Pedido nº ${esc(r.order_number)}</div>` : ''}
      <div class="hr"></div>${items}<div class="hr"></div>
      ${r.discount_cents ? `<div class="row small"><span>Desconto concedido (já nos valores acima)</span><span>${brl(r.discount_cents)}</span></div>` : ''}
      ${r.cashback_used_cents ? `<div class="row small"><span>Cashback usado (já nos valores acima)</span><span>− ${brl(r.cashback_used_cents)}</span></div>` : ''}
      <div class="row tot"><span>${r.cashback_used_cents ? 'TOTAL PAGO' : 'TOTAL'}</span><span>${brl(r.total_cents)}</span></div>
      <div class="row"><span>Pagamento</span><span>${METHODS[r.payment_method]}</span></div>
      ${extra.received_cents != null ? `<div class="row"><span>Valor recebido</span><span>${brl(extra.received_cents)}</span></div><div class="row"><span>Troco</span><span>${brl(extra.change_cents)}</span></div>` : ''}
      ${l ? `<div class="hr"></div><div class="c">${l.complete ? `Cartão fidelidade completo! Prêmio: ${esc(l.reward)}` : `Cartão fidelidade: ${l.checkins} de ${l.target}. Faltam ${l.remaining} para ganhar: ${esc(l.reward)}`}</div>` : ''}
      ${r.cashback && (r.cashback_earned_cents || r.cashback.balance_cents) ? `<div class="hr"></div><div class="c">${r.cashback_earned_cents ? `Cashback ganho nesta compra: <b>${brl(r.cashback_earned_cents)}</b><br>` : ''}Saldo de cashback: <b>${brl(r.cashback.balance_cents)}</b>${r.cashback.next_expires_on ? `<br><span class="small">${r.cashback.next_expiring_cents < r.cashback.balance_cents ? brl(r.cashback.next_expiring_cents) + ' vence em' : 'Válido até'} ${ymdShort(r.cashback.next_expires_on)}</span>` : ''}</div>` : ''}
      <div class="hr"></div><div class="c">Obrigado pela preferência!</div>
      <div class="c small">Não é documento fiscal${reprint ? ` · Reimpressão ${now}` : ''}</div>
    </body></html>`;
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true'); frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:80mm;height:400px;border:0';
    document.body.append(frame);
    const doc = frame.contentDocument; doc.open(); doc.write(html); doc.close();
    window.FPSales.lastReceiptHtml = html;
    setTimeout(() => {
      try {
        // Altura real do conteúdo → tamanho da página (px CSS → mm), com folga para o corte.
        const mm = Math.ceil(doc.body.getBoundingClientRect().height * 25.4 / 96) + 4;
        const st = doc.createElement('style'); st.textContent = `@page{size:80mm ${Math.max(60, mm)}mm;margin:0}`; doc.head.append(st);
        // Imprimir exige foco no quadro; depois devolve o foco a quem estava digitando.
        const prev = document.activeElement; frame.contentWindow.focus(); frame.contentWindow.print(); if (prev && prev !== document.body && prev.isConnected) prev.focus();
      } finally { setTimeout(() => frame.remove(), 60000); }
    }, 150);
  }

  // ---------------- Relatório para imprimir ----------------
  async function printReport(sessionId) {
    let r; try { r = await api(`/store/cash/sessions/${sessionId}/report`); } catch (err) { feedback(err.message, true); return; }
    const s = r.session, sum = r.summary, dt = d => d ? `${dmy(d)}/${new Date(d).getFullYear()} ${hhmm(d)}` : '—';
    const keys = Object.keys(METHODS).filter(k => sum.by_method[k] || sum.expenses_by_method[k]);
    const sales = r.sales.filter(x => !x.canceled_at).reverse(), salesCanceled = r.sales.filter(x => x.canceled_at).reverse();
    const moves = r.movements.filter(m => !m.canceled_at).reverse(), movesCanceled = r.movements.filter(m => m.canceled_at).reverse();
    const expenses = moves.filter(m => m.kind === 'expense'), transfers = moves.filter(m => m.kind !== 'expense');
    const diff = s.counted_cash_cents != null ? s.counted_cash_cents - s.expected_cash_cents : null;
    const linked = sales.filter(x => x.customer_id).length;
    // Serviços do caixa: preço, custo (peça) e lucro, com aparelho e fornecedor.
    const svcs = sales.flatMap(x => (x.items || []).filter(i => i.service).map(i => ({ ...i, sale_number: x.sale_number })));
    const svcTotal = svcs.reduce((a, i) => a + i.total_cents, 0), svcKnown = svcs.filter(i => i.unit_cost_cents != null);
    const svcProfit = svcKnown.reduce((a, i) => a + i.total_cents - i.unit_cost_cents, 0);
    const table = (head, rows, empty) => rows.length ? `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>` : `<p class="muted">${empty}</p>`;
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de caixa · ${esc(s.store_name)} · ${dmy(s.opened_at)}</title><style>
      @page{size:A4;margin:14mm}*{box-sizing:border-box}body{font:12px/1.4 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#111;margin:0;padding:16px}
      h1{font-size:18px;margin:0}h2{font-size:13px;margin:18px 0 6px;padding-bottom:3px;border-bottom:1.5px solid #111;text-transform:uppercase;letter-spacing:.04em}
      .muted{color:#555}.head{display:flex;justify-content:space-between;gap:12px;align-items:flex-end;border-bottom:2px solid #111;padding-bottom:8px}
      .box{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}.box div{border:1px solid #bbb;border-radius:6px;padding:8px}.box b{display:block;font-size:17px}
      table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #ddd;vertical-align:top}th{font-size:11px;color:#444}td.n,th.n,th:has(.n){text-align:right;white-space:nowrap}
      tr.tot td{font-weight:700;border-top:1.5px solid #111}.neg{color:#b42318}.sign{display:flex;gap:40px;margin-top:40px}.sign div{flex:1;border-top:1px solid #111;padding-top:4px;text-align:center}
      .warn{background:#fff6e5;border:1px solid #f0c36d;padding:6px 8px;border-radius:6px;margin-top:8px}
    </style></head><body>
      <div class="head"><div><h1>${esc(s.store_name)}</h1><div>Relatório de caixa${s.city ? ' · ' + esc(s.city) + (s.state ? '/' + esc(s.state) : '') : ''}</div></div><div class="muted" style="text-align:right">Emitido em ${dt(r.generated_at)}</div></div>
      ${s.status === 'open' ? '<p class="warn"><b>Prévia:</b> caixa ainda aberto. Valores podem mudar até o fechamento.</p>' : ''}
      <p>Abertura: <b>${dt(s.opened_at)}</b> por ${esc(s.opened_by_name)}<br>Fechamento: <b>${s.closed_at ? dt(s.closed_at) + ' por ' + esc(s.closed_by_name || '—') : 'em aberto'}</b></p>
      <div class="box"><div>Entradas (vendas)<b>${brl(sum.sales_total_cents)}</b><span class="muted">${sum.sales_count} venda(s)</span></div><div>Saídas<b class="neg">${brl(sum.expenses_total_cents)}</b><span class="muted">${sum.expenses_count} lançamento(s)</span></div><div>Saldo do dia<b>${brl(sum.balance_cents)}</b><span class="muted">entradas − saídas</span></div></div>
      ${(sum.by_seller || []).length ? `<h2>Por vendedor</h2>${table(['Vendedor', '<span class="n">Vendas</span>', '<span class="n">Total</span>'], sum.by_seller.map(v => `<tr><td>${esc(v.name)}</td><td class="n">${v.count}</td><td class="n">${brl(v.total_cents)}</td></tr>`), '')}` : ''}
      <h2>Por forma de pagamento</h2>
      ${table(['Forma', '<span class="n">Entradas</span>', '<span class="n">Saídas</span>', '<span class="n">Saldo</span>'], [...keys.map(k => `<tr><td>${METHODS[k]}</td><td class="n">${brl(sum.by_method[k]?.total_cents || 0)}</td><td class="n">${brl(sum.expenses_by_method[k]?.total_cents || 0)}</td><td class="n">${brl((sum.by_method[k]?.total_cents || 0) - (sum.expenses_by_method[k]?.total_cents || 0))}</td></tr>`), `<tr class="tot"><td>Total</td><td class="n">${brl(sum.sales_total_cents)}</td><td class="n">${brl(sum.expenses_total_cents)}</td><td class="n">${brl(sum.balance_cents)}</td></tr>`], 'Nenhum lançamento.')}
      ${sum.cashback_used_cents || sum.cashback_earned_cents ? `<p>Cashback: clientes usaram <b>${brl(sum.cashback_used_cents)}</b> (já descontado das entradas) · gerado para os clientes <b>${brl(sum.cashback_earned_cents)}</b></p>` : ''}
      <h2>Gaveta (dinheiro)</h2>
      <table><tbody><tr><td>Troco inicial</td><td class="n">${brl(sum.opening_cents)}</td></tr><tr><td>+ Vendas em dinheiro</td><td class="n">${brl(sum.by_method.cash?.total_cents || 0)}</td></tr><tr><td>+ Suprimentos</td><td class="n">${brl(sum.deposits_cents)}</td></tr><tr><td>− Sangrias</td><td class="n">${brl(sum.withdrawals_cents)}</td></tr><tr><td>− Saídas em dinheiro</td><td class="n">${brl(sum.expenses_by_method.cash?.total_cents || 0)}</td></tr>
        <tr class="tot"><td>Esperado na gaveta</td><td class="n">${brl(s.status === 'closed' ? s.expected_cash_cents : sum.expected_cash_cents)}</td></tr>
        ${s.status === 'closed' ? `<tr><td>Contado</td><td class="n">${brl(s.counted_cash_cents)}</td></tr><tr class="tot"><td>Diferença</td><td class="n ${diff < 0 ? 'neg' : ''}">${diff ? brl(diff) + (diff < 0 ? ' (faltando)' : ' (sobrando)') : 'sem diferença'}</td></tr>` : ''}</tbody></table>
      ${s.close_note ? `<p>Observação do fechamento: ${esc(s.close_note)}</p>` : ''}
      <h2>Saídas</h2>
      ${table(['Hora', 'Categoria', 'Descrição', 'Forma', 'Lançado por', '<span class="n">Valor</span>'], expenses.map(m => `<tr><td>${hhmm(m.created_at)}</td><td>${esc(m.category)}</td><td>${esc(m.note)}</td><td>${METHODS[m.method]}</td><td>${esc(m.created_by_name)}</td><td class="n">${brl(m.amount_cents)}</td></tr>`), 'Nenhuma saída.')}
      ${transfers.length ? `<h2>Sangrias e suprimentos</h2>${table(['Hora', 'Tipo', 'Motivo', 'Lançado por', '<span class="n">Valor</span>'], transfers.map(m => `<tr><td>${hhmm(m.created_at)}</td><td>${MOVE_LABEL[m.kind]}</td><td>${esc(m.note)}</td><td>${esc(m.created_by_name)}</td><td class="n">${m.kind === 'deposit' ? '+' : '−'}${brl(m.amount_cents)}</td></tr>`), '')}` : ''}
      <h2>Vendas (${sales.length}${sales.length ? ` · ${Math.round(100 * linked / sales.length)}% com cliente identificado` : ''})</h2>
      ${table(['Nº', 'Hora', 'Vendedor', 'Cliente', 'Descrição', 'Forma', '<span class="n">Valor</span>'], sales.map(x => `<tr><td>${x.sale_number}</td><td>${hhmm(x.created_at)}</td><td>${esc(x.seller_name || '')}</td><td>${esc(x.customer_name || 'Sem cliente')}</td><td>${esc(x.description)}${x.order_number ? ' (pedido ' + esc(x.order_number) + ')' : ''}</td><td>${METHODS[x.payment_method]}</td><td class="n">${brl(x.total_cents)}</td></tr>`), 'Nenhuma venda.')}
      ${svcs.length ? `<h2>Serviços (${svcs.length} · ${brl(svcTotal)}${svcKnown.length ? ` · lucro ${brl(svcProfit)}` : ''})</h2>${table(['Nº', 'Serviço', 'Aparelho', 'Fornecedor', '<span class="n">Preço</span>', '<span class="n">Custo</span>', '<span class="n">Lucro</span>'], svcs.map(i => `<tr><td>${i.sale_number}</td><td>${esc(i.name)}${i.warranty_days ? ` <span class="muted">(garantia ${i.warranty_days}d)</span>` : ''}</td><td>${esc(i.device_model || '—')}</td><td>${esc(i.supplier_name || '—')}</td><td class="n">${brl(i.total_cents)}</td><td class="n">${i.unit_cost_cents != null ? brl(i.unit_cost_cents) : '—'}</td><td class="n ${i.unit_cost_cents != null && i.total_cents < i.unit_cost_cents ? 'neg' : ''}">${i.unit_cost_cents != null ? brl(i.total_cents - i.unit_cost_cents) : '—'}</td></tr>`), '')}` : ''}
      ${salesCanceled.length || movesCanceled.length ? `<h2>Cancelamentos</h2>${table(['Item', 'Cancelado por', 'Quando', 'Motivo', '<span class="n">Valor</span>'], [...salesCanceled.map(x => `<tr><td>Venda ${x.sale_number}${x.customer_name ? ' · ' + esc(x.customer_name) : ''}</td><td>${esc(x.canceled_by_name || '—')}</td><td>${hhmm(x.canceled_at)}</td><td>${esc(x.cancel_reason)}</td><td class="n">${brl(x.total_cents)}</td></tr>`), ...movesCanceled.map(m => `<tr><td>${MOVE_LABEL[m.kind]}${m.category ? ' · ' + esc(m.category) : ''}</td><td>${esc(m.canceled_by_name || '—')}</td><td>${hhmm(m.canceled_at)}</td><td>${esc(m.cancel_reason)}</td><td class="n">${brl(m.amount_cents)}</td></tr>`)], '')}` : ''}
      <div class="sign"><div>Responsável pelo caixa</div><div>Conferido por</div></div>
    </body></html>`;
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true'); frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.append(frame);
    frame.contentDocument.open(); frame.contentDocument.write(html); frame.contentDocument.close();
    setTimeout(() => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } finally { setTimeout(() => frame.remove(), 60000); } }, 250);
    window.FPSales.lastReportHtml = html;
  }

  // ---------------- Mensagens ----------------
  let msgTab = 'status', statusDay = '';
  async function loadMessages(box, alive) {
    box.innerHTML = `<section class="nv-card"><div class="fs-tabs" role="tablist">${[['status', 'Status do dia'], ['cashback', 'Cashback'], ['offers', 'Ofertas'], ['config', 'Configurar']].map(([k, v]) => `<button type="button" role="tab" aria-selected="${msgTab === k}" data-fs-tab="${k}">${v}</button>`).join('')}</div><div id="fsTab"></div></section>`;
    box.querySelectorAll('[data-fs-tab]').forEach(b => b.onclick = () => { msgTab = b.dataset.fsTab; loadMessages(box, alive); });
    const tab = $('fsTab');
    if (msgTab === 'status') return statusTab(tab, alive);
    if (msgTab === 'offers') return offersTab(tab, alive);
    if (msgTab === 'cashback') return cashbackTab(tab, alive);
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
      <p class="nv-help">Clientes que compraram no dia (caixa e pedidos finalizados). "Enviar" abre o WhatsApp com a mensagem pronta: obrigado, cartão fidelidade${cbOn() ? ', cashback (ganho e saldo em reais)' : ''} e pedido de avaliação.</p>
      <div class="nv-list">${rows.map(r => `<div class="fs-msg ${r.sent ? 'sent' : ''}" data-fs-row="${r.id}"><div class="fs-grow"><b>${esc(r.name)}</b> <small>${esc(r.phone || 'sem WhatsApp')}</small> ${cbBadge(r.cashback)}<br><small>${r.purchases.map(p => p.kind === 'sale' ? `venda #${esc(p.ref)} ${brl(p.total_cents)}` : `pedido ${esc(p.ref)} finalizado`).join(' · ')}</small>${progressBar(r.loyalty)}
        <details><summary>Ver mensagem</summary><pre class="fs-pre">${esc(statusMessage(r))}</pre></details></div>
        <div class="fs-actions">${r.sent ? `<span class="fs-ok">${FPIcon('check')}Enviado</span>` : ''}${waPhone(r.phone) ? `<button type="button" class="nv-button ${r.sent ? 'secondary' : 'fp-whats'} fs-small" data-fs-send="${r.id}">${r.sent ? 'Reenviar' : 'Enviar'}</button>` : ''}${r.loyalty?.complete ? `<button type="button" class="nv-button secondary fs-small" data-fs-redeem="${r.id}">Entregar prêmio</button>` : ''}</div></div>`).join('') || '<p class="nv-help">Nenhuma compra com cliente identificado neste dia.</p>'}</div>`;
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

  // Avisos de cashback perto de vencer: faltando 15, 10, 5 e 1 dia, um aviso por etapa.
  async function cashbackTab(tab, alive) {
    if (!cbOn()) {
      tab.innerHTML = `<p class="nv-help fs-warn">O cashback está desligado. ${config.role === 'owner' ? 'Ligue e defina as regras em "Configurar".' : 'Peça ao responsável pela loja para ligar em "Configurar".'}</p>`;
      return;
    }
    const data = await api('/store/messages/cashback'); if (!alive()) return;
    const rows = data.customers, pending = rows.filter(r => !r.sent && waPhone(r.phone));
    const row = r => `<div class="fs-msg ${r.sent ? 'sent' : ''}"><div class="fs-grow"><b>${esc(r.name)}</b> <small>${esc(r.phone || 'sem WhatsApp')}</small><br>
        <small><b class="${r.days_left <= 1 ? 'fs-neg' : ''}">${brl(r.expiring_cents)} vence ${cbWhen(r)}</b>${r.expiring_cents < r.balance_cents ? ` · saldo total ${brl(r.balance_cents)}` : ''} · aviso de ${r.stage === 1 ? '1 dia' : r.stage + ' dias'}${r.sent ? ` · avisado ${dmy(r.sent_at)} ${hhmm(r.sent_at)}` : ''}</small>
        <details><summary>Ver mensagem</summary><pre class="fs-pre">${esc(reminderMessage(r))}</pre></details></div>
        <div class="fs-actions">${r.sent ? `<span class="fs-ok">${FPIcon('check')}Avisado</span>` : ''}${waPhone(r.phone) ? `<button type="button" class="nv-button ${r.sent ? 'secondary' : 'fp-whats'} fs-small" data-fs-cb="${r.id}">${r.sent ? 'Reenviar' : 'Enviar'}</button>` : ''}</div></div>`;
    tab.innerHTML = `<div class="fs-row fs-daybar"><div><small class="nv-help">Saldo em aberto na loja</small><br><b>${brl(data.total_balance_cents)}</b> <small>· ${data.customers_with_balance} cliente(s)</small></div>
        <span class="fs-grow"></span><b>${rows.length - rows.filter(r => !r.sent).length} de ${rows.length} avisados</b>${pending.length ? '<button type="button" class="nv-button fp-whats" id="fsCbNext">Enviar próximo</button>' : ''}</div>
      <p class="nv-help">Clientes com cashback vencendo nos próximos 15 dias. O aviso aparece quando faltam 15, 10, 5 e 1 dia (uma vez em cada etapa). "Enviar" abre o WhatsApp com o valor, a data e as regras.</p>
      <div class="nv-list">${rows.map(row).join('') || '<p class="nv-help">Nenhum cashback vencendo nos próximos 15 dias.</p>'}</div>
      <details class="fs-cb-all" id="fsCbAll"><summary>Todos os clientes com saldo (${data.customers_with_balance})</summary><div id="fsCbAllList"><p class="nv-help">Carregando…</p></div></details>`;
    const send = async id => {
      const r = rows.find(x => x.id === id); if (!r) return;
      try { await sendWhats(r.phone, reminderMessage(r), { customer_id: r.id, kind: 'cashback', campaign: r.campaign }); cashbackTab(tab, alive); } catch (err) { feedback(err.message, true); }
    };
    tab.querySelectorAll('[data-fs-cb]').forEach(b => b.onclick = () => send(b.dataset.fsCb));
    if ($('fsCbNext')) $('fsCbNext').onclick = () => { const next = rows.find(r => !r.sent && waPhone(r.phone)); if (next) send(next.id); };
    $('fsCbAll').ontoggle = async e => {
      if (!e.target.open) return;
      try {
        const all = await api('/store/messages/cashback?all=1'); const out = $('fsCbAllList'); if (!out) return;
        out.innerHTML = `<div class="fs-table"><table><thead><tr><th>Cliente</th><th>Saldo</th><th>Vence primeiro</th></tr></thead><tbody>${all.customers.map(r => `<tr><td>${esc(r.name)}<br><small>${esc(r.phone || 'sem WhatsApp')}</small></td><td><b>${brl(r.balance_cents)}</b></td><td>${brl(r.expiring_cents)} em ${ymdShort(r.expires_on)} <small>(${r.days_left} dia${r.days_left === 1 ? '' : 's'})</small></td></tr>`).join('') || '<tr><td colspan="3">Nenhum cliente com saldo.</td></tr>'}</tbody></table></div>`;
      } catch (err) { feedback(err.message, true); }
    };
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
      <div class="nv-list">${rows.map(r => `<div class="fs-msg ${r.sent ? 'sent' : ''}"><div class="fs-grow"><b>${esc(r.name)}</b> <small>${esc(r.phone)}${r.last_buy ? ' · última compra ' + dmy(r.last_buy) : ''}</small></div><div class="fs-actions">${r.sent ? `<span class="fs-ok">${FPIcon('check')}Enviado</span>` : `<button type="button" class="nv-button fp-whats fs-small" data-fs-offer="${r.id}">Enviar</button>`}<button type="button" class="nv-button secondary fs-small" data-fs-optout="${r.id}" title="Cliente pediu para não receber ofertas">Não quer ofertas</button></div></div>`).join('') || '<p class="nv-help">Nenhum cliente nesse filtro.</p>'}</div>`;
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
      <section class="nv-form-panel"><h3>Cashback</h3><label class="fs-check"><input type="checkbox" name="cashback_enabled" ${dis} ${config.cashback_enabled ? 'checked' : ''}> Cashback ligado</label>
        <div class="fs-row"><label class="nv-field">% de volta em cada compra<input name="cashback_percent" inputmode="decimal" ${dis} value="${String(config.cashback_percent ?? 5).replace('.', ',')}"></label>
          <label class="nv-field">Pode pagar até (% da compra)<input type="number" min="1" max="100" name="cashback_max_use_percent" ${dis} value="${config.cashback_max_use_percent ?? 30}"></label>
          <label class="nv-field">Validade (dias)<input type="number" min="7" max="730" name="cashback_valid_days" ${dis} value="${config.cashback_valid_days ?? 90}"></label>
          <label class="nv-field">Compra mínima para ganhar<input name="cashback_min" inputmode="decimal" ${dis} value="${config.cashback_min_sale_cents ? centsText(config.cashback_min_sale_cents) : ''}" placeholder="0,00"></label></div>
        <label class="nv-field">Regras extras (vão na mensagem)<input name="cashback_rules" maxlength="400" ${dis} value="${esc(config.cashback_rules || '')}" placeholder="Ex.: Não vale para aparelhos novos."></label>
        <small class="nv-help">O cashback é calculado sobre o valor pago (sem desconto e sem o cashback usado). Ele fica disponível a partir da próxima compra, é usado primeiro o que vence antes e, se a venda for cancelada, volta ao que era. 90 dias = 3 meses.</small>
        <label class="nv-field">Mensagem de aviso de vencimento<textarea name="cashback_reminder_message" rows="4" maxlength="1000" ${dis}>${esc(config.cashback_reminder_message || DEFAULT_CB_REMINDER)}</textarea></label>
        <small class="nv-help">Use {cliente}, {loja}, {valor} (o que vence), {saldo} (saldo total), {quando} (hoje, amanhã ou em X dias), {vence} (data), {dias}, {regras}.</small>
        <h4>Prévia do aviso</h4><pre class="fs-pre" id="fsCbPreview"></pre></section>
      <section class="nv-form-panel"><h3>Mensagem de status</h3><label class="nv-field">Texto<textarea name="status_message" rows="6" maxlength="1000" ${dis}>${esc(config.status_message || DEFAULT_STATUS)}</textarea></label>
        <small class="nv-help">Use {cliente}, {loja}, {fidelidade} (progresso e regras do cartão), {cashback} (ganho na compra, saldo em reais, validade e regras; se a mensagem não tiver, entra logo depois da fidelidade), {avaliacao} (link do Google; a linha some se não houver link), {compras}, {meta}, {faltam}, {premio}, {regras}. Evite emojis: o WhatsApp do computador costuma mostrá-los como "?".</small>
        <h4>Prévia</h4><pre class="fs-pre" id="fsPreview"></pre></section>
      ${owner ? '<button class="nv-button">Salvar</button>' : ''}<p role="status" class="nv-help" id="fsCfgStatus"></p></form>`;
    const f = $('fsCfg');
    const cbForm = () => ({ cashback_enabled: f.elements.cashback_enabled.checked, cashback_percent: parseMoney(f.elements.cashback_percent.value) / 100, cashback_max_use_percent: Number(f.elements.cashback_max_use_percent.value),
      cashback_valid_days: Number(f.elements.cashback_valid_days.value), cashback_min_sale_cents: f.elements.cashback_min.value.trim() ? parseMoney(f.elements.cashback_min.value) : 0,
      cashback_rules: f.elements.cashback_rules.value.trim(), cashback_reminder_message: f.elements.cashback_reminder_message.value.trim() });
    const ahead = d => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
    const preview = () => { const saved = { ...config }; Object.assign(config, cbForm()); config.status_message = f.elements.status_message.value; config.google_review_url = f.elements.google_review_url.value.trim(); config.loyalty_rules = f.elements.loyalty_rules.value.trim();
      $('fsCbPreview').textContent = config.cashback_enabled ? reminderMessage({ name: 'Maria Silva', expiring_cents: 450, balance_cents: 1250, days_left: 5, expires_on: ahead(5) }) : '(cashback desligado)';
      const target = Number(f.elements.loyalty_target.value) || 10; $('fsPreview').textContent = statusMessage({ name: 'Maria Silva', cashback: { earned_cents: 500, balance_cents: 1250, next_expires_on: ahead(config.cashback_valid_days || 90), next_expiring_cents: 1250 }, loyalty: { enabled: f.elements.loyalty_enabled.checked, checkins: Math.min(3, target - 1), target, remaining: target - Math.min(3, target - 1), reward: f.elements.loyalty_reward.value, complete: false } }); Object.assign(config, saved); };
    f.oninput = preview; preview();
    f.onsubmit = async e => {
      e.preventDefault(); const st = $('fsCfgStatus');
      const min = f.elements.min.value.trim() ? parseMoney(f.elements.min.value) : 0;
      if (!Number.isFinite(min) || min < 0) { st.textContent = 'Valor mínimo inválido.'; return; }
      try {
        await api('/store/loyalty', 'PATCH', { loyalty_enabled: f.elements.loyalty_enabled.checked, loyalty_target: Number(f.elements.loyalty_target.value), loyalty_reward: f.elements.loyalty_reward.value.trim() });
        const cb = cbForm();
        if (!(cb.cashback_percent > 0 && cb.cashback_percent <= 50)) { st.textContent = 'Cashback: o percentual deve ficar entre 0,01% e 50%.'; return; }
        if (!(cb.cashback_max_use_percent >= 1 && cb.cashback_max_use_percent <= 100)) { st.textContent = 'Cashback: o limite de uso deve ficar entre 1% e 100%.'; return; }
        if (!(cb.cashback_valid_days >= 7 && cb.cashback_valid_days <= 730)) { st.textContent = 'Cashback: a validade deve ficar entre 7 e 730 dias.'; return; }
        if (!Number.isFinite(cb.cashback_min_sale_cents) || cb.cashback_min_sale_cents < 0) { st.textContent = 'Cashback: compra mínima inválida.'; return; }
        if (cb.cashback_reminder_message === DEFAULT_CB_REMINDER) cb.cashback_reminder_message = '';
        cb.cashback_percent = Math.round(cb.cashback_percent * 100) / 100;
        Object.assign(config, await api('/store/sales/cashback', 'PATCH', cb));
        const status = f.elements.status_message.value.trim();
        const r = await api('/store/sales/config', 'PATCH', { google_review_url: f.elements.google_review_url.value.trim(), loyalty_rules: f.elements.loyalty_rules.value.trim(), loyalty_min_sale_cents: min, status_message: status === DEFAULT_STATUS ? '' : status });
        Object.assign(config, r, { loyalty_enabled: f.elements.loyalty_enabled.checked }); st.textContent = 'Salvo.';
      } catch (err) { st.textContent = err.message.includes('inválidos') ? 'Confira o link (precisa começar com https://) e o prêmio (mínimo 3 letras).' : err.message; }
    };
  }

  // ---------------- Integração com o painel ----------------
  const css = `.fs-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:16px;align-items:start}.fs-col-report{display:flex;flex-direction:column;gap:16px;min-width:0}.fs-col-report .fs-moves{margin-top:0}
  @media(max-width:900px){.fs-grid{grid-template-columns:1fr}.fs-newsale{order:-1}}
  .fs-cashbar{position:relative}.fs-cashbar-side{display:flex;flex-direction:column;align-items:flex-end;gap:10px;margin-left:auto}.fs-cashbar:has(.fs-seller:not([hidden])) .fs-cashbar-side{padding-top:26px}
  .fs-seller{position:absolute;top:12px;right:16px;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--nv-muted)}.fs-seller[hidden]{display:none}
  .fs-seller select{width:auto;max-width:180px;padding:5px 28px 5px 12px;border:1px solid var(--nv-border);border-radius:999px;font:inherit;font-size:13px;font-weight:600;color:var(--nv-ink,#111);background-color:var(--nv-surface,#fff)}
  @media(max-width:900px){.fs-cashbar-side{align-items:stretch;margin-left:0;width:100%}.fs-cashbar:has(.fs-seller:not([hidden])){padding-top:48px}.fs-cashbar:has(.fs-seller:not([hidden])) .fs-cashbar-side{padding-top:0}}
  .fs-newsale>h2{margin:0 0 12px}.fs-mode{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 16px}
  .fs-mode button{padding:12px 10px;border:1.5px solid var(--nv-border);border-radius:12px;background:var(--nv-surface,#fff);font:inherit;font-size:15px;font-weight:700;color:var(--nv-ink,#111);cursor:pointer}
  .fs-mode button[aria-pressed=true]{background:var(--nv-blue);border-color:var(--nv-blue);color:#fff}.fs-mode button:focus-visible{outline:2px solid var(--nv-blue);outline-offset:2px}
  #fsSale [data-only][hidden]{display:none!important}
  .fs-sugg{position:relative}.fs-drop{position:absolute;left:0;right:0;top:100%;z-index:30;margin-top:2px;max-height:280px;overflow:auto}.fs-drop:empty{display:none}.fs-drop button,.fs-drop p{background:var(--nv-surface,#fff);box-shadow:0 6px 18px rgba(16,24,40,.08)}.fs-drop p{margin:0;padding:8px 10px;border-radius:10px;border:1px dashed var(--nv-border)}
  .fs-chip.fs-chip-on{border-color:var(--nv-blue);box-shadow:0 0 0 1.5px var(--nv-blue) inset}.fs-tag-svc{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--nv-blue-soft);font-size:12px;font-weight:600}
  #fsSvc .fs-picked{background:var(--nv-surface,#fff)}#fsSvc .nv-field input,#fsSvc .nv-field select{width:100%}
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
  .fs-open{max-width:640px}.fs-moves{margin-top:16px}.fs-pill-out{background:#fdecea}.fs-kpis b.fs-pos{color:#027a48}.fs-kpis b.fs-neg{color:#b42318}.fs-change{align-items:center;margin-bottom:4px}.fs-change-out{font-size:20px;padding-top:18px}.fs-quick{margin:4px 0 10px}.fs-quick-head{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:600;margin-bottom:6px}.fs-link{background:none;border:0;color:var(--nv-blue,#2563eb);font-size:13px;cursor:pointer;padding:4px}.fs-chips{display:flex;flex-wrap:wrap;gap:8px}.fs-chip{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 12px;border:1px solid var(--nv-border,#e5e7eb);border-radius:12px;background:var(--nv-blue-soft,#eef4ff);cursor:pointer;font-size:14px;min-height:44px;text-align:left}.fs-chip small{font-size:12px;opacity:.75}.fs-chip:active{transform:scale(.97)}.fs-cart{margin-top:10px;border:1px solid var(--nv-border,#e5e7eb);border-radius:12px;padding:4px 10px;background:#fafafa}.fs-cart-row{display:grid;grid-template-columns:minmax(0,1fr) auto 76px 28px;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #eee}.fs-cart-name{font-size:14px;font-weight:600;min-width:0;overflow-wrap:anywhere}.fs-cart-name small{display:block;font-weight:400;font-size:12px;opacity:.7}.fs-qq{display:inline-flex;align-items:center;border:1px solid var(--nv-border,#d0d5dd);border-radius:10px;overflow:hidden;background:#fff}.fs-qq button{border:0;background:none;width:34px;height:36px;font-size:18px;cursor:pointer}.fs-qq input{width:52px;height:36px;border:0;text-align:center;font:inherit;font-size:15px;-moz-appearance:textfield}.fs-qq input::-webkit-inner-spin-button{-webkit-appearance:none}.fs-cart-sub{text-align:right;font-size:14px}.fs-cart-del{border:0;background:none;cursor:pointer;color:#b42318;font-size:15px}.fs-cart-foot{display:flex;justify-content:space-between;align-items:center;padding:8px 0 4px;font-size:14px}@media(max-width:420px){.fs-cart-row{grid-template-columns:minmax(0,1fr) auto 28px}.fs-cart-sub{grid-column:1/3;text-align:left;font-size:13px}}.fs-quick-empty{margin:0}
  .fs-private .fs-kpis b,.fs-private .fs-methods-sum b,.fs-private .fs-sale-end>b,.fs-private .fs-opening,.fs-private .fs-lastclose{color:transparent!important;background:var(--nv-border);border-radius:6px;user-select:none;-webkit-user-select:none}
  .fs-private .fs-lastclose b{color:transparent!important}
  .fs-autoprint{margin:10px 0 0;font-size:14px}
  .fs-costcode{color:#1d4ed8;font-weight:700;letter-spacing:.03em;margin-left:4px;font-variant-numeric:tabular-nums}
  .fs-scan{margin-bottom:10px}.fs-scan input{font-size:16px}.fs-pcart{border:1px solid var(--nv-border);border-radius:12px;margin-top:8px;overflow:hidden}
  .fs-basic #fsExpense,.fs-basic #fsExpense2,.fs-basic #fsWithdraw,.fs-basic #fsDeposit,.fs-basic #fsClose,.fs-basic [data-fs-cancel],.fs-basic [data-fs-move-cancel],.fs-basic .fs-disc label{display:none!important}.fs-basic .fs-unit[readonly]{border-color:transparent;background:transparent;pointer-events:none}.fs-var{font-weight:600;color:var(--nv-orange,#f25c1f)}.fs-seller-tag{color:var(--nv-muted)}.fs-unit-wrap{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:400;color:var(--nv-muted);margin-top:3px;white-space:nowrap}.fs-cart-name .fs-unit-wrap{display:flex}input.fs-unit{display:inline-block!important;width:78px!important;min-height:0!important;padding:4px 6px!important;margin:0!important;border:1px solid var(--nv-border)!important;border-radius:8px!important;font:inherit!important;font-size:13px!important;color:var(--nv-ink,#111)!important;background:var(--nv-surface,#fff)!important}input.fs-unit.fs-need{border-color:#b42318!important;background:#fdecea!important}.fs-disc{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;flex-wrap:wrap}.fs-disc label{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}.fs-disc input{width:130px;padding:8px 10px;border:1px solid var(--nv-border);border-radius:10px;font:inherit}.fs-costsum{padding:6px 10px;font-size:13px;color:var(--nv-muted)}.fs-costsum.fs-below{color:#b42318;background:#fdecea;border-radius:8px}.fs-costline{color:#7a5af8}.fs-prod .fs-sale-end{flex-wrap:wrap;justify-content:flex-end}.fs-item{display:flex;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--nv-border)}.fs-item small{color:var(--nv-muted)}.fs-qty{display:flex;gap:6px;align-items:center}.fs-qty b{min-width:22px;text-align:center}.fs-item-total{min-width:82px;text-align:right}
  .fs-labchoice{border:1px solid var(--nv-border);border-radius:12px;padding:8px 12px 10px;margin:8px 0 10px;display:flex;flex-direction:column;gap:6px}.fs-labchoice legend{font-weight:600;font-size:14px;padding:0 4px}.fs-labchoice label{display:flex;align-items:baseline;gap:8px;font-size:14px}.fs-labchoice small{color:var(--nv-muted)}.fs-labchoice .fs-labqueue{margin:4px 0 0;padding-top:6px;border-top:1px dashed var(--nv-border)}
  .fs-lbrow{align-items:center;gap:10px}.fs-lbchk input{width:20px;height:20px}.fs-lbfoot{align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap}.fs-stockpage .fs-tabs{flex-wrap:wrap}
  .fs-logwrap{overflow-x:auto;margin-top:6px}.fs-log{width:100%;border-collapse:collapse;font-size:14px}.fs-log th,.fs-log td{padding:8px 6px;border-bottom:1px solid var(--nv-border);text-align:left;vertical-align:top}.fs-log th{font-size:12px;color:var(--nv-muted);font-weight:600}.fs-log .n{text-align:right;white-space:nowrap}.fs-log small{color:var(--nv-muted)}.fs-logf{align-items:flex-end;flex-wrap:wrap}
  .fs-flash{animation:fsFlash 1s ease-out}@keyframes fsFlash{from{background:var(--nv-blue-soft)}to{background:transparent}}
  .fs-cb{border:1px solid #f0c36d;background:#fff8e6;border-radius:12px;padding:10px 12px;margin:8px 0 10px;display:flex;flex-direction:column;gap:6px}.fs-cb>div:first-child{display:flex;flex-direction:column}.fs-cb small{color:var(--nv-muted)}.fs-cb .fs-check{margin:0;font-size:14px}.fs-cb-pay{font-size:15px}.fs-cb-pay b{font-size:18px}
  .fs-cb-badge{display:inline-block;padding:1px 8px;border-radius:999px;background:#fff1cc;color:#7a4b00;font-size:12px;font-weight:700;white-space:nowrap}.fs-cb-note{color:#7a4b00}.fs-cb-all{margin-top:14px}.fs-cb-all summary{cursor:pointer;font-weight:600}
  .fs-pcart-total{display:flex;justify-content:space-between;align-items:center;padding:10px;background:var(--nv-blue-soft)}.fs-pcart-total b{font-size:20px}
  @media(max-width:520px){.fs-item{flex-wrap:wrap}.fs-item-total{min-width:0}}`;

  function injectNav() {
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    const orders = document.querySelector('.nv-menu [data-view="orders"]');
    if (orders) orders.insertAdjacentHTML('afterend', '<button data-view="cash">' + FPIcon('cash') + 'Caixa</button><button data-view="stock">' + FPIcon('package') + 'Estoque</button><button data-view="messages">' + FPIcon('message') + 'Mensagens</button>');
    const phone = document.querySelector('.nv-phone-nav');
    if (phone) { phone.querySelector('[data-view="cameras"]')?.remove(); phone.querySelector('[data-view="home"]')?.insertAdjacentHTML('afterend', '<button data-view="cash">' + FPIcon('cash') + '<div>Caixa</div></button>'); }
  }

  window.FPSales = {
    enabled: () => !!config?.enabled,
    titles: { cash: 'Caixa', stock: 'Estoque', messages: 'Mensagens' },
    moreItems: () => config?.enabled ? [['stock', 'Estoque'], ['messages', 'Mensagens'], ['cameras', 'Câmeras']] : [],
    async load(view, box, alive) {
      box.classList.remove('fs-private');
      if (!config?.enabled) { box.innerHTML = '<section class="nv-card">Recurso não habilitado para esta loja.</section>'; return; }
      if (view === 'cash') return loadCash(box, alive);
      // Estoque pelo menu: as mesmas abas da janela do Caixa, sem precisar abrir o caixa.
      if (view === 'stock') { box.innerHTML = '<section class="nv-card fs-stockpage" id="fsStockPage"></section>'; stockPage = $('fsStockPage'); return productsDialog('', 'list'); }
      return loadMessages(box, alive);
    }
  };
  // Operador novato: some o que ele não pode usar (o servidor também recusa).
  if (token) api('/store/sales/config').then(c => { config = c; document.body.classList.toggle('fs-basic', c.access_level === 'basic'); if (c.enabled) injectNav(); }).catch(() => {});
})();
