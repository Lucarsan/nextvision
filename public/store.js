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
const trackingUrl = o => (o.order_number && storeSettings.slug) ? (storeSettings.short_link_base || location.origin) + '/' + storeSettings.slug + '/' + o.order_number : location.origin + '/p/' + o.share_code;
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
function showUndo(id, [action, label]) {
  const node = $('panelFeedback'); const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'nv-button secondary fp-undo'; btn.textContent = label; btn.dataset.transitionId = id; btn.dataset.action = action;
  node.append(' ', btn); clearTimeout(showUndo.timer); showUndo.timer = setTimeout(() => btn.remove(), 15000);
}
function showWhatsOffer(o, key = 'started') {
  const node = $('panelFeedback'); const a = document.createElement('a'); a.className = 'nv-button fp-whats'; a.target = '_blank'; a.rel = 'noopener'; a.href = whatsFor(o, key); a.textContent = whatsPhone(o) ? 'Avisar cliente no WhatsApp' : 'Avisar no WhatsApp';
  node.append(' ', a);
}
function feedback(message, error = false) {
  const node = $('panelFeedback'); node.textContent = message; node.classList.toggle('error', error); node.hidden = !message;
}
const stepsView = o => `<div class="nv-steps">${(o.steps || []).map((step, i) => `<span class="nv-step ${o.status === 'completed' || i < o.step_index ? 'done' : i === o.step_index && o.status === 'live' ? 'active' : ''}">${i + 1}. ${safe(cap(step))}</span>`).join('')}</div>`;

