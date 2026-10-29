const token = sessionStorage.getItem('nv_token');
const $ = id => document.getElementById(id);
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = value => { const text = String(value || '').trim(); return text ? text[0].toLocaleUpperCase('pt-BR') + text.slice(1) : ''; };
const field = (name, label, value = '', type = 'text') => `<label class="nv-field">${label}<input name="${name}" type="${type}" value="${safe(value)}"></label>`;
const selectOptions = items => items.map(item => `<option value="${safe(item.id)}">${safe(cap(item.name))}</option>`).join('');
const notice = text => `<p class="nv-help">${safe(text)}</p>`;
const isoLocal = d => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
const labels = { queued: 'Na fila', live: 'Em atendimento', paused: 'Pausado', completed: 'Finalizado' };
const detailLabels = { vehicle: 'Veículo', device: 'Aparelho', other: 'Item / serviço' };
const currentStep = o => o.status === 'completed' ? 'Finalizado' : cap(o.steps?.[o.step_index] || labels[o.status]);
const trackingUrl = o => location.origin + '/p/' + o.share_code;
const newest = (a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id.localeCompare(a.id);
let activeView = 'home', storeSettings = {}, cachedOrders = [], cachedProcesses = [], cachedCustomers = [];
let refreshPromise = null, refreshAgain = false, viewVersion = 0;
let orderDate = isoLocal(new Date());
const filters = { home: { search: '', status: '', sort: 'newest' }, orders: { search: '', status: '', sort: 'newest' } };
const openedOrders = new Set();

async function api(path, method = 'GET', body) {
  const response = await fetch('/api' + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(data.error || 'Não foi possível concluir a operação'), {status:response.status});
  return data;
}
function feedback(message, error = false) {
  const node = $('panelFeedback'); node.textContent = message; node.classList.toggle('error', error); node.hidden = !message;
}
const stepsView = o => `<div class="nv-steps">${(o.steps || []).map((step, i) => `<span class="nv-step ${o.status === 'completed' || i < o.step_index ? 'done' : i === o.step_index && o.status === 'live' ? 'active' : ''}">${i + 1}. ${safe(cap(step))}</span>`).join('')}</div>`;
function transitionActions(o) {
  const button = (action, label, primary = false) => `<button type="button" class="nv-button ${primary ? '' : 'secondary'}" data-transition-id="${safe(o.id)}" data-action="${action}">${label}</button>`;
  let html = '';
  if (o.status === 'queued') html += button('start', 'Iniciar atendimento', true) + button('pause', 'Pausar');
  if (o.status === 'live') html += button(o.step_index < o.steps.length - 1 ? 'advance' : 'complete', o.step_index < o.steps.length - 1 ? 'Próxima etapa' : 'Concluir pedido', true) + button('pause', 'Pausar');
  if (o.status === 'paused') html += button('resume', o.started_at ? 'Retomar atendimento' : 'Retomar fila', true);
  if (['live', 'paused'].includes(o.status) && o.step_index > 0) html += button('back', 'Voltar etapa');
  return html;
}
function orderCard(o) {
  const d = o.details || {};
  const item = [d.brand, d.model, d.identifier].filter(Boolean).join(' · ');
  const info = (label, value) => `<div><dt>${label}</dt><dd>${safe(value || 'Não informado')}</dd></div>`;
  return `<div class="nv-order-header"><div><span class="nv-eyebrow">Pedido #${safe(o.external_reference || o.id.slice(0, 8))}</span><h3>${safe(cap(o.customer || 'Cliente não vinculado'))}</h3><p>${safe(o.process)}${item ? ' · ' + safe(item) : ''}</p></div><span class="nv-pill ${o.status === 'completed' ? 'green' : o.status === 'paused' ? 'orange' : ''}">${labels[o.status]}</span></div>
    <div class="nv-order-progress"><strong>${safe(currentStep(o))}</strong><span>${new Date(o.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span></div>${stepsView(o)}
    <div class="nv-order-actions">${transitionActions(o)}<button class="nv-button secondary nv-danger" data-delete-order="${safe(o.id)}">Excluir pedido</button></div>
    <details class="nv-order-details" data-details-id="${safe(o.id)}" ${openedOrders.has(o.id) ? 'open' : ''}><summary>Detalhes do pedido</summary>
      <dl class="nv-detail-grid">${info('Cliente', o.customer)}${info('Contato', o.customer_phone || o.customer_email)}${info('Tipo', detailLabels[d.item_type] || 'Item / serviço')}${info('Marca', d.brand)}${info('Modelo', d.model)}${info('Placa / número de série', d.identifier)}${info('Cor', d.color)}${info('Serviço solicitado', d.service)}${info('Observações internas', d.notes)}</dl>
      <div class="nv-order-actions"><button class="nv-button secondary" data-edit-order="${safe(o.id)}">Editar pedido</button><a class="nv-button secondary" target="_blank" rel="noopener" href="${safe(trackingUrl(o))}">Ver acompanhamento</a><button class="nv-button secondary" data-copy-order="${safe(o.id)}">Copiar link</button><button class="nv-button secondary" data-send-order="${safe(o.id)}">WhatsApp</button></div>
    </details>`;
}
function renderOrderList(container, orders) {
  if (!container) return;
  const existing = new Map([...container.querySelectorAll(':scope > [data-order-id]')].map(node => [node.dataset.orderId, node]));
  container.querySelector(':scope > .nv-empty')?.remove();
  for (const [index, order] of orders.entries()) {
    let node = existing.get(order.id); existing.delete(order.id);
    if (!node) { node = document.createElement('article'); node.className = 'nv-order-card'; node.dataset.orderId = order.id; }
    const signature = JSON.stringify(order);
    if (node.dataset.signature !== signature) { node.innerHTML = orderCard(order); node.dataset.signature = signature; }
    if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
  }
  for (const node of existing.values()) node.remove();
  if (!orders.length) container.innerHTML = '<p class="nv-empty nv-help">Nenhum pedido encontrado com estes filtros.</p>';
}
function toolbar(scope) {
  const state = filters[scope];
  if(scope==='home')return `<div class="nv-home-list-tools"><input type="search" data-filter-scope="home" data-filter="search" aria-label="Buscar pedidos na visão geral" placeholder="Buscar cliente, pedido ou item"><details class="nv-sort-options"><summary>Ordenar</summary><select aria-label="Ordenar pedidos na visão geral" data-filter-scope="home" data-filter="sort"><option value="newest">Mais recentes primeiro</option><option value="oldest">Mais antigos primeiro</option></select></details></div>`;
  return `<div class="nv-order-filters"><label class="nv-field">Buscar pedido<input data-filter-scope="${scope}" data-filter="search" type="search" value="${safe(state.search)}" placeholder="Cliente, número, marca, modelo ou serviço"></label><label class="nv-field">Situação<select data-filter-scope="${scope}" data-filter="status"><option value="">Todas as situações</option>${Object.entries(labels).map(([key, label]) => `<option value="${key}" ${key === state.status ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="nv-field">Ordenar<select data-filter-scope="${scope}" data-filter="sort"><option value="newest">Mais recentes primeiro</option><option value="oldest" ${state.sort === 'oldest' ? 'selected' : ''}>Mais antigos primeiro</option></select></label></div>`;
}
function filteredOrders(scope) {
  const state = filters[scope], term = state.search.trim().toLocaleLowerCase('pt-BR');
  return cachedOrders.filter(o => (!state.status || o.status === state.status) && (scope !== 'orders' || !orderDate || isoLocal(new Date(o.created_at)) === orderDate) && (!term || [o.external_reference, o.customer, o.process, ...Object.values(o.details || {})].some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(term)))).sort(state.sort === 'oldest' ? (a, b) => newest(b, a) : newest);
}
function renderLiveLists() {
  const home = filteredOrders('home'); renderOrderList($('ordersList'), home);
  if ($('homeCount')) $('homeCount').textContent = `${home.length} de ${cachedOrders.length} pedidos`;
  const orders = filteredOrders('orders'); renderOrderList($('datedOrders'), orders);
  if ($('orderCount')) $('orderCount').textContent = `${orders.length} de ${cachedOrders.length} pedidos`;
  const today = isoLocal(new Date());
  const counts = [cachedOrders.filter(o => isoLocal(new Date(o.created_at)) === today).length, cachedOrders.filter(o => o.status === 'live').length, cachedOrders.filter(o => o.status === 'queued').length, cachedOrders.filter(o => o.status === 'completed').length];
  document.querySelectorAll('#dashboardContent .nv-number').forEach((node, i) => node.textContent = String(counts[i]).padStart(2, '0'));
  if (activeView === 'queues') drawQueue();
  const dialogOrder = cachedOrders.find(o => o.id === $('editorDialog').dataset.orderId);
  if (dialogOrder) {
    const status = $('editorDialog').querySelector('[data-dialog-order-status]');
    if (status) status.textContent = `${labels[dialogOrder.status]} · ${currentStep(dialogOrder)}`;
    const actions = $('editorDialog').querySelector('[data-dialog-order-actions]');
    if (actions) actions.innerHTML = transitionActions(dialogOrder);
  }
}
async function reload(force = false) {
  if (refreshPromise) { if (force) refreshAgain = true; return refreshPromise; }
  refreshPromise = (async () => {
    do {
      refreshAgain = false;
      const [orders, processes] = await Promise.all([api('/orders'), api('/processes')]);
      cachedOrders = orders.sort(newest); cachedProcesses = processes; renderLiveLists();
      const select = $('quickProcess');
      if (select && !select.matches(':focus')) { const value = select.value; select.innerHTML = '<option value="">Acompanhamento rápido padrão</option>' + selectOptions(processes); select.value = value; }
      $('syncStatus').textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } while (refreshAgain);
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
function detailFields(d = {}) {
  return `<div class="nv-form-grid"><label class="nv-field">Tipo<select name="detail_item_type">${Object.entries(detailLabels).map(([key, label]) => `<option value="${key}" ${key === (d.item_type || storeSettings.default_item_type || 'other') ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${field('detail_brand', 'Marca', d.brand)}${field('detail_model', 'Modelo', d.model)}${field('detail_identifier', 'Placa / número de série', d.identifier)}${field('detail_color', 'Cor', d.color)}</div>`;
}
const serviceFields = d => `${field('detail_service', 'Serviço solicitado', d?.service)}<label class="nv-field">Observações internas<textarea name="detail_notes" rows="3" maxlength="2000">${safe(d?.notes)}</textarea></label>`;
const readDetails = data => Object.fromEntries([...data].filter(([key]) => key.startsWith('detail_')).map(([key, value]) => [key.slice(7), String(value).trim()]));
function openDialog(html, orderId = '') {
  const dialog = $('editorDialog'); dialog.innerHTML = html; dialog.dataset.orderId = orderId;
  if (!dialog.open) dialog.showModal();
}
const dialogHeader = title => `<div class="nv-heading"><h2 id="dialogTitle">${title}</h2><button type="button" class="nv-button secondary" data-close-dialog aria-label="Fechar">✕</button></div>`;
async function editOrder(id) {
  const o = cachedOrders.find(row => row.id === id); if (!o) return;
  const customers = await api('/customers');
  openDialog(`${dialogHeader('Editar pedido')}<p data-dialog-order-status>${labels[o.status]} · ${safe(currentStep(o))}</p><div class="nv-order-actions" data-dialog-order-actions>${transitionActions(o)}</div><form id="editOrderForm"><section class="nv-form-panel"><h3>Cliente e identificação</h3>${field('reference', 'Número do pedido', o.external_reference)}<label class="nv-field">Cliente<select name="customer_id"><option value="">Manter cliente atual</option>${selectOptions(customers)}</select></label></section><section class="nv-form-panel"><h3>Dados do item</h3>${detailFields(o.details)}</section><section class="nv-form-panel"><h3>Serviço e observações</h3>${serviceFields(o.details)}</section><div class="nv-row"><button class="nv-button">Salvar alterações</button><button type="button" class="nv-button secondary" data-close-dialog>Cancelar</button></div><p role="status"></p></form>`, id);
  $('editOrderForm').onsubmit = async e => {
    e.preventDefault(); const form = e.currentTarget, data = new FormData(form), button = form.querySelector('[type="submit"],button'); button.disabled = true;
    try { await api('/orders/' + id, 'PATCH', { reference: String(data.get('reference')).trim(), details: readDetails(data), ...(data.get('customer_id') ? { customer_id: data.get('customer_id') } : {}) }); $('editorDialog').close(); await reload(true); feedback('Pedido atualizado.'); }
    catch (error) { form.querySelector('[role="status"]').textContent = error.message; }
    finally { button.disabled = false; }
  };
}
async function loadOrders(box, version) {
  const [customers, processes] = await Promise.all([api('/customers'), api('/processes')]); if(version !== viewVersion) return; cachedCustomers = customers;
  box.innerHTML = `<section class="nv-card" id="newOrderCard"><div class="nv-heading"><h2>Novo pedido</h2><span class="nv-help">Cadastre e acompanhe por aqui</span></div><form id="completeForm">
    <section class="nv-form-panel"><div class="nv-heading"><h3>1. Cliente</h3><button type="button" class="nv-button secondary" id="addInlineCustomer">+ Cadastrar cliente</button></div><label class="nv-field">Cliente<select name="customer_id" required><option value="">Selecione o cliente</option>${selectOptions(customers)}</select></label>
      <div id="inlineCustomer" class="nv-inline-panel" hidden><h4>Novo cliente</h4><div class="nv-form-grid">${field('inline_name', 'Nome completo')}${field('inline_phone', 'Telefone / WhatsApp')}${field('inline_email', 'E-mail', '', 'email')}${field('inline_address', 'Endereço')}</div><button type="button" class="nv-button secondary" id="saveInlineCustomer">Salvar cliente e selecionar</button><button type="button" class="nv-button secondary" id="cancelInlineCustomer">Cancelar</button><p id="inlineCustomerStatus" role="status"></p></div>
    </section><section class="nv-form-panel"><h3>2. Dados do item</h3>${detailFields()}</section>
    <section class="nv-form-panel"><h3>3. Serviço e acompanhamento</h3><div class="nv-form-grid">${field('reference', 'Número do pedido (opcional)')}<label class="nv-field">Processo<select name="process_id" required><option value="">Selecione o processo</option>${selectOptions(processes)}</select></label></div><div id="processPreview" class="nv-help">Selecione um processo para visualizar as etapas.</div>${serviceFields()}</section>
    <button class="nv-button" type="submit">Criar pedido</button><p id="completeStatus" role="status"></p></form><div id="completeLink" hidden></div></section>
    <section class="nv-card"><div class="nv-heading"><h2>Pedidos da loja</h2><span class="nv-help" id="orderCount"></span></div>${toolbar('orders')}<div class="nv-datebar"><label>Dia <input id="orderDate" type="date" aria-label="Selecionar dia" value="${orderDate}"></label><button class="nv-button secondary" id="allDates">Todos os dias</button></div><div class="nv-list" id="datedOrders"></div></section>`;
  const form = $('completeForm');
  $('addInlineCustomer').onclick = () => { $('inlineCustomer').hidden = false; form.elements.inline_name.focus(); };
  $('cancelInlineCustomer').onclick = () => { $('inlineCustomer').hidden = true; };
  $('saveInlineCustomer').onclick = async () => {
    const button = $('saveInlineCustomer'); button.disabled = true;
    try {
      const customer = await api('/customers', 'POST', { name: form.elements.inline_name.value.trim(), phone: form.elements.inline_phone.value.trim(), email: form.elements.inline_email.value.trim(), address: form.elements.inline_address.value.trim() });
      cachedCustomers.push(customer); form.elements.customer_id.add(new Option(customer.name, customer.id)); form.elements.customer_id.value = customer.id; $('inlineCustomer').hidden = true; $('inlineCustomerStatus').textContent = '';
      for (const name of ['inline_name', 'inline_phone', 'inline_email', 'inline_address']) form.elements[name].value = '';
      feedback('Cliente cadastrado e selecionado para este pedido.');
    } catch (error) { $('inlineCustomerStatus').textContent = error.message; }
    finally { button.disabled = false; }
  };
  form.elements.process_id.onchange = () => { const p = processes.find(p => p.id === form.elements.process_id.value); $('processPreview').innerHTML = p ? stepsView({ steps: p.steps, status: 'queued', step_index: 0 }) : 'Selecione um processo para visualizar as etapas.'; };
  $('orderDate').onchange = e => { orderDate = e.target.value; renderLiveLists(); };
  $('allDates').onclick = () => { orderDate = ''; $('orderDate').value = ''; renderLiveLists(); };
  form.onsubmit = async e => {
    e.preventDefault(); const data = new FormData(form), button = form.querySelector('[type="submit"]'); button.disabled = true; $('completeStatus').textContent = '';
    try {
      const result = await api('/orders', 'POST', { customer_id: data.get('customer_id'), process_id: data.get('process_id'), reference: String(data.get('reference')).trim(), details: readDetails(data) });
      form.reset(); $('inlineCustomer').hidden = true; $('processPreview').textContent = 'Selecione um processo para visualizar as etapas.';
      $('completeStatus').textContent = 'Pedido criado e lista atualizada.'; $('completeLink').hidden = false;
      $('completeLink').innerHTML = `<label class="nv-field">Link de acompanhamento<input readonly value="${safe(result.tracking_url)}"></label><a target="_blank" rel="noopener" href="${safe(result.tracking_url)}">Abrir acompanhamento</a>`;
      orderDate = isoLocal(new Date()); $('orderDate').value = orderDate; filters.orders.search = ''; filters.orders.status = ''; document.querySelectorAll('[data-filter-scope="orders"]').forEach(node => { if (node.dataset.filter !== 'sort') node.value = ''; });
      await reload(true); feedback('Pedido criado com sucesso.');
    } catch (error) { $('completeStatus').textContent = error.message; }
    finally { button.disabled = false; }
  };
  renderLiveLists();
}
function drawQueue() {
  const container = $('queueList'); if (!container) return;
  const orders = cachedOrders.filter(o => o.status === 'queued').sort((a, b) => (a.queue_rank ?? Infinity) - (b.queue_rank ?? Infinity) || newest(b, a));
  const html = orders.map((o, i) => `<article class="nv-order"><div><strong>${i + 1}º · #${safe(o.external_reference || o.id.slice(0, 8))}</strong><p>${safe(o.customer || o.process)}</p></div><div class="nv-queue-actions"><button class="nv-button secondary" data-queue-id="${o.id}" data-delta="-1" ${i === 0 ? 'disabled' : ''} aria-label="Subir na fila">↑</button><button class="nv-button secondary" data-queue-id="${o.id}" data-delta="1" ${i === orders.length - 1 ? 'disabled' : ''} aria-label="Descer na fila">↓</button></div></article>`).join('') || notice('Nenhum pedido aguardando.');
  if (container.innerHTML !== html) container.innerHTML = html;
}
function customerFields(c = {}) { return `<div class="nv-form-grid">${field('name', 'Nome completo', c.name)}${field('phone', 'Telefone / WhatsApp', c.phone)}${field('email', 'E-mail', c.email, 'email')}${field('address', 'Endereço', c.address)}</div>`; }
function drawCustomers() {
  const container = $('customerList'); if (!container) return;
  const search = ($('customerSearch')?.value || '').trim().toLocaleLowerCase('pt-BR');
  const customers = cachedCustomers.filter(c => [c.name, c.phone, c.email, c.address].some(v => String(v || '').toLocaleLowerCase('pt-BR').includes(search)));
  $('customerCount').textContent = `${customers.length} de ${cachedCustomers.length} clientes`;
  container.innerHTML = customers.map(c => `<article class="nv-customer-row"><div class="nv-customer-avatar" aria-hidden="true">${safe((c.name || '?').slice(0, 1).toLocaleUpperCase('pt-BR'))}</div><div class="nv-customer-info"><h3>${safe(cap(c.name))}</h3><p>${safe(c.phone || 'Telefone não informado')}${c.email ? ' · ' + safe(c.email) : ''}</p>${c.address ? `<p>${safe(c.address)}</p>` : ''}</div><div class="nv-customer-actions">${c.phone ? `<a class="nv-phone-link" href="https://wa.me/${String(c.phone).replace(/\D/g, '').startsWith('55') ? '' : '55'}${String(c.phone).replace(/\D/g, '')}" target="_blank" rel="noopener">WhatsApp</a>` : ''}<button class="nv-button secondary" data-edit-customer="${safe(c.id)}">Editar</button></div></article>`).join('') || notice('Nenhum cliente encontrado.');
}
function editCustomer(id) {
  const c = cachedCustomers.find(c => c.id === id); if (!c) return;
  openDialog(`${dialogHeader('Editar cliente')}<form id="editCustomerForm">${customerFields(c)}<div class="nv-row"><button class="nv-button">Salvar alterações</button><button type="button" class="nv-button secondary" data-close-dialog>Cancelar</button></div><p role="status"></p></form>`);
  $('editCustomerForm').onsubmit = async e => {
    e.preventDefault(); const form = e.currentTarget;
    try { await api('/customers/' + id, 'PATCH', Object.fromEntries(new FormData(form))); cachedCustomers = await api('/customers'); drawCustomers(); $('editorDialog').close(); await reload(true); feedback('Cliente atualizado.'); }
    catch (error) { form.querySelector('[role="status"]').textContent = error.message; }
  };
}
function parseCsv(raw) {
  const firstLine = raw.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ',';
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') { if (quoted && raw[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (ch === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if (['\r', '\n'].includes(ch) && !quoted) { if (ch === '\r' && raw[i + 1] === '\n') i++; row.push(cell); if (row.some(c => c.trim())) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (quoted) throw Error('CSV com aspas não fechadas');
  row.push(cell); if (row.some(c => c.trim())) rows.push(row); return rows;
}
async function loadCustomers(box, version) {
  const customers = await api('/customers'); if(version !== viewVersion) return; cachedCustomers = customers;
  box.innerHTML = `<section class="nv-card"><div class="nv-heading"><h2>Clientes</h2><button class="nv-button" id="newCustomer">+ Cadastrar cliente</button></div><div class="nv-heading"><input id="customerSearch" type="search" placeholder="Pesquisar por nome, telefone, e-mail ou endereço" aria-label="Pesquisar clientes"><span id="customerCount" class="nv-help"></span></div><div id="customerList" class="nv-customer-list"></div></section><details class="nv-card"><summary>Importar clientes por CSV</summary><p class="nv-help">Colunas: Nome, Email, Telefone e Endereco. Até 300 clientes por arquivo.</p><input id="customerCsv" type="file" accept=".csv,text/csv"><p id="importPreview" role="status"></p><button class="nv-button secondary" id="importConfirm" disabled>Importar lista</button></details>`;
  $('customerSearch').oninput = drawCustomers;
  $('newCustomer').onclick = () => {
    openDialog(`${dialogHeader('Cadastrar cliente')}<form id="customerForm">${customerFields()}<button class="nv-button">Cadastrar cliente</button><p role="status"></p></form>`);
    $('customerForm').onsubmit = async e => { e.preventDefault(); const form = e.currentTarget; try { await api('/customers', 'POST', Object.fromEntries(new FormData(form))); cachedCustomers = await api('/customers'); drawCustomers(); $('editorDialog').close(); feedback('Cliente cadastrado.'); } catch (error) { form.querySelector('[role="status"]').textContent = error.message; } };
  };
  let importRows = [];
  $('customerCsv').onchange = async e => {
    $('importConfirm').disabled = true;
    try {
      const file = e.target.files[0]; if (!file) return; if (file.size > 250000) throw Error('CSV deve ter até 250 KB');
      const rows = parseCsv((await file.text()).replace(/^\uFEFF/, ''));
      const header = (rows.shift() || []).map(v => v.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
      const column = (...names) => header.findIndex(v => names.includes(v));
      if (column('nome', 'name') < 0) throw Error('Coluna Nome não encontrada');
      importRows = rows.map(row => ({ name: (row[column('nome', 'name')] || '').trim(), email: (row[column('email', 'e-mail')] || '').trim(), phone: (row[column('telefone', 'whatsapp', 'phone')] || '').trim(), address: (row[column('endereco', 'address')] || '').trim() }));
      if (importRows.length > 300 || importRows.some(c => c.name.length < 2)) throw Error('Revise os nomes e limite o arquivo a 300 clientes');
      $('importPreview').textContent = `${importRows.length} clientes prontos para importar.`; $('importConfirm').disabled = !importRows.length;
    } catch (error) { $('importPreview').textContent = error.message; }
  };
  $('importConfirm').onclick = async () => { const button = $('importConfirm'); button.disabled = true; try { await api('/customers/import', 'POST', { customers: importRows }); cachedCustomers = await api('/customers'); drawCustomers(); $('importPreview').textContent = 'Importação concluída.'; } catch (error) { $('importPreview').textContent = error.message; button.disabled = false; } };
  drawCustomers();
}

// Existing camera, process and settings editors are kept below.
async function loadSection(view) {
  const box = $('sectionContent'), version = ++viewVersion;
  box.innerHTML = '<section class="nv-card">Carregando…</section>';
  try {
    if (view === 'orders') return await loadOrders(box, version);
    if (view === 'customers') return await loadCustomers(box, version);
    if (view === 'more') { box.innerHTML = '<section class="nv-card"><h2>Mais opções</h2><div class="nv-list">'+[['customers','Clientes'],['processes','Processos'],['plan','Meu plano'],['settings','Configurações'],['support','Suporte']].map(([key,label])=>'<button class="nv-button secondary" data-view="'+key+'">'+label+'</button>').join('')+'</div></section>';return;}
    if (view === 'queues') { box.innerHTML = '<section class="nv-card"><h2>Fila de atendimento</h2><p class="nv-help">Atendimento por ordem de chegada. Use as setas para definir uma prioridade manual.</p><div id="queueList" class="nv-list"></div></section>'; drawQueue(); return; }
    await loadEditor(view, box, version);
  } catch (error) { if (version === viewVersion) box.innerHTML = `<section class="nv-card" role="alert">${safe(error.message)}</section>`; }
}
async function switchView(view) {
  activeView = view;
  document.querySelectorAll('[data-view]').forEach(node => node.classList.toggle('active', node.dataset.view === view));
  $('dashboardContent').hidden = view !== 'home'; $('sectionContent').hidden = view === 'home';
  const names = { home: 'Visão geral', orders: 'Pedidos', customers: 'Clientes', queues: 'Fila de atendimento', processes: 'Processos', cameras: 'Câmeras', settings: 'Configurações', support: 'Suporte', plan:'Meu plano', more:'Mais opções' };
  document.querySelector('.nv-top h1').textContent = names[view] || '';
  if (view !== 'home') await loadSection(view); else { viewVersion++; renderLiveLists(); }
}
document.addEventListener('toggle', e => {
  const id = e.target.dataset?.detailsId; if (!id || !e.target.isConnected) return;
  if (e.target.open) openedOrders.add(id); else openedOrders.delete(id);
}, true);
document.addEventListener('input', e => {
  if (!e.target.dataset.filter) return;
  filters[e.target.dataset.filterScope][e.target.dataset.filter] = e.target.value; renderLiveLists();
});
document.addEventListener('click', async e => {
  const button = e.target.closest('button'); if (!button) return;
  try {
    if (button.dataset.view) { await switchView(button.dataset.view); return; }
    if (button.hasAttribute('data-close-dialog')) { $('editorDialog').close(); return; }
    if (button.dataset.editOrder) { await editOrder(button.dataset.editOrder); return; }
    if (button.dataset.editCustomer) { editCustomer(button.dataset.editCustomer); return; }
    if (button.dataset.transitionId) {
      const o = cachedOrders.find(o => o.id === button.dataset.transitionId); if (!o) return;
      button.disabled = true;
      try { await api('/orders/' + o.id + '/transition', 'POST', { action: button.dataset.action, expected_step_index: o.step_index, expected_status: o.status }); await reload(true); feedback('Pedido atualizado.'); }
      catch (error) { await reload(true); throw error; }
      finally { if (button.isConnected) button.disabled = false; }
    }
    if (button.dataset.copyOrder) { const o = cachedOrders.find(o => o.id === button.dataset.copyOrder); await navigator.clipboard.writeText(trackingUrl(o)); feedback('Link copiado.'); }
    if (button.dataset.sendOrder) { const o = cachedOrders.find(o => o.id === button.dataset.sendOrder); window.open('https://wa.me/?text=' + encodeURIComponent('Acompanhe seu pedido: ' + trackingUrl(o)), '_blank', 'noopener,noreferrer'); }
    if (button.dataset.deleteOrder && confirm('Excluir este pedido? O link será desativado, o vídeo ao vivo será bloqueado e gravações em andamento serão finalizadas. Os arquivos já gravados não serão apagados do computador.')) { await api('/orders/' + button.dataset.deleteOrder, 'DELETE'); await reload(true); feedback('Pedido excluído.'); }
    if (button.dataset.queueId) {
      const ids = cachedOrders.filter(o => o.status === 'queued').sort((a, b) => (a.queue_rank ?? Infinity) - (b.queue_rank ?? Infinity) || newest(b, a)).map(o => o.id);
      const from = ids.indexOf(button.dataset.queueId), to = from + Number(button.dataset.delta); if (from < 0 || to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to], ids[from]]; button.disabled = true;
      await api('/orders/queue-order', 'PUT', { ids }); await reload(true);
    }
  } catch (error) { feedback(error.message, true); if (button.isConnected) button.disabled = false; }
});
$('newOrderHome').onclick = () => switchView('orders');
$('logout').onclick = () => { sessionStorage.removeItem('nv_token'); location.replace('/'); };
$('createQuick').onclick = async () => {
  const reference = $('reference').value.trim(); if (!reference) { $('quickError').textContent = 'Informe o número do pedido.'; return; }
  $('createQuick').disabled = true;
  try { const result = await api('/orders/quick', 'POST', { reference, process_id: $('quickProcess').value || null }); $('trackingLink').value = result.tracking_url; $('waLink').href = 'https://wa.me/?text=' + encodeURIComponent('Acompanhe seu pedido: ' + result.tracking_url); $('quickResult').hidden = false; $('quickError').textContent = ''; $('reference').value = ''; await reload(true); }
  catch (error) { $('quickError').textContent = error.message; }
  finally { $('createQuick').disabled = false; }
};
$('copyLink').onclick = async () => { try { await navigator.clipboard.writeText($('trackingLink').value); feedback('Link copiado.'); } catch { $('trackingLink').select(); } };
async function refreshVisible() {
  if (document.hidden) return;
  try { await reload(); } catch(error) { $('syncStatus').textContent = error.status===403?'Acesso bloqueado pela central.':'Conexão interrompida. Tentando atualizar novamente…';if(error.status===403)feedback(error.message,true); }
}
document.addEventListener('visibilitychange', refreshVisible);
window.addEventListener('focus', refreshVisible);
setInterval(refreshVisible, 5000);
(async () => {
  if (!token) { location.replace('/'); return; }
  try {
    const me = await api('/me'); if (!['owner', 'operator'].includes(me.role)) { location.replace('/'); return; }
    storeSettings = await api('/store/settings');
    $('storeBrandName').textContent = storeSettings.name || 'Minha loja'; document.querySelector('.nv-profile span').textContent = storeSettings.name || 'Minha loja';
    if (storeSettings.logo_url) { const img = document.createElement('img'); img.src = storeSettings.logo_url; img.alt = 'Logo da loja'; img.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:10px'; $('storeBrandIcon').replaceChildren(img); }
    $('homeFilters').innerHTML = toolbar('home');
    $('homeStatusFilter').innerHTML='<label class="nv-compact-filter"><span class="nv-help">Exibir</span><select aria-label="Exibir pedidos na visão geral" data-filter-scope="home" data-filter="status"><option value="">Todos</option>'+Object.entries(labels).map(([key,label])=>'<option value="'+key+'">'+label+'</option>').join('')+'</select></label>';
    await reload(); if (location.hash === '#orders') await switchView('orders');
  } catch (error) { feedback(error.message, true); }
})();

async function loadEditor(view, box, version) {
 if(view==='cameras'){
 const cameras=await api('/cameras');if(version!==viewVersion)return;
 box.innerHTML='<section class="nv-card"><h2>Câmeras autorizadas</h2><p class="nv-help">Cadastro, instalação, troca e remoção são realizados pela central ou por técnicos autorizados. Seu painel utiliza apenas as câmeras liberadas para esta loja.</p><div class="nv-list">'+cameras.map(c=>'<article class="nv-order"><div><strong>'+safe(c.name)+'</strong><p>'+safe(c.station||'Sem setor informado')+'</p></div><span class="nv-pill '+(c.enabled?'':'orange')+'">'+safe(c.enabled?(c.status==='ready'?'Configurada':c.status==='offline'?'Sem conexão':'Em configuração'):'Bloqueada pela central')+'</span></article>').join('')+'</div></section>';
 }else if(view==='processes'){

 const [processes,cameras]=await Promise.all([api('/processes'),api('/cameras')]);
 if(version!==viewVersion)return;
 const camSelect=(selected='')=>'<select name="camera_id"><option value="">Sem câmera</option>'+cameras.map(x=>'<option value="'+safe(x.id)+'" '+(x.id===selected?'selected':'')+'>'+safe(x.name)+'</option>').join('')+'</select>';
 const stepCamSelect=(selected='')=>camSelect(selected).replace('<option value="">Sem câmera</option>','<option value="">Usar câmera padrão</option><option value="none" '+(selected==='none'?'selected':'')+'>Sem câmera nesta etapa</option>');
 const stepCameraFields=(p)=>'<div class="step-cam-list" data-process="'+safe(p.id)+'">'+p.steps.map((step,i)=>'<label class="nv-field">'+safe(cap(step))+' '+stepCamSelect(Object.hasOwn(p.step_cameras||{},String(i))?(p.step_cameras[i]===null?'none':p.step_cameras[i]):'').replace('name="camera_id"','name="step_'+i+'"')+'</label>').join('')+'</div>';
 box.innerHTML='<section class="nv-card"><h2>Cadastrar processo</h2><form id="processForm"><div class="nv-process-head">'+field('name','Nome do processo')+'<label class="nv-field">Câmera padrão'+camSelect()+'</label></div><label class="nv-field">Etapas separadas por vírgulas<textarea name="steps" rows="2" required placeholder="Recebimento, Análise, Finalização"></textarea></label><h3>Câmera por etapa</h3><div id="newStepCameras" class="step-cam-list"></div><button class="nv-button">Salvar processo</button><p id="processStatus" role="status"></p></form></section><section class="nv-card"><h2>Processos cadastrados</h2>'+processes.map(p=>'<form class="nv-process-edit nv-order" data-id="'+safe(p.id)+'"><div style="flex:1;min-width:230px">'+field('name','Processo',p.name)+'<label class="nv-field">Etapas<textarea name="steps" rows="2">'+safe(p.steps.join(', '))+'</textarea></label><label class="nv-field">Câmera padrão'+camSelect(p.camera_id||'')+'</label><div class="nv-help">Câmera de cada etapa</div>'+stepCameraFields(p)+'</div><button class="nv-button secondary">Salvar alterações</button><p class="nv-error" role="status"></p></form>').join('')+notice('Alterações valem para novos pedidos. Pedidos existentes preservam suas etapas e câmeras originais.')+'</section>';
 const drawNewSteps=()=>{const f=$('processForm');const steps=f.elements.steps.value.split(',').map(cap).filter(Boolean).slice(0,30);const previous=new Map([...$('newStepCameras').querySelectorAll('select')].map(s=>[s.name,s.value]));$('newStepCameras').innerHTML=steps.map((step,i)=>'<label class="nv-field">'+safe(step)+stepCamSelect(previous.get('step_'+i)||'').replace('name="camera_id"','name="step_'+i+'"')+'</label>').join('')};
 $('processForm').elements.steps.addEventListener('input',drawNewSteps);
 $('processForm').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget;try{await api('/processes','POST',{name:cap(f.elements.name.value),steps:f.elements.steps.value.split(',').map(cap).filter(Boolean),camera_id:f.elements.camera_id.value||null,step_cameras:Object.fromEntries([...new FormData(f).entries()].filter(([k,v])=>k.startsWith('step_')&&v).map(([k,v])=>[k.slice(5),v==='none'?null:v]))});await loadSection('processes');await reload()}catch(err){$('processStatus').textContent=err.message}};
 document.querySelectorAll('.nv-process-edit').forEach(form=>form.onsubmit=async e=>{e.preventDefault();const d=new FormData(form);try{await api('/processes/'+form.dataset.id,'PATCH',{name:cap(d.get('name')),steps:String(d.get('steps')).split(',').map(cap).filter(Boolean),camera_id:d.get('camera_id')||null,step_cameras:Object.fromEntries([...d.entries()].filter(([k,v])=>k.startsWith('step_')&&v).map(([k,v])=>[k.slice(5),v==='none'?null:v]))});form.querySelector('.nv-error').textContent='Salvo';await reload()}catch(err){form.querySelector('.nv-error').textContent=err.message}});
 
 }else if(view==='settings'){

 const [settings,loyalty]=await Promise.all([api('/store/settings'),api('/store/loyalty')]);
 if(version!==viewVersion)return;
 box.innerHTML='<section class="nv-card"><h2>Identidade da loja</h2><p class="nv-help">Nicho: '+safe(settings.niche_label||'Serviços em geral')+' · Definido pelo administrador.</p><form id="settingsForm">'+field('name','Nome da loja',settings.name)+'<label class="nv-field">Logo da loja (PNG, JPG ou WebP, até 256 KB)<input id="logoFile" type="file" accept="image/png,image/jpeg,image/webp"></label><div id="logoDrop" class="nv-drop" tabindex="0">Arraste a imagem aqui ou selecione acima</div><img id="logoPreview" hidden alt="Prévia da imagem" style="width:90px;height:90px;object-fit:contain"><button class="nv-button" type="button" id="uploadLogo">Enviar logo</button><button class="nv-button secondary" type="submit">Salvar nome da loja</button><p id="settingsStatus" role="status"></p></form></section><section class="nv-card"><h2>Programa de fidelidade</h2><form id="loyaltyForm"><label><input type="checkbox" name="enabled" '+(loyalty.loyalty_enabled?'checked':'')+'> Ativar fidelidade</label>'+field('target','Check-ins necessários',loyalty.loyalty_target,'number')+'<label class="nv-field">Recompensa<textarea name="reward">'+safe(loyalty.loyalty_reward||'')+'</textarea></label><button class="nv-button">Salvar fidelidade</button><p id="loyaltyStatus" role="status"></p></form></section><section class="nv-card"><h2>Validar cupom</h2><form id="redeemForm">'+field('code','Código')+'<button class="nv-button">Validar cupom</button><p id="redeemFeedback" role="status"></p></form></section>';
 $('settingsForm').onsubmit=async e=>{e.preventDefault();const name=e.currentTarget.elements.name.value.trim();try{await api('/store/settings','PATCH',{name,logo_url:settings.logo_url||'',email_notifications:settings.email_notifications||'off'});$('storeBrandName').textContent=name;document.querySelector('.nv-profile span').textContent=name;$('settingsStatus').textContent='Nome atualizado'}catch(err){$('settingsStatus').textContent=err.message}};
 const fileInput=$('logoFile'),drop=$('logoDrop');let selected=null;const preview=file=>{if(!file)return;selected=file;drop.textContent=file.name;const im=$('logoPreview');im.hidden=false;im.src=URL.createObjectURL(file)};
 fileInput.onchange=()=>preview(fileInput.files[0]);drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag')};drop.ondragleave=()=>drop.classList.remove('drag');drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');preview(e.dataTransfer.files[0])};drop.onclick=()=>fileInput.click();
 $('uploadLogo').onclick=async()=>{if(!selected){$('settingsStatus').textContent='Selecione uma imagem';return}if(selected.size>262144){$('settingsStatus').textContent='Imagem maior que 256 KB. Reduza o tamanho.';return}try{const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(selected)});const r=await api('/store/logo','PUT',{mime_type:selected.type,base64});settings.logo_url=r.logo_url;$('storeBrandIcon').innerHTML='<img src="'+safe(r.logo_url)+'?v='+Date.now()+'" alt="Logo" style="width:100%;height:100%;object-fit:contain">';$('settingsStatus').textContent='Logo atualizado'}catch(err){$('settingsStatus').textContent=err.message}};
 $('loyaltyForm').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget;try{await api('/store/loyalty','PATCH',{loyalty_enabled:f.elements.enabled.checked,loyalty_target:Number(f.elements.target.value),loyalty_reward:f.elements.reward.value.trim()});$('loyaltyStatus').textContent='Fidelidade atualizada'}catch(err){$('loyaltyStatus').textContent=err.message}};
 $('redeemForm').onsubmit=async e=>{e.preventDefault();try{const r=await api('/store/loyalty/redeem','POST',{code:e.currentTarget.elements.code.value.trim().toUpperCase()});$('redeemFeedback').textContent='Cupom validado: '+r.reward}catch(err){$('redeemFeedback').textContent=err.message}};
 
 }else if(view==='plan'){
 const settings=await api('/store/settings');if(version!==viewVersion)return;
 box.innerHTML='<section class="nv-card"><h2>Meu plano</h2><p class="nv-help">A quantidade de câmeras é liberada pela central. Solicitar uma alteração não modifica o plano automaticamente.</p><div class="nv-form-grid"><div class="nv-form-panel"><h3>Câmeras contratadas</h3><strong class="nv-number">'+settings.camera_limit+'</strong></div><div class="nv-form-panel"><h3>Câmeras cadastradas</h3><strong class="nv-number">'+settings.camera_count+'</strong></div></div><label class="nv-field">Quantidade de câmeras desejada<input id="requestedCameras" type="number" min="1" max="128" value="'+Math.min(128,settings.camera_limit+1)+'"></label><a id="salesContact" class="nv-button" target="_blank" rel="noopener">Conversar sobre meu plano no WhatsApp</a><p id="salesContactStatus" class="nv-help"></p></section>';
 const updateLink=()=>{const quantity=Number($('requestedCameras').value),link=$('salesContact');if(!settings.sales_whatsapp){link.removeAttribute('href');link.setAttribute('aria-disabled','true');$('salesContactStatus').textContent='O contato comercial ainda não foi configurado pela central.';return;}if(!Number.isInteger(quantity)||quantity<1||quantity>128){link.removeAttribute('href');$('salesContactStatus').textContent='Informe uma quantidade entre 1 e 128 câmeras.';return;}link.removeAttribute('aria-disabled');link.href='https://wa.me/'+settings.sales_whatsapp+'?text='+encodeURIComponent('Olá! Sou da loja '+settings.name+' ('+settings.slug+'). Meu plano permite '+settings.camera_limit+' câmera(s) e gostaria de contratar um plano para '+quantity+' câmera(s).');$('salesContactStatus').textContent='Você falará diretamente com os atendentes da central.';};
 $('requestedCameras').oninput=updateLink;updateLink();
 }else if(view==='support'){box.innerHTML='<section class="nv-card"><h2>Suporte NextVision</h2><p class="nv-help">Entre em contato pelo canal indicado na contratação.</p></section>'}
}
