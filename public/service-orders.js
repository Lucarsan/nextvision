// Ordens de serviço (OS) da assistência técnica, dentro de "Serviços do dia" (só nicho electronics).
// Abas: Do dia | Orçamentos pendentes | Fila de serviços | Concluídos | Entregues.
// Imprime na térmica 80 mm (comprovante de entrada e termo de garantia) e manda pelo WhatsApp da loja.
(() => {
  const H = () => window.FPSales.h; // helpers do caixa (api, esc, brl…), prontos quando o painel carrega
  const $ = id => document.getElementById(id);
  const TYPES = ['Celular', 'Tablet', 'Notebook', 'Computador', 'Videogame', 'Relógio', 'Fone', 'Outro'];
  const STAGES = ['Em andamento', 'Aguardando peça', 'Aguardando aprovação do cliente', 'Aguardando retorno do cliente', 'Em teste', 'Outro'];
  const WARRANTY = [[0, 'Sem garantia'], [7, '7 dias'], [30, '30 dias'], [90, '90 dias'], [180, '6 meses'], [365, '1 ano']];
  const TABS = [['day', 'Do dia'], ['quote', 'Orçamentos pendentes'], ['queue', 'Fila de serviços'], ['done', 'Concluídos'], ['delivered', 'Entregues']];
  const DEFAULT_TERMS = 'A garantia cobre somente o serviço executado e a peça trocada. Não cobre quedas, pancadas, tela trincada, contato com água ou umidade, oxidação, mau uso, violação do lacre ou conserto feito por terceiros. Para usar a garantia, traga o aparelho com este termo.';
  const DEFAULT_READY = 'Olá, {cliente}! Seu {aparelho} (OS {os}) está pronto aqui na {loja}. {valor}Pode vir buscar quando quiser!';
  const DEFAULT_RETURN = 'Olá, {cliente}! Seu {aparelho} (OS {os}) já pode ser retirado aqui na {loja}.';
  const DEFAULT_QUOTE = 'Olá, {cliente}! O orçamento do seu {aparelho} (OS {os}) aqui na {loja}:\n{servico}\nValor: {valor}\n\nPodemos fazer? É só responder esta mensagem.';
  let tab = 'day', search = '', settings = null, counts = { quote: 0, queue: 0, done: 0 };

  const ymd = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';
  const dt = d => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: settings?.timezone || 'America/Fortaleza' }).format(new Date());
  const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const device = o => [o.brand, o.model].filter(x => x && x.trim()).join(' ') || o.device_type || 'aparelho';
  const fill = (tpl, o, extra = {}) => tpl.replace(/\{(\w+)\}/g, (m, k) => ({ cliente: H().greetName(o.customer_name) || 'cliente', loja: settings?.name || '', os: o.number, aparelho: device(o), servico: o.service || o.problem || '', ...extra })[k] ?? m).replace(/[ \t]+\n/g, '\n').trim();
  const waOpen = (phone, text) => { const w = window.open(H().waLink(phone, text), '_blank'); if (w) w.opener = null; };
  const warrantyText = days => !days ? 'sem garantia' : days % 30 === 0 && days >= 60 ? (days === 365 ? '1 ano' : days / 30 + ' meses') + ` (${days} dias)` : days + ' dias';

  async function loadSettings() { settings = await H().api('/store/service-orders/settings'); return settings; }

  // ---------- Impressão na térmica 80 mm (mesma forma do comprovante de venda) ----------
  function printThermal(title, body) {
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${H().esc(title)}</title><style>
      @page{size:80mm 200mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000}
      body{width:72mm;margin:0 auto;padding:2mm 0 6mm;font:12px/1.35 Arial,Helvetica,sans-serif}
      .c{text-align:center}.store{font-size:16px;font-weight:700}.hr{border-top:1px dashed #000;margin:6px 0}.title{font-weight:700;letter-spacing:.04em;font-size:14px}
      .row{display:flex;justify-content:space-between;gap:8px}.row span:last-child{text-align:right}.small{font-size:11px}.b{font-weight:700}.big{font-size:15px;font-weight:700}
      .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.04em;margin-top:4px}.sign{margin-top:26px;border-top:1px solid #000;text-align:center;font-size:11px;padding-top:2px}p{margin:2px 0}
    </style></head><body>${body}</body></html>`;
    const frame = document.createElement('iframe'); frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:80mm;height:400px;border:0'; document.body.append(frame);
    const doc = frame.contentDocument; doc.open(); doc.write(html); doc.close();
    window.FPServiceOrders.lastPrintHtml = html;
    setTimeout(() => {
      try {
        const mm = Math.ceil(doc.body.getBoundingClientRect().height * 25.4 / 96) + 4;
        const st = doc.createElement('style'); st.textContent = `@page{size:80mm ${Math.max(60, mm)}mm;margin:0}`; doc.head.append(st);
        frame.contentWindow.focus(); frame.contentWindow.print();
      } finally { setTimeout(() => frame.remove(), 60000); }
    }, 150);
  }
  function storeHead() {
    const { esc, phoneBR } = H(), s = settings || {}, place = [s.city, s.state].filter(Boolean).join('/');
    return `<div class="c store">${esc(s.name)}</div>${s.address ? `<div class="c small">${esc(s.address)}${place ? ' · ' + esc(place) : ''}</div>` : place ? `<div class="c small">${esc(place)}</div>` : ''}${s.whatsapp ? `<div class="c small">WhatsApp ${esc(phoneBR(s.whatsapp))}</div>` : ''}<div class="hr"></div>`;
  }
  const line = (label, value) => value ? `<div class="lbl">${label}</div><p>${H().esc(value)}</p>` : '';

  // Garantia de uma OS ou de um serviço lançado direto no caixa (linha de "Do dia").
  // w: { number?, customer_name, customer_phone, device, serial?, service, price_cents, days, from }
  function warrantyOf(o) {
    return { number: o.number, customer_name: o.customer_name, customer_phone: o.customer_phone, device: [o.device_type, device(o)].filter((x, i, a) => x && a.indexOf(x) === i).join(' · '),
      serial: o.serial, service: o.service || o.problem, price_cents: o.price_cents, days: o.warranty_days, from: o.warranty_from || today() };
  }
  function printWarranty(w) {
    const { esc, brl, phoneBR } = H(), until = addDays(w.from, w.days || 0);
    printThermal('Garantia' + (w.number ? ' OS ' + w.number : ''), `${storeHead()}<div class="c title">TERMO DE GARANTIA</div>
      <div class="row"><span>${w.number ? 'OS nº <b>' + w.number + '</b>' : 'Serviço'}</span><span>${ymd(w.from)}</span></div><div class="hr"></div>
      ${line('Cliente', w.customer_name)}${w.customer_phone ? `<p class="small">${esc(phoneBR(w.customer_phone))}</p>` : ''}
      ${line('Aparelho', w.device)}${line('IMEI / nº de série', w.serial)}${line('Serviço executado', w.service)}
      ${w.price_cents ? `<div class="row"><span class="lbl">Valor</span><span class="b">${brl(w.price_cents)}</span></div>` : ''}<div class="hr"></div>
      ${w.days ? `<div class="c big">Garantia: ${esc(warrantyText(w.days))}</div><div class="c">de ${ymd(w.from)} até <b>${ymd(until)}</b></div>` : '<div class="c big">Serviço sem garantia</div>'}
      <div class="hr"></div><p class="small">${esc(settings?.os_warranty_terms || DEFAULT_TERMS)}</p>
      <div class="sign">Assinatura da loja</div><div class="sign">Assinatura do cliente</div>`);
  }
  function whatsWarranty(w) {
    const { brl } = H(), until = addDays(w.from, w.days || 0);
    const text = [`Olá, ${H().greetName(w.customer_name) || 'cliente'}! Segue a garantia do seu serviço na ${settings?.name || 'loja'}:`, '',
      w.number ? `OS nº ${w.number}` : '', `Aparelho: ${w.device}`, w.serial ? `IMEI/série: ${w.serial}` : '', `Serviço: ${w.service || ''}`, w.price_cents ? `Valor: ${brl(w.price_cents)}` : '',
      w.days ? `Garantia de ${warrantyText(w.days)}: de ${ymd(w.from)} até ${ymd(until)}.` : 'Serviço sem garantia.', '', settings?.os_warranty_terms || DEFAULT_TERMS].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n').replace(/\n{3,}/g, '\n\n');
    waOpen(w.customer_phone, text);
  }
  // Janela com os dois botões (imprimir / WhatsApp) e os dias de garantia ajustáveis.
  async function warrantyDialog(w) {
    if (!settings) await loadSettings();
    const { esc, openDialog, header } = H();
    const opts = WARRANTY.some(([d]) => d === w.days) ? WARRANTY : [...WARRANTY, [w.days, w.days + ' dias']];
    openDialog(`${header('Garantia' + (w.number ? ' · OS ' + w.number : ''))}
      <p><b>${esc(w.customer_name || 'Cliente')}</b> · ${esc(w.device || '')}<br><span class="nv-help">${esc(w.service || '')}</span></p>
      <div class="fs-row"><label class="nv-field">Garantia<select id="soWDays">${opts.map(([d, t]) => `<option value="${d}" ${d === (w.days || 0) ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="nv-field">A partir de<input type="date" id="soWFrom" value="${w.from}"></label></div>
      <p class="nv-help" id="soWUntil"></p>
      <div class="fs-row"><button type="button" class="nv-button" id="soWPrint">${FPIcon('printer')} Imprimir garantia</button><button type="button" class="nv-button secondary" id="soWWa">${FPIcon('message')} Enviar no WhatsApp</button></div>
      ${w.customer_phone ? '' : '<p class="nv-help">Cliente sem telefone: o WhatsApp abre para você escolher o contato.</p>'}`);
    const cur = () => ({ ...w, days: Number($('soWDays').value), from: $('soWFrom').value || w.from });
    const upd = () => { const c = cur(); $('soWUntil').textContent = c.days ? `Vale até ${ymd(addDays(c.from, c.days))}.` : 'Sem garantia.'; };
    $('soWDays').onchange = upd; $('soWFrom').onchange = upd; upd();
    $('soWPrint').onclick = () => printWarranty(cur());
    $('soWWa').onclick = () => whatsWarranty(cur());
  }

  // ---------- Comprovante de entrada da OS ----------
  function printEntry(o) {
    const { brl } = H();
    printThermal('OS ' + o.number, `${storeHead()}<div class="c title">ORDEM DE SERVIÇO Nº ${o.number}</div><div class="c small">Entrada ${dt(o.created_at)}</div><div class="hr"></div>
      ${line('Cliente', o.customer_name)}${o.customer_phone ? `<p class="small">${H().esc(H().phoneBR(o.customer_phone))}</p>` : ''}
      ${line('Aparelho', [o.device_type, device(o)].filter(Boolean).join(' · '))}${line('IMEI / nº de série', o.serial)}${line('Cor', o.color)}
      ${line('Acessórios deixados', o.accessories)}${line('Estado do aparelho', o.condition)}${line('Defeito relatado', o.problem)}${line('Serviço', o.service)}<div class="hr"></div>
      <div class="row"><span>Valor</span><span class="b">${o.status === 'quote' && !o.price_cents ? 'a orçar' : brl(o.price_cents)}</span></div>
      ${o.due_on ? `<div class="row"><span>Prazo</span><span class="b">${ymd(o.due_on)}</span></div>` : ''}
      <div class="row"><span>Garantia do serviço</span><span>${warrantyText(o.warranty_days)}</span></div>
      <div class="hr"></div><p class="small">Guarde este comprovante para retirar o aparelho. Aparelhos não retirados em 90 dias após o aviso de pronto poderão ser descartados conforme a lei.</p>
      <div class="sign">Assinatura do cliente</div>`);
  }
  function whatsEntry(o) {
    const { brl } = H();
    waOpen(o.customer_phone, [`Olá, ${H().greetName(o.customer_name) || 'cliente'}! Recebemos seu aparelho na ${settings?.name || 'loja'}.`, '', `OS nº ${o.number}`, `Aparelho: ${device(o)}`,
      o.problem ? `Defeito: ${o.problem}` : '', o.service ? `Serviço: ${o.service}` : '', o.status === 'quote' && !o.price_cents ? 'Valor: vamos fazer o orçamento e te avisamos.' : `Valor: ${brl(o.price_cents)}`,
      o.due_on ? `Prazo: ${ymd(o.due_on)}` : ''].filter(Boolean).join('\n'));
  }

  // ---------- Nova OS / editar ----------
  function osForm(o) {
    const { esc } = H(), isNew = !o.id, v = k => esc(o[k] ?? '');
    const wd = o.warranty_days ?? settings?.os_warranty_days ?? 90, opts = WARRANTY.some(([d]) => d === wd) ? WARRANTY : [...WARRANTY, [wd, wd + ' dias']];
    const price = o.price_cents ? (o.price_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '';
    return `<form id="soForm" class="so-form" autocomplete="off">
      ${isNew ? `<section class="nv-form-panel"><h3>Cliente</h3><div class="fs-sugg"><label class="nv-field">Buscar cliente (nome ou telefone)<input id="soCustQ" placeholder="Digite 2 letras ou o telefone"></label><div class="fs-drop fs-results" id="soCustDrop"></div></div>
        <div id="soCustPicked"></div>
        <div class="fs-row" id="soNewCust"><label class="nv-field fs-grow">Nome do cliente novo<input name="cname" maxlength="120"></label><label class="nv-field">WhatsApp<input name="cphone" inputmode="tel" maxlength="30" placeholder="(85) 9…"></label></div></section>`
        : `<p><b>${esc(o.customer_name)}</b>${o.customer_phone ? ' · ' + esc(H().phoneBR(o.customer_phone)) : ''}</p>`}
      <section class="nv-form-panel"><h3>Aparelho</h3><div class="so-grid">
        <label class="nv-field">Tipo<select name="device_type">${TYPES.map(t => `<option ${t === (o.device_type || 'Celular') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="nv-field">Marca<input name="brand" maxlength="60" value="${v('brand')}" placeholder="Samsung, Apple…"></label>
        <label class="nv-field">Modelo<input name="model" maxlength="80" value="${v('model')}" placeholder="A32, iPhone 11…"></label>
        <label class="nv-field">IMEI / nº de série<input name="serial" maxlength="60" value="${v('serial')}"></label>
        <label class="nv-field">Cor<input name="color" maxlength="40" value="${v('color')}"></label>
        <label class="nv-field">Acessórios deixados<input name="accessories" maxlength="200" value="${v('accessories')}" placeholder="capinha, chip, carregador…"></label></div>
        <label class="nv-field">Estado do aparelho na entrada<input name="condition" maxlength="500" value="${v('condition')}" placeholder="riscos, tela trincada, liga ou não…"></label></section>
      <section class="nv-form-panel"><h3>Serviço</h3>
        <label class="nv-field">Defeito relatado pelo cliente<input name="problem" maxlength="500" value="${v('problem')}"></label>
        <label class="nv-field">Serviço a fazer<input name="service" maxlength="300" value="${v('service')}" placeholder="Troca de tela, bateria…"></label>
        <div class="so-grid"><label class="nv-field">Valor (R$)<input name="price" inputmode="decimal" value="${price}" placeholder="0,00"></label>
        <label class="nv-field">Prazo combinado<input type="date" name="due_on" value="${v('due_on')}"></label>
        <label class="nv-field">Garantia<select name="warranty_days">${opts.map(([d, t]) => `<option value="${d}" ${d === wd ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>
        ${isNew ? `<label class="fs-check"><input type="checkbox" name="quote" ${o.quote ? 'checked' : ''}> <span>Ainda vai orçar (vai para <b>Orçamentos pendentes</b>)</span></label>` : ''}
        ${!isNew && o.status === 'queue' ? `<div class="so-grid"><label class="nv-field">Situação<select name="stage"><option value="">—</option>${STAGES.map(s => `<option ${s === o.stage ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <label class="nv-field so-span2">Por que está parado / observação<input name="stage_note" maxlength="300" value="${v('stage_note')}"></label></div>` : ''}
        ${!isNew && o.pay_state === 'paid' ? '<p class="nv-help">Já pago no caixa: o valor não muda mais.</p>' : '<p class="nv-help">Com valor e aprovada, a OS entra em <b>A receber</b> no caixa. Ao receber lá, ela fica paga aqui.</p>'}</section>
      <div class="fs-row"><button class="nv-button">${isNew ? 'Abrir OS' : 'Salvar'}</button><button type="button" class="nv-button secondary" data-close-dialog>Fechar</button>
        ${!isNew && !['delivered'].includes(o.status) && o.pay_state !== 'paid' ? `<button type="button" class="fs-link fs-neg" id="soCancel">Cancelar esta OS</button>` : ''}</div>
      <p role="status" class="fs-neg"></p></form>`;
  }
  async function openForm(o, box, alive) {
    if (!settings) await loadSettings();
    const { api, openDialog, header, parseMoney, esc, phoneBR } = H(), isNew = !o.id;
    openDialog(header(isNew ? 'Nova ordem de serviço' : `OS ${o.number}`) + osForm(o));
    const f = $('soForm'), out = f.querySelector('[role=status]'); let customer = null;
    if (isNew) {
      const q = $('soCustQ'), drop = $('soCustDrop'); let timer;
      const pick = c => { customer = c; drop.innerHTML = ''; q.value = ''; $('soNewCust').hidden = !!c;
        $('soCustPicked').innerHTML = c ? `<div class="fs-picked"><span><b>${esc(c.name)}</b>${c.phone ? ' · ' + esc(phoneBR(c.phone)) : ''}</span><button type="button" class="fs-link" id="soCustX">Trocar</button></div>` : '';
        if (c) $('soCustX').onclick = () => pick(null); };
      q.oninput = () => { clearTimeout(timer); timer = setTimeout(async () => {
        if (q.value.trim().length < 2) { drop.innerHTML = ''; return; }
        const list = await api('/store/sales/customers?q=' + encodeURIComponent(q.value.trim())).catch(() => []);
        const uniq = list.filter((c, i) => list.findIndex(x => x.id === c.id) === i);
        drop.innerHTML = uniq.length ? uniq.map((c, i) => `<button type="button" data-i="${i}"><b>${esc(c.name)}</b>${c.phone ? ' · ' + esc(phoneBR(c.phone)) : ''}</button>`).join('') : '<p>Nenhum cliente. Preencha "cliente novo" abaixo.</p>';
        drop.querySelectorAll('[data-i]').forEach(b => b.onclick = () => pick(uniq[b.dataset.i]));
      }, 250); };
    }
    if ($('soCancel')) $('soCancel').onclick = async () => {
      const reason = prompt('Motivo do cancelamento da OS ' + o.number + ':'); if (!reason || reason.trim().length < 3) return;
      try { await api(`/store/service-orders/${o.id}/cancel`, 'POST', { reason: reason.trim() }); $('editorDialog').close(); H().feedback(`OS ${o.number} cancelada.`); refresh(box, alive); }
      catch (e) { out.textContent = e.message; }
    };
    f.onsubmit = async e => {
      e.preventDefault(); out.textContent = ''; const el = f.elements, body = {};
      for (const k of ['device_type', 'brand', 'model', 'serial', 'color', 'accessories', 'condition', 'problem', 'service']) body[k] = el[k].value.trim();
      const p = el.price.value.trim() ? parseMoney(el.price.value) : 0;
      if (!Number.isFinite(p) || p < 0) { out.textContent = 'Valor inválido.'; return; }
      body.price_cents = p; body.due_on = el.due_on.value || null; body.warranty_days = Number(el.warranty_days.value);
      if (el.stage) { body.stage = el.stage.value; body.stage_note = el.stage_note.value.trim(); }
      if (isNew) {
        body.quote = el.quote.checked;
        if (customer) body.customer_id = customer.id;
        else if (el.cname.value.trim().length >= 2) body.new_customer = { name: el.cname.value.trim(), phone: el.cphone.value.trim() };
        else { out.textContent = 'Escolha o cliente ou digite o nome do cliente novo.'; return; }
      }
      const btn = f.querySelector('button'); btn.disabled = true;
      try {
        const r = isNew ? await api('/store/service-orders', 'POST', body) : await api('/store/service-orders/' + o.id, 'PATCH', body);
        if (isNew) { tab = r.status; afterCreate(r, box, alive); } else { $('editorDialog').close(); H().feedback(`OS ${r.number} salva.`); }
        refresh(box, alive);
      } catch (err) { out.textContent = err.message; btn.disabled = false; }
    };
  }
  function afterCreate(o, box, alive) {
    const { openDialog, header, esc } = H();
    openDialog(`${header('OS ' + o.number + ' aberta')}<p><b>${esc(o.customer_name)}</b> · ${esc(device(o))}<br><span class="nv-help">${o.status === 'quote' ? 'Está em Orçamentos pendentes.' : 'Está na Fila de serviços.'}${o.pay_state === 'open' ? ` Lançada em A receber (#${o.pending_number}) no caixa.` : ''}</span></p>
      <div class="fs-row"><button type="button" class="nv-button" id="soEPrint">${FPIcon('printer')} Imprimir comprovante</button><button type="button" class="nv-button secondary" id="soEWa">${FPIcon('message')} Enviar no WhatsApp</button><button type="button" class="nv-button secondary" data-close-dialog>Fechar</button></div>`);
    $('soEPrint').onclick = () => printEntry(o); $('soEWa').onclick = () => whatsEntry(o);
  }
  function settingsDialog() {
    const { openDialog, header, esc, api } = H(), s = settings;
    openDialog(`${header('Padrões da OS')}<form id="soSet">
      <label class="nv-field">Garantia padrão<select name="days">${WARRANTY.map(([d, t]) => `<option value="${d}" ${d === s.os_warranty_days ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="nv-field">Termos da garantia (saem no papel e no WhatsApp)<textarea name="terms" rows="4" maxlength="1500" placeholder="${esc(DEFAULT_TERMS)}">${esc(s.os_warranty_terms)}</textarea></label>
      <label class="nv-field">Mensagem de serviço pronto<textarea name="ready" rows="3" maxlength="1000" placeholder="${esc(DEFAULT_READY)}">${esc(s.os_ready_message)}</textarea></label>
      <label class="nv-field">Mensagem do orçamento<textarea name="quote" rows="4" maxlength="1000" placeholder="${esc(DEFAULT_QUOTE)}">${esc(s.os_quote_message)}</textarea></label>
      <p class="nv-help">Pode usar: {cliente}, {loja}, {os}, {aparelho}, {servico}, {valor}. Em branco = texto padrão (o cinza).</p>
      <div class="fs-row"><button class="nv-button">Salvar</button><button type="button" class="nv-button secondary" data-close-dialog>Fechar</button></div><p role="status" class="fs-neg"></p></form>`);
    const f = $('soSet');
    f.onsubmit = async e => {
      e.preventDefault();
      try { await api('/store/service-orders/settings', 'PATCH', { os_warranty_days: Number(f.elements.days.value), os_warranty_terms: f.elements.terms.value.trim(), os_ready_message: f.elements.ready.value.trim(), os_quote_message: f.elements.quote.value.trim() }); await loadSettings(); $('editorDialog').close(); H().feedback('Padrões da OS salvos.'); }
      catch (err) { f.querySelector('[role=status]').textContent = err.message; }
    };
  }
  // Aprovar orçamento: confirma o valor (vai para a fila e para "A receber").
  function approveDialog(o, box, alive) {
    const { openDialog, header, esc, api, parseMoney } = H();
    openDialog(`${header('Orçamento aprovado · OS ' + o.number)}<form id="soAp"><p>${esc(o.customer_name)} · ${esc(device(o))}</p>
      <label class="nv-field">Valor aprovado (R$)<input name="price" inputmode="decimal" required value="${o.price_cents ? (o.price_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''}"></label>
      <div class="fs-row"><button class="nv-button">Mandar para a fila</button><button type="button" class="nv-button secondary" data-close-dialog>Voltar</button></div><p role="status" class="fs-neg"></p></form>`);
    const f = $('soAp'); f.elements.price.focus();
    f.onsubmit = async e => {
      e.preventDefault(); const p = parseMoney(f.elements.price.value);
      if (!Number.isFinite(p) || p < 0) { f.querySelector('[role=status]').textContent = 'Valor inválido.'; return; }
      try { await api(`/store/service-orders/${o.id}/status`, 'POST', { status: 'queue', price_cents: p }); $('editorDialog').close(); H().feedback(`OS ${o.number} na fila de serviços.`); refresh(box, alive); }
      catch (err) { f.querySelector('[role=status]').textContent = err.message; }
    };
  }

  // ---------- Lista ----------
  function payChip(o) {
    const { brl } = H();
    if (o.pay_state === 'paid') return `<span class="fs-tag fs-tag-ok">Pago · venda ${o.sale_number}</span>`;
    if (o.pay_state === 'open') return `<span class="fs-tag so-due">A receber ${brl(o.pending_total_cents)} · #${o.pending_number}</span>`;
    return o.status === 'quote' ? '<span class="fs-tag">a orçar</span>' : o.price_cents ? '' : '<span class="fs-tag">sem valor</span>';
  }
  function card(o) {
    const { esc, brl, phoneBR, custLink } = H(), late = o.due_on && o.due_on < today() && ['quote', 'queue'].includes(o.status);
    const stuck = o.stage && o.stage !== 'Em andamento';
    const acts = {
      quote: `<button type="button" class="nv-button fs-small" data-so="approve">${FPIcon('check')} Aprovado</button><button type="button" class="nv-button secondary fs-small" data-so="sendquote">${FPIcon('message')} Enviar orçamento</button><button type="button" class="nv-button secondary fs-small" data-so="refuse">Recusado</button>`,
      queue: `<button type="button" class="nv-button fs-small" data-so="done">${FPIcon('check')} Concluir</button><button type="button" class="nv-button secondary fs-small" data-so="stage">Situação</button>`,
      done: `<button type="button" class="nv-button fs-small" data-so="notify">${FPIcon('message')} Avisar cliente</button><button type="button" class="nv-button secondary fs-small" data-so="deliver">${FPIcon('check')} Entregue</button>${o.repaired ? `<button type="button" class="nv-button secondary fs-small" data-so="warranty">${FPIcon('receipt')} Garantia</button>` : ''}<button type="button" class="fs-link" data-so="reopen">Voltar para a fila</button>`,
      delivered: `<button type="button" class="nv-button fs-small" data-so="warranty">${FPIcon('receipt')} Garantia</button><button type="button" class="fs-link" data-so="undeliver">Desfazer entrega</button>`
    }[o.status];
    const when = { quote: 'Entrou ' + dt(o.created_at), queue: 'Entrou ' + dt(o.created_at), done: 'Concluída ' + dt(o.done_at), delivered: 'Entregue ' + dt(o.delivered_at) }[o.status];
    return `<article class="so-card${late ? ' so-late' : ''}${stuck ? ' so-stuck' : ''}" data-os="${o.id}">
      <div class="so-top"><b class="so-num">OS ${o.number}</b><span>${custLink(o.customer_id, esc(o.customer_name))}${o.customer_phone ? ` <small>${esc(phoneBR(o.customer_phone))}</small>` : ''}</span><span class="so-price">${o.price_cents ? brl(o.price_cents) : ''}</span></div>
      <div class="so-dev"><b>${esc(device(o))}</b>${o.device_type && o.device_type !== 'Celular' ? ' · ' + esc(o.device_type) : ''}${o.serial ? ` · <small>IMEI/série ${esc(o.serial)}</small>` : ''}</div>
      ${o.problem ? `<div><small>Defeito:</small> ${esc(o.problem)}</div>` : ''}${o.service ? `<div><small>Serviço:</small> ${esc(o.service)}</div>` : ''}
      <div class="so-chips">${payChip(o)}${o.due_on ? `<span class="fs-tag${late ? ' so-red' : ''}">prazo ${ymd(o.due_on)}${late ? ' · atrasada' : ''}</span>` : ''}${o.stage ? `<span class="fs-tag${stuck ? ' so-due' : ''}">${esc(o.stage)}</span>` : ''}${o.stage_note ? `<small>${esc(o.stage_note)}</small>` : ''}
        ${o.status === 'done' && !o.repaired ? '<span class="fs-tag so-red">sem conserto · devolver</span>' : ''}${o.notified_at ? `<span class="fs-tag fs-tag-ok">avisado ${dt(o.notified_at)}</span>` : ''}
        ${o.status === 'delivered' && o.repaired && o.warranty_days ? `<span class="fs-tag">garantia até ${ymd(o.warranty_until)}</span>` : ''}</div>
      <div class="so-acts">${acts}<button type="button" class="fs-link" data-so="edit">${FPIcon('edit')} Ver / editar</button><button type="button" class="fs-link" data-so="print">${FPIcon('printer')} Comprovante</button><small class="so-when">${when}</small></div></article>`;
  }

  async function act(kind, o, box, alive) {
    const { api, brl, feedback } = H();
    const move = async (status, extra = {}, msg) => { try { await api(`/store/service-orders/${o.id}/status`, 'POST', { status, ...extra }); feedback(msg); refresh(box, alive); } catch (e) { feedback(e.message, true); } };
    if (kind === 'edit') return openForm(await api('/store/service-orders/' + o.id), box, alive);
    if (kind === 'stage') return openForm(o, box, alive);
    if (kind === 'print') return printEntry(o);
    if (kind === 'approve') return approveDialog(o, box, alive);
    if (kind === 'refuse') { if (confirm(`Orçamento da OS ${o.number} recusado? Ela vai para Concluídos para devolver o aparelho (sem cobrança).`)) move('done', { repaired: false }, `OS ${o.number}: aparelho para devolver.`); return; }
    if (kind === 'sendquote') return waOpen(o.customer_phone, fill(settings.os_quote_message || DEFAULT_QUOTE, o, { valor: o.price_cents ? brl(o.price_cents) : 'a combinar' }));
    if (kind === 'done') return move('done', {}, `OS ${o.number} concluída. Avise o cliente em Concluídos.`);
    if (kind === 'reopen') return move('queue', {}, `OS ${o.number} voltou para a fila.`);
    if (kind === 'undeliver') return move('done', {}, `Entrega da OS ${o.number} desfeita.`);
    if (kind === 'deliver') {
      if (o.pay_state === 'open' && !confirm(`A OS ${o.number} ainda está em A receber (${brl(o.pending_total_cents)}). Receba no caixa. Marcar como entregue mesmo assim?`)) return;
      return move('delivered', {}, `OS ${o.number} entregue. A garantia conta a partir de hoje.`);
    }
    if (kind === 'notify') {
      const valor = o.pay_state === 'open' ? `Valor: ${brl(o.pending_total_cents)}. ` : '';
      waOpen(o.customer_phone, fill(o.repaired ? (settings.os_ready_message || DEFAULT_READY) : DEFAULT_RETURN, o, { valor }));
      api(`/store/service-orders/${o.id}/notified`, 'POST').then(() => refresh(box, alive)).catch(() => {});
      return;
    }
    if (kind === 'warranty') return warrantyDialog(warrantyOf(o));
  }

  async function refresh(box, alive) { return mount(box, alive, renderDayRef); }
  let renderDayRef = null;
  // Monta as abas; "Do dia" é a lista de sempre (store-sales.js), as outras são as OS.
  async function mount(box, alive, renderDay) {
    renderDayRef = renderDay;
    if (!settings) await loadSettings();
    const { esc, api } = H();
    box.innerHTML = `<section class="nv-card so-bar"><div class="so-head"><h2>Serviços</h2><div class="fs-row"><button type="button" class="nv-button" id="soNew">${FPIcon('plus')} Nova OS</button>${settings.role === 'owner' ? `<button type="button" class="nv-button secondary fs-small" id="soSetBtn">${FPIcon('settings')} Padrões</button>` : ''}</div></div>
      <div class="fs-tabs so-tabs" role="tablist">${TABS.map(([k, t]) => `<button type="button" role="tab" data-so-tab="${k}" aria-selected="${k === tab}">${t}${counts[k] ? ` <span class="so-count">${counts[k]}</span>` : ''}</button>`).join('')}</div>
      ${tab === 'day' ? '' : `<input class="fs-svc-filter" id="soQ" placeholder="Buscar por cliente, telefone, aparelho, IMEI ou nº da OS" value="${esc(search)}">`}<div id="soList"></div></section><div id="soDay"></div>`;
    $('soNew').onclick = () => openForm({}, box, alive);
    if ($('soSetBtn')) $('soSetBtn').onclick = settingsDialog;
    box.querySelectorAll('[data-so-tab]').forEach(b => b.onclick = () => { tab = b.dataset.soTab; mount(box, alive, renderDay); });
    let t; if ($('soQ')) $('soQ').oninput = e => { clearTimeout(t); t = setTimeout(() => { search = e.target.value; list(box, alive); }, 300); };
    const tabsCounts = d => { counts = d.counts; box.querySelectorAll('[data-so-tab]').forEach(b => { const n = counts[b.dataset.soTab]; const k = TABS.find(x => x[0] === b.dataset.soTab)[1]; b.innerHTML = k + (n ? ` <span class="so-count">${n}</span>` : ''); }); };
    if (tab === 'day') { api('/store/service-orders?status=queue').then(d => alive() && tabsCounts(d)).catch(() => {}); return renderDay($('soDay')); }
    return list(box, alive, tabsCounts);
  }
  async function list(box, alive, tabsCounts) {
    const d = await H().api(`/store/service-orders?status=${tab}${search ? '&q=' + encodeURIComponent(search) : ''}`); if (!alive()) return;
    if (tabsCounts) tabsCounts(d); else { counts = d.counts; }
    const el = $('soList'); if (!el) return;
    const empty = { quote: 'Nenhum aparelho esperando orçamento.', queue: 'Nenhum serviço na fila.', done: 'Nenhum serviço concluído esperando o cliente.', delivered: 'Nenhuma OS entregue.' }[tab];
    const help = { quote: 'Aparelhos que chegaram e ainda precisam de orçamento ou da resposta do cliente.', queue: 'O que falta fazer, pelo prazo. Use "Situação" para marcar o que está parado e por quê.', done: 'Prontos: avise o cliente pelo WhatsApp e marque Entregue quando ele buscar.', delivered: 'Últimas 100 entregues. A garantia conta da entrega.' }[tab];
    el.innerHTML = `<p class="nv-help">${help}</p>` + (d.rows.length ? d.rows.map(card).join('') : `<p class="nv-help">${search ? 'Nada encontrado.' : empty}</p>`);
    el.querySelectorAll('[data-os]').forEach(c => { const o = d.rows.find(x => x.id === c.dataset.os); c.querySelectorAll('[data-so]').forEach(b => b.onclick = () => act(b.dataset.so, o, box, alive)); });
  }

  // Garantia a partir de uma linha de "Do dia" (serviço pago no caixa). Se veio de uma OS, usa a OS.
  async function warrantyFromDay(row, day) {
    try {
      if (!settings) await loadSettings();
      if (row.os_id) return warrantyDialog(warrantyOf(await H().api('/store/service-orders/' + row.os_id)));
      return warrantyDialog({ customer_name: row.customer_name, customer_phone: row.customer_phone, device: row.pet || '', service: String(row.service || '').replace(/^OS \d+ · /, ''), price_cents: row.total_cents, days: row.warranty_days ?? settings.os_warranty_days, from: day });
    } catch (e) { H().feedback(e.message, true); }
  }

  const css = `.so-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}.so-head h2{margin:0}.so-bar{margin-bottom:14px}.so-tabs{margin-bottom:10px}
  .so-count{display:inline-block;min-width:20px;padding:0 6px;border-radius:999px;background:var(--nv-blue-soft,#e8f0fe);color:var(--nv-blue,#2563eb);font-size:12px;font-weight:700;text-align:center}
  .so-card{border:1px solid var(--nv-border);border-radius:12px;padding:10px 12px;margin:8px 0;display:grid;gap:4px;font-size:14px}.so-card small{color:var(--nv-muted)}
  .so-card.so-stuck{border-left:4px solid #f59e0b}.so-card.so-late{border-left:4px solid #b42318}.so-top{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.so-num{font-size:15px}.so-price{margin-left:auto;font-weight:700}
  .so-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.so-due{background:#fff1cc!important;color:#7a4b00!important}.so-red{background:#fdecea!important;color:#b42318!important}
  .so-acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px}.so-when{margin-left:auto}.so-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 12px}.so-span2{grid-column:span 2}
  .so-form .nv-form-panel{margin-bottom:12px}.so-form .nv-field input,.so-form .nv-field select{width:100%}.fs-day-row .fs-link{padding:0 4px;font-size:12px}
  @media(max-width:700px){.so-grid{grid-template-columns:1fr 1fr}.so-span2{grid-column:1/-1}.so-when{margin-left:0;width:100%}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.append(st);
  window.FPServiceOrders = { mount, warrantyFromDay, printWarranty, warrantyDialog, enabled: () => window.FPSales?.h?.config()?.niche === 'electronics' };
})();