const canReopen = o => o.status === 'completed' && o.completed_at && Date.now() - new Date(o.completed_at) < 24 * 3600000;
function undoButtons(o, b) {
  if (['live', 'paused'].includes(o.status) && o.step_index > 0) return b('back', 'Voltar etapa');
  if (['live', 'paused'].includes(o.status) && o.started_at) return b('back', 'Voltar para a fila');
  if (canReopen(o)) return b('reopen', 'Reabrir pedido');
  return '';
}
const undoOf = { advance: ['back', 'Desfazer avanço'], complete: ['reopen', 'Reabrir pedido'], start: ['back', 'Desfazer início'], back: null };
const DEFAULT_TEMPLATES = {
  created: 'Olá, {cliente}! Recebemos seu {item} na {loja} (pedido {pedido}). Acompanhe por aqui, inclusive ao vivo: {link}',
  started: 'Olá, {cliente}! Começamos o atendimento do seu {item}. Acompanhe ao vivo: {link}',
  advanced: 'Olá, {cliente}! Seu {item} passou para a etapa "{etapa}". Acompanhe: {link}',
  paused: 'Olá, {cliente}! O atendimento do seu {item} está pausado no momento. Avisaremos quando retomar. {link}'
};
const TEMPLATE_LABELS = { created: 'Ao criar o pedido', started: 'Ao iniciar o atendimento', advanced: 'Ao avançar de etapa', paused: 'Ao pausar' };
function messageFor(o, key) {
  const template = key === 'ready' ? (storeSettings.ready_message || 'Olá, {cliente}! Seu {item} está pronto para retirada na {loja}. Acompanhe: {link}') : ((storeSettings.message_templates || {})[key] || DEFAULT_TEMPLATES[key]);
  const values = { cliente: cap(firstName(o.customer)) || 'tudo bem', item: itemLabel(o), loja: storeSettings.name || 'loja', pedido: o.external_reference || o.order_number || '', link: o.share_code ? trackingUrl(o) : '', etapa: cap(currentStep(o)) };
  return template.replace(/\{(cliente|item|loja|pedido|link|etapa)\}/g, (_, k) => values[k]).replace(/\s+/g, ' ').trim();
}
const whatsFor = (o, key) => { const phone = whatsPhone(o); return 'https://wa.me/' + (phone || '') + '?text=' + encodeURIComponent(messageFor(o, key)); };
function startMessage(o) {
  const nome = cap(firstName(o.customer));
  return (nome ? 'Olá, ' + nome + '! ' : 'Olá! ') + 'Recebemos seu ' + itemLabel(o) + ' na ' + (storeSettings.name || 'loja') + ' (pedido ' + (o.external_reference || o.order_number || '') + '). Acompanhe por aqui, inclusive ao vivo: ' + trackingUrl(o);
}
const whatsUrl = o => whatsFor(o, o.status === 'queued' ? 'created' : o.status === 'paused' ? 'paused' : o.status === 'completed' ? 'ready' : 'started');
function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let max = 1280, quality = 0.8, data = '';
      for (let attempt = 0; attempt < 6; attempt++) {
        const scale = Math.min(1, max / Math.max(img.width, img.height)), canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        data = canvas.toDataURL('image/jpeg', quality).split(',')[1];
        if (data.length * 0.75 <= 290000) return resolve({ mime_type: 'image/jpeg', base64: data });
        quality -= 0.1; max = Math.round(max * 0.85);
      }
      reject(Error('Não foi possível reduzir a foto. Tente outra imagem.'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(Error('Arquivo não é uma imagem válida.')); };
    img.src = url;
  });
}
async function uploadPhotos(orderId, files, status) {
  const list = [...files].slice(0, 6); let sent = 0;
  for (const file of list) { if (status) status.textContent = 'Enviando foto ' + (sent + 1) + ' de ' + list.length + '…'; await api('/orders/' + orderId + '/photos', 'POST', await compressPhoto(file)); sent++; }
  return sent;
}
const photoUrl = (o, id) => '/api/public/orders/' + encodeURIComponent(o.share_code) + '/photos/' + id;
function photoStrip(o) {
  const photos = o.photos || [];
  return `<div class="fp-photos"><strong>Como chegou</strong><div class="fp-photo-row">${photos.map(id => `<span class="fp-photo"><a href="${photoUrl(o, id)}" target="_blank" rel="noopener"><img src="${photoUrl(o, id)}" alt="Foto do pedido" loading="lazy"></a><button type="button" class="fp-photo-del" data-photo-del="${safe(id)}" data-photo-order="${safe(o.id)}" aria-label="Apagar foto">×</button></span>`).join('')}${photos.length < 6 ? `<label class="fp-photo-add">+ Foto<input type="file" accept="image/*" multiple hidden data-photo-order="${safe(o.id)}"></label>` : ''}</div></div>`;
}
function transitionActions(o) {
  const button = (action, label, primary = false) => `<button type="button" class="nv-button ${primary ? '' : 'secondary'}" data-transition-id="${safe(o.id)}" data-action="${action}">${label}</button>`;
  let html = '';
  if (o.status === 'queued') html += button('start', 'Iniciar atendimento', true) + button('pause', 'Pausar');
  if (o.status === 'live') html += button(o.step_index < o.steps.length - 1 ? 'advance' : 'complete', o.step_index < o.steps.length - 1 ? 'Próxima etapa' : 'Concluir pedido', true) + button('pause', 'Pausar');
  if (o.status === 'paused') html += button('resume', o.started_at ? 'Retomar atendimento' : 'Retomar fila', true);
  html += undoButtons(o, button);
  return html;
}
const nicheNoun = () => ({ electronics: 'aparelho', automotive: 'veículo', carwash: 'veículo', pet: 'pet', food: 'pedido' }[storeSettings.niche] || 'pedido');
const itemLabel = o => FP.itemLabel(storeSettings.niche, o.details || {});
const orderRef = o => 'Pedido ' + (o.external_reference || o.order_number || o.id.slice(0, 8));
const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';
function whatsPhone(o) {
  let digits = String(o.customer_phone || '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) digits = '55' + digits;
  return /^55\d{10,11}$/.test(digits) ? digits : null;
}
function readyMessage(o) {
  const template = storeSettings.ready_message || 'Olá, {cliente}! Seu {item} está pronto para retirada na {loja}. Acompanhe: {link}';
  const values = { cliente: cap(firstName(o.customer)) || 'tudo bem', item: itemLabel(o), loja: storeSettings.name || 'loja', pedido: o.external_reference || o.order_number || '', link: o.share_code ? trackingUrl(o) : '' };
  return template.replace(/\{(cliente|item|loja|pedido|link)\}/g, (_, key) => values[key]).replace(/\s*Acompanhe:\s*$/, '').trim();
}
const minutesSince = iso => { const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000)); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'min'; };
const isLastStep = o => o.step_index >= (o.steps || []).length - 1;
const queuedOrders = () => cachedOrders.filter(o => o.status === 'queued').sort((a, b) => (a.queue_rank ?? Infinity) - (b.queue_rank ?? Infinity) || newest(b, a));
function finishButtons(o) {
  const phone = whatsPhone(o);
  return `<button type="button" class="nv-button fp-whats" data-finish-id="${safe(o.id)}" data-notify="1" ${phone ? '' : 'disabled title="Cliente sem telefone válido cadastrado"'}>Finalizar e avisar no WhatsApp</button><button type="button" class="nv-button secondary" data-finish-id="${safe(o.id)}" data-notify="0">Só finalizar</button>`;
}
function liveActions(o) {
  const b = (action, label, primary = false) => `<button type="button" class="nv-button ${primary ? '' : 'secondary'}" data-transition-id="${safe(o.id)}" data-action="${action}">${label}</button>`;
  let html = '';
  if (o.status === 'live') html += isLastStep(o) ? finishButtons(o) : b('advance', 'Avançar para ' + safe(cap(o.steps[o.step_index + 1])), true);
  if (o.status === 'live') html += b('pause', 'Pausar');
  if (o.status === 'paused') html += b('resume', o.started_at ? 'Retomar atendimento' : 'Retomar fila', true);
  html += undoButtons(o, b);
  return html + `<a class="nv-button secondary" target="_blank" rel="noopener" href="${safe(trackingUrl(o))}">Acompanhamento</a><a class="nv-button secondary fp-whats-soft" target="_blank" rel="noopener" href="${safe(whatsUrl(o))}">Enviar ao cliente</a><button type="button" class="nv-button secondary fp-more" data-expand-live="${safe(o.id)}" aria-expanded="${expandedLive.has(o.id)}">${expandedLive.has(o.id) ? 'Menos' : 'Detalhes'}</button>`;
}
function liveCard(o) {
  const steps = (o.steps || []).map((step, i) => `<span class="${i < o.step_index ? 'done' : i === o.step_index ? 'current' : ''}">${safe(cap(step))}</span>`).join('');
  const pill = o.status === 'paused' ? '<span class="nv-pill orange">Pausado</span>' : isLastStep(o) ? '<span class="nv-pill green">Pronto</span>' : '<span class="nv-pill">Em andamento</span>';
  return `<article class="fp-card" data-live-id="${safe(o.id)}"><div class="fp-card-head"><div><strong>${safe(orderRef(o))}</strong> ${pill}<p>${safe(cap(o.customer || 'Cliente não vinculado'))} · ${safe(itemLabel(o))}</p></div><span class="nv-help">${safe(cap(currentStep(o)))}</span></div><div class="fp-bar" aria-label="Etapas">${steps}</div><div class="fp-buttons">${liveActions(o)}</div>${expandedLive.has(o.id) ? liveDetails(o) : ''}</article>`;
}
const expandedLive = new Set();
function liveDetails(o) {
  const d = o.details || {}, info = (k, v) => v ? `<div><dt>${safe(k)}</dt><dd>${safe(v)}</dd></div>` : '';
  return `<div class="fp-live-details"><dl class="nv-detail-grid">${info('Cliente', o.customer)}${info('Contato', o.customer_phone || o.customer_email)}${FP.detailInfo(storeSettings.niche, d).map(([k, v]) => info(k, v)).join('')}${info('Serviço solicitado', d.service)}${info('Observações internas', d.notes)}${info('Recebido em', new Date(o.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))}</dl>${photoStrip(o)}<div class="fp-buttons"><button type="button" class="nv-button secondary" data-edit-order="${safe(o.id)}">Editar dados</button><button type="button" class="nv-button secondary" data-copy-order="${safe(o.id)}">Copiar link</button></div></div>`;
}
function setHtml(node, html) { if (node && node.dataset.signature !== html) { node.innerHTML = html; node.dataset.signature = html; } }
function renderNow() {
  const live = cachedOrders.filter(o => ['live', 'paused'].includes(o.status) && o.started_at).sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  const queue = queuedOrders();
  setHtml($('liveOrders'), live.length ? live.map(liveCard).join('') : '<p class="fp-empty">Nenhum pedido em atendimento. Inicie o próximo da fila.</p>');
  if ($('liveCount')) $('liveCount').textContent = live.length + (live.length === 1 ? ' pedido' : ' pedidos');
  if (!$('homeQueue')?.dataset.dragging) setHtml($('homeQueue'), queue.length ? queue.map((o, i) => `<div class="fp-queue-item" data-id="${safe(o.id)}"><button type="button" class="fp-drag fp-drag-sm" data-drag-handle aria-label="Arrastar para mudar a posição"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/></svg></button><span class="fp-pos">${i + 1}</span><div><strong>${safe(orderRef(o))} · ${safe(cap(firstName(o.customer) || 'Cliente'))}</strong><p>${safe(itemLabel(o))} · esperando há ${minutesSince(o.created_at)}</p></div><button type="button" class="nv-button" data-transition-id="${safe(o.id)}" data-action="start">Iniciar</button></div>`).join('') : '<p class="fp-empty">Ninguém esperando.</p>');
  enableQueueDrag($('homeQueue'), '.fp-queue-item');
  if ($('queueCount')) $('queueCount').textContent = queue.length + ' esperando';
  const actions = [];
  const ready = live.find(o => o.status === 'live' && isLastStep(o));
  if (ready) actions.push(`<div class="fp-action ready"><span class="fp-kind"><span class="fp-dot"></span>Pronto para avisar</span><strong>${safe(orderRef(ready))} · ${safe(itemLabel(ready))}</strong><p>Chegou em ${safe(cap(currentStep(ready)))}. Finalize e avise o cliente.</p><div class="fp-buttons">${finishButtons(ready)}</div></div>`);
  // Pausados já aparecem com "Retomar" no card Em atendimento; não repetir aqui.
  // O próximo da fila já aparece com "Iniciar" no card Fila ao lado; não repetir aqui.
  setHtml($('nowActions'), actions.join('')); const nowBox = document.querySelector('.fp-now'); if (nowBox) nowBox.hidden = !actions.length;
}
function orderCard(o) {
  const d = o.details || {};
  const item = FP.itemLabel(storeSettings.niche, d);
  const info = (label, value) => `<div><dt>${label}</dt><dd>${safe(value || 'Não informado')}</dd></div>`;
  return `<div class="fp-row"><div class="fp-row-main"><span class="nv-eyebrow">Pedido #${safe(o.external_reference || o.order_number || o.id.slice(0, 8))} · ${new Date(o.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span><h3>${safe(cap(o.customer || 'Cliente não vinculado'))}</h3><p>${safe(item)} · ${safe(o.process)}</p></div>
    <div class="fp-row-step"><div><span class="nv-pill ${o.status === 'completed' ? 'green' : o.status === 'paused' ? 'orange' : ''}">${labels[o.status]}</span> <strong>${safe(currentStep(o))}</strong></div>${stepsView(o)}</div>
    <div class="fp-row-actions">${transitionActions(o)}<button class="fp-icon-btn" data-delete-order="${safe(o.id)}" aria-label="Excluir pedido" title="Excluir pedido"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div></div>
    <details class="nv-order-details" data-details-id="${safe(o.id)}" ${openedOrders.has(o.id) ? 'open' : ''}><summary>Detalhes do pedido</summary>
      <dl class="nv-detail-grid">${info('Cliente', o.customer)}${info('Contato', o.customer_phone || o.customer_email)}${FP.detailInfo(storeSettings.niche, d).map(([k, v]) => info(k, v)).join('')}${info('Serviço solicitado', d.service)}${info('Observações internas', d.notes)}</dl>
      <div class="nv-order-actions"><button class="nv-button secondary" data-edit-order="${safe(o.id)}">Editar pedido</button><a class="nv-button secondary" target="_blank" rel="noopener" href="${safe(trackingUrl(o))}">Ver acompanhamento</a><button class="nv-button secondary" data-copy-order="${safe(o.id)}">Copiar link</button><a class="nv-button secondary" target="_blank" rel="noopener" href="${safe(whatsUrl(o))}">${whatsPhone(o) ? 'WhatsApp do cliente' : 'WhatsApp'}</a></div>${photoStrip(o)}
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
  return cachedOrders.filter(o => (!state.status || o.status === state.status) && (scope !== 'orders' || !orderDate || isoLocal(new Date(o.created_at)) === orderDate) && (!term || [o.external_reference, o.order_number, o.customer, o.process, ...Object.values(o.details || {})].some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(term)))).sort(state.sort === 'oldest' ? (a, b) => newest(b, a) : newest);
}
function renderLiveLists() {
  renderNow();
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
function detailFields(d = {}) { return FP.itemFields(storeSettings.niche, d) || '<p class="nv-help">Este tipo de loja não precisa de dados do item.</p>'; }
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
    <section class="nv-form-panel"><div class="nv-heading"><h3>1. Cliente</h3><button type="button" class="nv-button secondary" id="addInlineCustomer">+ Cadastrar cliente</button></div><div id="customerPicker"></div>
      <div id="inlineCustomer" class="nv-inline-panel" hidden><h4>Novo cliente</h4>${FP.customerFields({}, 'inline_').replace(/ required/g, '')}<button type="button" class="nv-button secondary" id="saveInlineCustomer">Salvar cliente e selecionar</button><button type="button" class="nv-button secondary" id="cancelInlineCustomer">Cancelar</button><p id="inlineCustomerStatus" role="status"></p></div>
    </section><section class="nv-form-panel"><h3>2. Dados do item</h3>${detailFields()}<label class="nv-field">Fotos de como chegou (opcional, até 6)<input type="file" name="photos" accept="image/*" multiple></label><p class="nv-help">No celular, toque para tirar a foto na hora. O cliente vê essas fotos no acompanhamento.</p></section>
    <section class="nv-form-panel"><h3>3. Serviço e acompanhamento</h3><div class="fp-proc-cards" role="radiogroup" aria-label="Processo">${processes.map(p => `<label class="fp-proc-card"><input type="radio" name="process_id" value="${safe(p.id)}" required><strong>${safe(p.name)}</strong><span>${(p.steps || []).length} etapas · ${safe((p.steps || []).slice(0, 3).join(' → '))}${(p.steps || []).length > 3 ? '…' : ''}</span></label>`).join('') || '<p class="nv-help">Cadastre um processo na aba Processos.</p>'}</div><div id="processPreview" class="nv-help"></div>${field('reference', 'Número próprio do pedido (opcional)')}${serviceFields()}</section>
    <button class="nv-button" type="submit">Criar pedido</button><p id="completeStatus" role="status"></p></form><div id="completeLink" hidden></div></section>
    <section class="nv-card"><div class="nv-heading"><h2>Pedidos da loja</h2><span class="nv-help" id="orderCount"></span></div>${toolbar('orders')}<div class="nv-datebar"><label>Dia <input id="orderDate" type="date" aria-label="Selecionar dia" value="${orderDate}"></label><button class="nv-button secondary" id="allDates">Todos os dias</button></div><div class="nv-list" id="datedOrders"></div></section>`;
  const form = $('completeForm');
  const picker = FP.customerPicker($('customerPicker'), cachedCustomers, () => {});
  FP.addressAssist($('inlineCustomer'), storeSettings);
  $('customerPicker').addEventListener('fp-new-customer', e => { $('inlineCustomer').hidden = false; form.elements.inline_name.value = e.detail || ''; form.elements.inline_phone.focus(); });
  $('addInlineCustomer').onclick = () => { $('inlineCustomer').hidden = false; form.elements.inline_name.focus(); };
  $('cancelInlineCustomer').onclick = () => { $('inlineCustomer').hidden = true; };
  $('saveInlineCustomer').onclick = async () => {
    const button = $('saveInlineCustomer'); button.disabled = true;
    try {
      const customer = await api('/customers', 'POST', FP.readCustomer(form, 'inline_'));
      picker.add(customer); picker.pick(customer); $('inlineCustomer').hidden = true; $('inlineCustomerStatus').textContent = '';
      $('inlineCustomer').querySelectorAll('input').forEach(input => { input.value = ''; });
      feedback('Cliente cadastrado e selecionado para este pedido.');
    } catch (error) { $('inlineCustomerStatus').textContent = error.message; }
    finally { button.disabled = false; }
  };
  form.addEventListener('change', e => { if (e.target.name !== 'process_id') return; const p = processes.find(p => p.id === e.target.value); $('processPreview').innerHTML = p ? stepsView({ steps: p.steps, status: 'queued', step_index: 0 }) : ''; });
  $('orderDate').onchange = e => { orderDate = e.target.value; renderLiveLists(); };
  $('allDates').onclick = () => { orderDate = ''; $('orderDate').value = ''; renderLiveLists(); };
  form.onsubmit = async e => {
    e.preventDefault(); const data = new FormData(form), button = form.querySelector('[type="submit"]');
    if (!data.get('customer_id')) { $('completeStatus').textContent = 'Selecione ou cadastre o cliente.'; form.querySelector('.fp-combo-input')?.focus(); return; }
    button.disabled = true; $('completeStatus').textContent = '';
    try {
      const result = await api('/orders', 'POST', { customer_id: data.get('customer_id'), process_id: data.get('process_id'), reference: String(data.get('reference')).trim(), details: readDetails(data) });
      const files = form.elements.photos?.files ? [...form.elements.photos.files] : [];
      let photoNote = '';
      if (files.length) { try { const n = await uploadPhotos(result.id, files, $('completeStatus')); photoNote = ' ' + n + ' foto(s) anexada(s).'; } catch (err) { photoNote = ' Fotos não enviadas: ' + err.message; } }
      form.reset(); picker.reset(); $('inlineCustomer').hidden = true; $('processPreview').textContent = '';
      const created = { ...result, external_reference: String(data.get('reference') || '').trim() || null, customer: cachedCustomers.find(c => c.id === data.get('customer_id'))?.name, customer_phone: cachedCustomers.find(c => c.id === data.get('customer_id'))?.phone, details: readDetails(data) };
      const link = created.share_code ? trackingUrl(created) : result.tracking_url;
      $('completeStatus').textContent = 'Pedido ' + (created.external_reference || created.order_number || '') + ' criado.' + photoNote; $('completeLink').hidden = false;
      $('completeLink').innerHTML = `<label class="nv-field">Link de acompanhamento<input readonly value="${safe(link)}"></label><div class="nv-order-actions"><a class="nv-button fp-whats" target="_blank" rel="noopener" href="${safe(whatsFor({ ...created, status: 'queued', steps: [] }, 'created'))}">${whatsPhone(created) ? 'Enviar no WhatsApp do cliente' : 'Enviar no WhatsApp'}</a><a class="nv-button secondary" target="_blank" rel="noopener" href="${safe(link)}">Abrir acompanhamento</a></div>`;
      orderDate = isoLocal(new Date()); $('orderDate').value = orderDate; filters.orders.search = ''; filters.orders.status = ''; document.querySelectorAll('[data-filter-scope="orders"]').forEach(node => { if (node.dataset.filter !== 'sort') node.value = ''; });
      await reload(true); feedback('Pedido criado com sucesso.');
    } catch (error) { $('completeStatus').textContent = error.message; }
    finally { button.disabled = false; }
  };
  renderLiveLists();
}
function enableQueueDrag(container, itemSelector) {
  if (!container || container.dataset.sortable) return;
  container.dataset.sortable = '1';
  container.addEventListener('pointerdown', e => { if (e.target.closest('[data-drag-handle]')) container.dataset.dragging = '1'; }, true);
  FP.sortable(container, itemSelector, async ids => {
    delete container.dataset.dragging;
    try { await api('/orders/queue-order', 'PUT', { ids }); await reload(true); feedback('Ordem da fila atualizada.'); } catch (error) { feedback(error.message, true); await reload(true); }
  });
}
function drawQueue() {
  const container = $('queueList'); if (!container || container.dataset.dragging) return;
  const orders = cachedOrders.filter(o => o.status === 'queued').sort((a, b) => (a.queue_rank ?? Infinity) - (b.queue_rank ?? Infinity) || newest(b, a));
  const html = orders.map((o, i) => `<article class="nv-order fp-queue-row" data-id="${safe(o.id)}"><button type="button" class="fp-drag" data-drag-handle aria-label="Arrastar para mudar a posição"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/></svg></button><span class="fp-pos">${i + 1}</span><div class="fp-queue-info"><strong>${safe(orderRef(o))} · ${safe(cap(firstName(o.customer) || 'Cliente'))}</strong><p>${safe(itemLabel(o))} · ${safe(o.process)} · esperando há ${minutesSince(o.created_at)}</p></div></article>`).join('') || notice('Nenhum pedido aguardando.');
  if (container.innerHTML !== html) container.innerHTML = html;
  enableQueueDrag(container, '.fp-queue-row');
}
function customerFields(c = {}) { return FP.customerFields(c); }
function drawCustomers() {
  const container = $('customerList'); if (!container) return;
  const search = ($('customerSearch')?.value || '').trim().toLocaleLowerCase('pt-BR');
  const customers = cachedCustomers.filter(c => [c.name, c.phone, c.email, c.address].some(v => String(v || '').toLocaleLowerCase('pt-BR').includes(search)));
  $('customerCount').textContent = `${customers.length} de ${cachedCustomers.length} clientes`;
  container.innerHTML = customers.map(c => `<article class="nv-customer-row"><div class="nv-customer-avatar" aria-hidden="true">${safe((c.name || '?').slice(0, 1).toLocaleUpperCase('pt-BR'))}</div><div class="nv-customer-info"><h3>${safe(cap(c.name))}</h3><p>${safe(c.phone || 'Telefone não informado')}${c.email ? ' · ' + safe(c.email) : ''}</p>${c.address ? `<p>${safe(c.address)}</p>` : ''}</div><div class="nv-customer-actions">${c.phone ? `<a class="nv-phone-link" href="https://wa.me/${String(c.phone).replace(/\D/g, '').startsWith('55') ? '' : '55'}${String(c.phone).replace(/\D/g, '')}" target="_blank" rel="noopener">WhatsApp</a>` : ''}<button class="nv-button secondary" data-edit-customer="${safe(c.id)}">Editar</button><button class="fp-icon-btn" data-delete-customer="${safe(c.id)}" aria-label="Excluir cliente" title="Excluir cliente"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div></article>`).join('') || notice('Nenhum cliente encontrado.');
}
function editCustomer(id) {
  const c = cachedCustomers.find(c => c.id === id); if (!c) return;
  openDialog(`${dialogHeader('Editar cliente')}<form id="editCustomerForm">${customerFields(c)}<div class="nv-row"><button class="nv-button">Salvar alterações</button><button type="button" class="nv-button secondary" data-close-dialog>Cancelar</button></div><p role="status"></p></form>`);
  FP.addressAssist($('editCustomerForm'), storeSettings);
  $('editCustomerForm').onsubmit = async e => {
    e.preventDefault(); const form = e.currentTarget;
    try { await api('/customers/' + id, 'PATCH', FP.readCustomer(form)); cachedCustomers = await api('/customers'); drawCustomers(); $('editorDialog').close(); await reload(true); feedback('Cliente atualizado.'); }
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
    FP.addressAssist($('customerForm'), storeSettings); $('customerForm').onsubmit = async e => { e.preventDefault(); const form = e.currentTarget; try { await api('/customers', 'POST', FP.readCustomer(form)); cachedCustomers = await api('/customers'); drawCustomers(); $('editorDialog').close(); feedback('Cliente cadastrado.'); } catch (error) { form.querySelector('[role="status"]').textContent = error.message; } };
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
  const fb = $('panelFeedback'); if (fb && !fb.classList.contains('error')) { fb.hidden = true; fb.textContent = ''; }
  const box = $('sectionContent'), version = ++viewVersion;
  box.innerHTML = '<section class="nv-card">Carregando…</section>';
  try {
    if (view === 'orders') return await loadOrders(box, version);
    if (view === 'customers') return await loadCustomers(box, version);
    if ((view === 'cash' || view === 'messages') && window.FPSales) return await window.FPSales.load(view, box, () => version === viewVersion);
    if (view === 'more') { box.innerHTML = '<section class="nv-card"><h2>Mais opções</h2><div class="nv-list">'+[...(window.FPSales?.moreItems()||[]),['customers','Clientes'],['processes','Processos'],['plan','Meu plano'],['settings','Configurações'],['support','Suporte']].map(([key,label])=>'<button class="nv-button secondary" data-view="'+key+'">'+label+'</button>').join('')+'</div></section>';return;}
    if (view === 'queues') { box.innerHTML = '<section class="nv-card"><h2>Fila de atendimento</h2><p class="nv-help">Atendimento por ordem de chegada. Arraste pelo ⋮⋮ para mudar a ordem.</p><div id="queueList" class="nv-list"></div></section>'; drawQueue(); return; }
    await loadEditor(view, box, version);
  } catch (error) { if (version === viewVersion) box.innerHTML = `<section class="nv-card" role="alert">${safe(error.message)}</section>`; }
}
async function switchView(view) {
  activeView = view;
  document.querySelectorAll('[data-view]').forEach(node => node.classList.toggle('active', node.dataset.view === view));
  $('dashboardContent').hidden = view !== 'home'; $('sectionContent').hidden = view === 'home';
  const names = { home: 'Visão geral', orders: 'Pedidos', customers: 'Clientes', queues: 'Fila de atendimento', processes: 'Processos', cameras: 'Câmeras', settings: 'Configurações', support: 'Suporte', plan:'Meu plano', more:'Mais opções', ...(window.FPSales?.titles||{}) };
  document.querySelector('.nv-top h1').textContent = names[view] || '';
  if (view !== 'home') await loadSection(view); else { viewVersion++; renderLiveLists(); }
}
document.addEventListener('toggle', e => {
  const id = e.target.dataset?.detailsId; if (!id || !e.target.isConnected) return;
  if (e.target.open) openedOrders.add(id); else openedOrders.delete(id);
}, true);
document.addEventListener('change', async e => {
  const input = e.target; if (input.type !== 'file' || !input.dataset.photoOrder || !input.files.length) return;
  try { const n = await uploadPhotos(input.dataset.photoOrder, input.files, $('panelFeedback')); $('panelFeedback').hidden = false; await reload(true); feedback(n + ' foto(s) anexada(s).'); }
  catch (error) { feedback(error.message, true); } finally { input.value = ''; }
});
document.addEventListener('input', e => {
  if (!e.target.dataset.filter) return;
  filters[e.target.dataset.filterScope][e.target.dataset.filter] = e.target.value; renderLiveLists();
});
document.addEventListener('click', async e => {
  const button = e.target.closest('button'); if (!button) return;
  try {
    if (button.dataset.view) { await switchView(button.dataset.view); return; }
    if (button.hasAttribute('data-close-dialog')) { $('editorDialog').close(); return; }
    if (button.dataset.expandLive) { const id = button.dataset.expandLive; expandedLive.has(id) ? expandedLive.delete(id) : expandedLive.add(id); renderNow(); return; }
    if (button.dataset.editOrder) { await editOrder(button.dataset.editOrder); return; }
    if (button.dataset.editCustomer) { editCustomer(button.dataset.editCustomer); return; }
    if (button.dataset.deleteCustomer) {
      const c = cachedCustomers.find(x => x.id === button.dataset.deleteCustomer); if (!c) return;
      if (!confirm(`Excluir o cliente "${c.name}"? Ele sai da lista, das buscas e das mensagens. Pedidos e vendas já feitos continuam no histórico.`)) return;
      button.disabled = true; await api('/customers/' + c.id, 'DELETE');
      cachedCustomers = await api('/customers'); drawCustomers(); await reload(true); feedback('Cliente excluído.'); return;
    }
    if (button.dataset.transitionId) {
      const o = cachedOrders.find(o => o.id === button.dataset.transitionId); if (!o) return;
      button.disabled = true;
      try { const action = button.dataset.action; await api('/orders/' + o.id + '/transition', 'POST', { action, expected_step_index: o.step_index, expected_status: o.status }); await reload(true); feedback('Pedido atualizado.'); if (undoOf[action]) showUndo(o.id, undoOf[action]); const fresh = cachedOrders.find(x => x.id === o.id) || o; const key = { start: 'started', advance: 'advanced', pause: 'paused', resume: 'started' }[action]; if (key) showWhatsOffer(fresh, key); }
      catch (error) { await reload(true); throw error; }
      finally { if (button.isConnected) button.disabled = false; }
    }
    if (button.dataset.finishId) {
      const o = cachedOrders.find(o => o.id === button.dataset.finishId); if (!o) return;
      const notify = button.dataset.notify === '1', phone = notify ? whatsPhone(o) : null;
      if (notify && !phone) throw Error('Este cliente não tem telefone válido cadastrado. Use "Só finalizar" ou edite o cliente.');
      const win = notify ? window.open('about:blank', '_blank') : null;
      button.disabled = true;
      try {
        await api('/orders/' + o.id + '/transition', 'POST', { action: 'complete', expected_step_index: o.step_index, expected_status: o.status });
        if (win) { win.opener = null; win.location.href = 'https://wa.me/' + phone + '?text=' + encodeURIComponent(readyMessage(o)); }
        await reload(true); feedback(notify ? 'Pedido finalizado. Envie a mensagem que abriu no WhatsApp.' : 'Pedido finalizado.');
      } catch (error) { win?.close(); await reload(true); throw error; }
      finally { if (button.isConnected) button.disabled = false; }
      return;
    }
    if (button.dataset.copyOrder) { const o = cachedOrders.find(o => o.id === button.dataset.copyOrder); await navigator.clipboard.writeText(trackingUrl(o)); feedback('Link copiado.'); }
    if (button.dataset.sendOrder) { const o = cachedOrders.find(o => o.id === button.dataset.sendOrder); window.open(whatsUrl(o), '_blank', 'noopener,noreferrer'); }
    if (button.dataset.photoDel && confirm('Apagar esta foto?')) { await api('/orders/' + button.dataset.photoOrder + '/photos/' + button.dataset.photoDel, 'DELETE'); await reload(true); feedback('Foto apagada.'); }
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
  if (!token) { location.replace('/#entrar'); return; }
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

function settingsTabs(box, settings) {
  const cards = [...box.querySelectorAll(':scope > section, :scope > details')];
  const [identity, ready, loyalty, redeem] = cards;
  const tpl = settings.message_templates || {};
  const loc = document.createElement('section'); loc.className = 'nv-card';
  loc.innerHTML = '<h2>Endereço e contato da loja</h2><p class="nv-help">A cidade serve para sugerir endereços ao cadastrar clientes. O WhatsApp aparece para o cliente no acompanhamento.</p><form id="locationForm" class="nv-form-grid"><label class="nv-field">Cidade<input name="city" maxlength="80" value="' + safe(settings.city || '') + '" placeholder="Ex.: Fortaleza"></label><label class="nv-field">UF<input name="state" maxlength="2" value="' + safe(settings.state || '') + '" placeholder="CE" style="text-transform:uppercase"></label><label class="nv-field">WhatsApp da loja (para o cliente falar com vocês)<input name="whatsapp" inputmode="tel" maxlength="20" value="' + safe(settings.whatsapp || '') + '" placeholder="DDD + número"></label><div><button class="nv-button">Salvar</button><p id="locationStatus" role="status"></p></div></form>';
  const msgs = document.createElement('section'); msgs.className = 'nv-card';
  msgs.innerHTML = '<h2>Mensagens por ação</h2><p class="nv-help">Textos usados nos botões de WhatsApp. Variáveis: {cliente}, {item}, {loja}, {pedido}, {etapa} e {link}.</p><form id="templatesForm">' + Object.entries(TEMPLATE_LABELS).map(([k, label]) => '<label class="nv-field">' + label + '<textarea name="' + k + '" rows="2" maxlength="1000">' + safe(tpl[k] || DEFAULT_TEMPLATES[k]) + '</textarea></label>').join('') + '<button class="nv-button">Salvar mensagens</button><p id="templatesStatus" role="status"></p></form>';
  const tabs = [['Perfil', [identity, loc]], ['Mensagens', [msgs, ready]], ['Fidelidade', [loyalty, redeem]]];
  const bar = document.createElement('div'); bar.className = 'fp-tabs'; bar.setAttribute('role', 'tablist');
  box.prepend(bar); if (identity) identity.after(loc); else box.append(loc); if (ready) ready.before(msgs); else box.append(msgs);
  const select = name => { bar.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name))); tabs.forEach(([n, els]) => els.forEach(el => { if (el) el.hidden = n !== name; })); };
  tabs.forEach(([name]) => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.tab = name; b.textContent = name; b.onclick = () => select(name); bar.append(b); });
  if (ready) { const h = ready.querySelector('h2'); if (h) h.textContent = 'Ao concluir (pedido pronto)'; }
  select('Perfil');
  $('locationForm').onsubmit = async e => { e.preventDefault(); const f = e.currentTarget; try { const r = await api('/store/location', 'PATCH', { city: f.elements.city.value.trim(), state: f.elements.state.value.trim().toUpperCase(), whatsapp: f.elements.whatsapp.value.trim() }); storeSettings.city = r.city; storeSettings.state = r.state; storeSettings.whatsapp = r.whatsapp; f.elements.whatsapp.value = r.whatsapp || ''; $('locationStatus').textContent = 'Salvo'; } catch (err) { $('locationStatus').textContent = err.message; } };
  $('templatesForm').onsubmit = async e => { e.preventDefault(); const f = e.currentTarget; const body = Object.fromEntries(Object.keys(TEMPLATE_LABELS).map(k => [k, f.elements[k].value.trim()])); try { const r = await api('/store/message-templates', 'PATCH', body); storeSettings.message_templates = r.message_templates; $('templatesStatus').textContent = 'Mensagens salvas'; } catch (err) { $('templatesStatus').textContent = err.message; } };
}
const TICKET_CATS = { video: 'Vídeo ao vivo não aparece', camera: 'Câmera / imagem', pedidos: 'Pedidos ou painel', acesso: 'Acesso / login', cobranca: 'Plano ou cobrança', outro: 'Outro assunto' };
const TICKET_STATUS = { open: ['orange', 'Aberto'], in_progress: ['', 'Em andamento'], resolved: ['green', 'Resolvido'] };
async function loadSupport(box, version) {
  const data = await api('/store/support'); if (version !== viewVersion) return;
  const wa = data.whatsapp ? 'https://wa.me/' + data.whatsapp + '?text=' + encodeURIComponent('Olá! Sou da loja ' + (storeSettings.name || '') + ' (' + (storeSettings.slug || '') + ') e preciso de ajuda com o Ficou Pronto.') : '';
  box.innerHTML = `<div class="fp-support-grid"><section class="nv-card"><h2>Falar agora</h2><p class="nv-help">Atendimento direto com a equipe Ficou Pronto pelo WhatsApp.</p>${wa ? `<a class="nv-button fp-whats" target="_blank" rel="noopener" href="${safe(wa)}">Chamar o suporte no WhatsApp</a>` : '<p class="nv-help">O WhatsApp do suporte ainda não foi configurado pela central. Abra um chamado ao lado.</p>'}</section>
  <section class="nv-card"><h2>Abrir chamado</h2><p class="nv-help">Descreva o que aconteceu. A central acompanha e responde por aqui.</p><form id="ticketForm"><div class="nv-form-grid"><label class="nv-field">Assunto<select name="category" required>${Object.entries(TICKET_CATS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label><label class="nv-field">Telefone para retorno (opcional)<input name="contact_phone" inputmode="tel" maxlength="30"></label></div><label class="nv-field">Título<input name="subject" required minlength="3" maxlength="140" placeholder="Ex.: vídeo não aparece para o cliente"></label><label class="nv-field">O que aconteceu?<textarea name="description" required minlength="5" maxlength="4000" rows="4" placeholder="Quando começou, em qual pedido, o que aparece na tela…"></textarea></label><button class="nv-button">Enviar chamado</button><p id="ticketStatus" role="status"></p></form></section></div>
  <section class="nv-card"><h2>Meus chamados</h2><div class="nv-list">${data.tickets.length ? data.tickets.map(t => `<article class="nv-order fp-ticket"><div><strong>#${t.number} · ${safe(t.subject)}</strong><p>${safe(TICKET_CATS[t.category] || t.category)} · aberto em ${new Date(t.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</p>${t.central_note ? `<p class="fp-ticket-reply"><strong>Resposta da central:</strong> ${safe(t.central_note)}</p>` : ''}</div><span class="nv-pill ${TICKET_STATUS[t.status][0]}">${TICKET_STATUS[t.status][1]}</span></article>`).join('') : notice('Nenhum chamado aberto.')}</div></section>`;
  $('ticketForm').onsubmit = async e => {
    e.preventDefault(); const f = e.currentTarget, b = f.querySelector('button'); b.disabled = true;
    try { const r = await api('/store/support', 'POST', { category: f.elements.category.value, subject: f.elements.subject.value.trim(), description: f.elements.description.value.trim(), contact_phone: f.elements.contact_phone.value.trim() }); await loadSupport(box, viewVersion); feedback('Chamado #' + r.number + ' aberto. A central foi avisada.'); }
    catch (err) { $('ticketStatus').textContent = err.message; b.disabled = false; }
  };
}
async function loadEditor(view, box, version) {
 if(view==='cameras'){
 const cameras=await api('/cameras');if(version!==viewVersion)return;
 box.innerHTML='<section class="nv-card"><h2>Câmeras autorizadas</h2><p class="nv-help">Cadastro, instalação, troca e remoção são realizados pela central ou por técnicos autorizados. Seu painel utiliza apenas as câmeras liberadas para esta loja.</p><div class="nv-list">'+cameras.map(c=>'<article class="nv-order"><div><strong>'+safe(c.name)+'</strong><p>'+safe(c.station||'Sem setor informado')+'</p></div><span class="nv-pill '+(c.enabled?'':'orange')+'">'+safe(c.enabled?(c.status==='ready'?'Configurada':c.status==='offline'?'Sem conexão':'Em configuração'):'Bloqueada pela central')+'</span></article>').join('')+'</div></section>';
 }else if(view==='processes'){

 const [processes,cameras]=await Promise.all([api('/processes'),api('/cameras')]);
 if(version!==viewVersion)return;
 const camName=id=>id===null?'Sem câmera':(cameras.find(c=>c.id===id)?.name||'Câmera removida');
 const camOptions=(selected,step)=>(step?'<option value="">Câmera padrão</option><option value="none" '+(selected==='none'?'selected':'')+'>Sem câmera</option>':'<option value="">Sem câmera</option>')+cameras.map(c=>'<option value="'+safe(c.id)+'" '+(c.id===selected?'selected':'')+'>'+safe(c.name)+'</option>').join('');
 const state={selected:processes[0]?.id||'new'};
 const draft=id=>{const p=processes.find(x=>x.id===id);return p?{id:p.id,name:p.name,camera_id:p.camera_id||'',steps:p.steps.map((name,i)=>({name,camera:Object.hasOwn(p.step_cameras||{},String(i))?(p.step_cameras[i]===null?'none':p.step_cameras[i]):''}))}:{id:'new',name:'',camera_id:'',steps:[{name:'',camera:''}]}};
 let current=draft(state.selected);
 const listHtml=()=>processes.map(p=>'<button type="button" class="fp-proc-item '+(p.id===state.selected?'active':'')+'" data-proc="'+safe(p.id)+'"><strong>'+safe(cap(p.name))+'</strong><span>'+p.steps.length+' etapa'+(p.steps.length===1?'':'s')+' · '+safe(p.camera_id?camName(p.camera_id):'sem câmera padrão')+'</span></button>').join('')+'<button type="button" class="fp-proc-item fp-proc-new '+(state.selected==='new'?'active':'')+'" data-proc="new"><strong>+ Novo processo</strong><span>Criar do zero</span></button>';
 let selStep=0;
 const camLabel=v=>v==='none'?'Sem câmera':v?camName(v):'Câmera padrão'+(current.camera_id?' ('+camName(current.camera_id)+')':'');
 const editorHtml=()=>{if(selStep>=current.steps.length)selStep=current.steps.length-1;const st=current.steps[selStep]||{camera:''};
  return '<form id="procEditor" class="fp-proc-cols">'
  +'<div class="fp-col fp-col-steps"><div class="fp-col-head">Etapas</div><label class="nv-field">Nome do processo<input name="name" required maxlength="120" value="'+safe(current.name)+'" placeholder="Ex.: Troca de tela"></label>'
  +'<ol class="fp-steps3">'+current.steps.map((x,i)=>'<li class="'+(i===selStep?'active':'')+'" data-step-pick="'+i+'"><span class="fp-step-n">'+(i+1)+'</span><input aria-label="Nome da etapa '+(i+1)+'" data-step-name="'+i+'" required maxlength="120" value="'+safe(x.name)+'" placeholder="Nome da etapa"><span class="fp-step-cam">'+safe(camLabel(x.camera))+'</span><span class="fp-step-tools"><button type="button" class="fp-icon" data-step-move="'+i+'" data-dir="-1" aria-label="Subir etapa" '+(i===0?'disabled':'')+'>↑</button><button type="button" class="fp-icon" data-step-move="'+i+'" data-dir="1" aria-label="Descer etapa" '+(i===current.steps.length-1?'disabled':'')+'>↓</button><button type="button" class="fp-icon" data-step-del="'+i+'" aria-label="Remover etapa" '+(current.steps.length===1?'disabled':'')+'>✕</button></span></li>').join('')+'</ol>'
  +'<button type="button" class="nv-button secondary" id="addStep" '+(current.steps.length>=30?'disabled':'')+'>+ Adicionar etapa</button></div>'
  +'<div class="fp-col fp-col-cams"><div class="fp-col-head">Câmera da etapa '+(selStep+1)+(st.name?' · '+safe(cap(st.name)):'')+'</div>'
  +'<div class="fp-cam-list" role="radiogroup" aria-label="Câmera da etapa">'
  +[['', 'Usar a câmera padrão do processo'],['none','Sem câmera nesta etapa']].concat(cameras.map(c=>[c.id,c.name+(c.station?' · '+c.station:'')])).map(([v,l])=>'<label class="fp-cam-opt"><input type="radio" name="stepCam" value="'+safe(v)+'" '+((st.camera||'')===v?'checked':'')+'><span>'+safe(l)+'</span></label>').join('')+'</div>'
  +'<label class="nv-field fp-default-cam">Câmera padrão do processo<select name="camera_id">'+camOptions(current.camera_id,false)+'</select></label>'
  +'<div class="fp-proc-actions">'+(current.id!=='new'?'<button type="button" class="nv-button secondary nv-danger" id="deleteProc">Excluir processo</button>':'')+'<span class="nv-help">Alterações valem para novos pedidos.</span><button class="nv-button" type="submit">'+(current.id==='new'?'Criar processo':'Salvar alterações')+'</button></div><p id="procStatus" role="status" class="nv-help"></p></div></form>';};
 const draw=()=>{box.innerHTML='<section class="nv-card fp-proc3"><div class="fp-col fp-col-procs"><div class="fp-col-head">Processos</div><div class="fp-proc-list" aria-label="Processos">'+listHtml()+'</div></div>'+editorHtml()+'</section>';bind()};
 const sync=()=>{const f=$('procEditor');current.name=f.elements.name.value;current.camera_id=f.elements.camera_id.value;f.querySelectorAll('[data-step-name]').forEach(x=>current.steps[+x.dataset.stepName].name=x.value);const r=f.querySelector('[name="stepCam"]:checked');if(r&&current.steps[selStep])current.steps[selStep].camera=r.value};
 const bind=()=>{
  box.querySelectorAll('[data-proc]').forEach(b=>b.onclick=()=>{state.selected=b.dataset.proc;current=draft(state.selected);selStep=0;draw()});
  box.querySelectorAll('[data-step-pick]').forEach(li=>li.addEventListener('click',e=>{if(e.target.closest('button'))return;const i=+li.dataset.stepPick;if(i===selStep)return;sync();selStep=i;draw();box.querySelector('[data-step-name="'+i+'"]')?.focus()}));
  box.querySelectorAll('[name="stepCam"]').forEach(r=>r.onchange=()=>{sync();draw()});
  $('procEditor').elements.camera_id.onchange=()=>{sync();draw()};
  $('addStep').onclick=()=>{sync();current.steps.push({name:'',camera:''});selStep=current.steps.length-1;draw();box.querySelector('[data-step-name="'+(current.steps.length-1)+'"]')?.focus()};
  box.querySelectorAll('[data-step-move]').forEach(b=>b.onclick=()=>{sync();const i=+b.dataset.stepMove,j=i+Number(b.dataset.dir);[current.steps[i],current.steps[j]]=[current.steps[j],current.steps[i]];if(selStep===i)selStep=j;draw()});
  box.querySelectorAll('[data-step-del]').forEach(b=>b.onclick=()=>{sync();current.steps.splice(+b.dataset.stepDel,1);selStep=Math.max(0,Math.min(selStep,current.steps.length-1));draw()});
  if($('deleteProc'))$('deleteProc').onclick=async()=>{if(!confirm('Excluir o processo "'+current.name+'"? Ele deixa de aparecer para novos pedidos. Pedidos já criados com ele continuam com o histórico.'))return;try{await api('/processes/'+current.id,'DELETE');const fresh=await api('/processes');processes.splice(0,processes.length,...fresh);state.selected=processes[0]?.id||'new';current=draft(state.selected);selStep=0;draw();$('procStatus').textContent='Processo excluído.';await reload()}catch(err){$('procStatus').textContent=err.message}};
  $('procEditor').onsubmit=async e=>{e.preventDefault();sync();const steps=current.steps.map(s=>({...s,name:cap(s.name)})).filter(s=>s.name);
   const body={name:cap(current.name),steps:steps.map(s=>s.name),camera_id:current.camera_id||null,step_cameras:Object.fromEntries(steps.map((s,i)=>[String(i),s.camera]).filter(([,v])=>v).map(([k,v])=>[k,v==='none'?null:v]))};
   const status=$('procStatus');try{const saved=await api(current.id==='new'?'/processes':'/processes/'+current.id,current.id==='new'?'POST':'PATCH',body);const fresh=await api('/processes');processes.splice(0,processes.length,...fresh);state.selected=saved.id;current=draft(saved.id);draw();$('procStatus').textContent='Processo salvo.';await reload()}catch(err){status.textContent=err.message}};
 };
 draw();

 }else if(view==='settings'){

 const [settings,loyalty]=await Promise.all([api('/store/settings'),api('/store/loyalty')]);
 if(version!==viewVersion)return;
 box.innerHTML='<section class="nv-card"><h2>Identidade da loja</h2><p class="nv-help">Nicho: '+safe(settings.niche_label||'Serviços em geral')+' · Definido pelo administrador.</p><form id="settingsForm">'+field('name','Nome da loja',settings.name)+'<label class="nv-field">Logo da loja (PNG, JPG ou WebP, até 256 KB)<input id="logoFile" type="file" accept="image/png,image/jpeg,image/webp"></label><div id="logoDrop" class="nv-drop" tabindex="0">Arraste a imagem aqui ou selecione acima</div><img id="logoPreview" hidden alt="Prévia da imagem" style="width:90px;height:90px;object-fit:contain"><button class="nv-button" type="button" id="uploadLogo">Enviar logo</button><button class="nv-button secondary" type="submit">Salvar nome da loja</button><p id="settingsStatus" role="status"></p></form></section><section class="nv-card"><h2>Mensagem de pedido pronto</h2><p class="nv-help">Enviada pelo WhatsApp quando você usa "Finalizar e avisar". Use {cliente}, {item}, {loja}, {pedido} e {link}.</p><form id="messageForm"><label class="nv-field">Mensagem<textarea name="ready_message" rows="3" maxlength="1000" required>'+safe(settings.ready_message||'')+'</textarea></label><button class="nv-button">Salvar mensagem</button><p id="messageStatus" role="status"></p></form></section><section class="nv-card"><h2>Programa de fidelidade</h2><form id="loyaltyForm"><label><input type="checkbox" name="enabled" '+(loyalty.loyalty_enabled?'checked':'')+'> Ativar fidelidade</label>'+field('target','Check-ins necessários',loyalty.loyalty_target,'number')+'<label class="nv-field">Recompensa<textarea name="reward">'+safe(loyalty.loyalty_reward||'')+'</textarea></label><button class="nv-button">Salvar fidelidade</button><p id="loyaltyStatus" role="status"></p></form></section><section class="nv-card"><h2>Validar cupom</h2><form id="redeemForm">'+field('code','Código')+'<button class="nv-button">Validar cupom</button><p id="redeemFeedback" role="status"></p></form></section>';
 $('messageForm').onsubmit=async e=>{e.preventDefault();try{const r=await api('/store/messages','PATCH',{ready_message:e.currentTarget.elements.ready_message.value.trim()});storeSettings.ready_message=r.ready_message;$('messageStatus').textContent='Mensagem salva'}catch(err){$('messageStatus').textContent=err.message}};
 $('settingsForm').onsubmit=async e=>{e.preventDefault();const name=e.currentTarget.elements.name.value.trim();try{const saved=await api('/store/settings','PATCH',{name,logo_url:settings.logo_url||'',email_notifications:settings.email_notifications||'off'});storeSettings.name=saved.name;storeSettings.slug=saved.slug;settings.slug=saved.slug;$('storeBrandName').textContent=name;document.querySelector('.nv-profile span').textContent=name;$('settingsStatus').textContent='Nome atualizado. Links dos pedidos: '+(storeSettings.short_link_base||location.origin).replace(/^https?:\/\//,'')+'/'+saved.slug+'/…'}catch(err){$('settingsStatus').textContent=err.message}};
 const fileInput=$('logoFile'),drop=$('logoDrop');let selected=null;const preview=file=>{if(!file)return;selected=file;drop.textContent=file.name;const im=$('logoPreview');im.hidden=false;im.src=URL.createObjectURL(file)};
 fileInput.onchange=()=>preview(fileInput.files[0]);drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag')};drop.ondragleave=()=>drop.classList.remove('drag');drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');preview(e.dataTransfer.files[0])};drop.onclick=()=>fileInput.click();
 $('uploadLogo').onclick=async()=>{if(!selected){$('settingsStatus').textContent='Selecione uma imagem';return}if(selected.size>262144){$('settingsStatus').textContent='Imagem maior que 256 KB. Reduza o tamanho.';return}try{const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(selected)});const r=await api('/store/logo','PUT',{mime_type:selected.type,base64});settings.logo_url=r.logo_url;$('storeBrandIcon').innerHTML='<img src="'+safe(r.logo_url)+'?v='+Date.now()+'" alt="Logo" style="width:100%;height:100%;object-fit:contain">';$('settingsStatus').textContent='Logo atualizado'}catch(err){$('settingsStatus').textContent=err.message}};
 $('loyaltyForm').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget;try{await api('/store/loyalty','PATCH',{loyalty_enabled:f.elements.enabled.checked,loyalty_target:Number(f.elements.target.value),loyalty_reward:f.elements.reward.value.trim()});$('loyaltyStatus').textContent='Fidelidade atualizada'}catch(err){$('loyaltyStatus').textContent=err.message}};
 settingsTabs(box,settings);
 $('redeemForm').onsubmit=async e=>{e.preventDefault();try{const r=await api('/store/loyalty/redeem','POST',{code:e.currentTarget.elements.code.value.trim().toUpperCase()});$('redeemFeedback').textContent='Cupom validado: '+r.reward}catch(err){$('redeemFeedback').textContent=err.message}};
 
 }else if(view==='plan'){
 const settings=await api('/store/settings');if(version!==viewVersion)return;
 box.innerHTML='<section class="nv-card"><h2>Meu plano</h2><p class="nv-help">A quantidade de câmeras é liberada pela central. Solicitar uma alteração não modifica o plano automaticamente.</p><div class="nv-form-grid"><div class="nv-form-panel"><h3>Câmeras contratadas</h3><strong class="nv-number">'+settings.camera_limit+'</strong></div><div class="nv-form-panel"><h3>Câmeras cadastradas</h3><strong class="nv-number">'+settings.camera_count+'</strong></div></div><label class="nv-field">Quantidade de câmeras desejada<input id="requestedCameras" type="number" min="1" max="128" value="'+Math.min(128,settings.camera_limit+1)+'"></label><a id="salesContact" class="nv-button" target="_blank" rel="noopener">Conversar sobre meu plano no WhatsApp</a><p id="salesContactStatus" class="nv-help"></p></section>';
 const updateLink=()=>{const quantity=Number($('requestedCameras').value),link=$('salesContact');if(!settings.sales_whatsapp){link.removeAttribute('href');link.setAttribute('aria-disabled','true');$('salesContactStatus').textContent='O contato comercial ainda não foi configurado pela central.';return;}if(!Number.isInteger(quantity)||quantity<1||quantity>128){link.removeAttribute('href');$('salesContactStatus').textContent='Informe uma quantidade entre 1 e 128 câmeras.';return;}link.removeAttribute('aria-disabled');link.href='https://wa.me/'+settings.sales_whatsapp+'?text='+encodeURIComponent('Olá! Sou da loja '+settings.name+' ('+settings.slug+'). Meu plano permite '+settings.camera_limit+' câmera(s) e gostaria de contratar um plano para '+quantity+' câmera(s).');$('salesContactStatus').textContent='Você falará diretamente com os atendentes da central.';};
 $('requestedCameras').oninput=updateLink;updateLink();
 }else if(view==='support'){await loadSupport(box,version)}
}
