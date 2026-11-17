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
  const ACCESSORIES = ['Gaveta de chip', 'Chip', 'Cartão de memória', 'Capa', 'Carregador', 'Cabo'];
  let tab = 'day', search = '', settings = null, counts = { quote: 0, queue: 0, done: 0 };

  const ymd = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';
  const dt = d => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: settings?.timezone || 'America/Fortaleza' }).format(new Date());
  const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const device = o => [o.brand, o.model].filter(x => x && x.trim()).join(' ') || o.device_type || 'aparelho';
  const fill = (tpl, o, extra = {}) => tpl.replace(/\{(\w+)\}/g, (m, k) => ({ cliente: H().greetName(o.customer_name) || 'cliente', loja: settings?.name || '', os: o.number, aparelho: device(o), servico: o.service || o.problem || '', ...extra })[k] ?? m).replace(/[ \t]+\n/g, '\n').trim();
  const waOpen = (phone, text) => { const w = window.open(H().waLink(phone, text), '_blank'); if (w) w.opener = null; };
  // Mostra a mensagem antes de abrir o WhatsApp (dá para ajustar o texto). As quebras de linha vão como estão.
  function previewSend(title, phone, text, onSent) {
    const { openDialog, header, esc, phoneBR } = H();
    openDialog(`${header(title)}<p class="nv-help">Para ${phone ? esc(phoneBR(phone)) : 'escolher o contato no WhatsApp'}. Confira e ajuste antes de enviar.</p>
      <textarea id="soMsg" class="so-msg" rows="${Math.min(16, text.split('\n').length + 2)}">${esc(text)}</textarea>
      <div class="fs-row"><button type="button" class="nv-button" id="soMsgGo">${FPIcon('message')} Abrir no WhatsApp</button><button type="button" class="nv-button secondary" data-close-dialog>Fechar</button></div>`);
    $('soMsgGo').onclick = () => { waOpen(phone, $('soMsg').value); onSent?.(); $('editorDialog').close(); };
  }
  const warrantyText = days => !days ? 'sem garantia' : days % 30 === 0 && days >= 60 ? (days === 365 ? '1 ano' : days / 30 + ' meses') + ` (${days} dias)` : days + ' dias';

  async function loadSettings() { settings = await H().api('/store/service-orders/settings'); return settings; }

  // ---------- Impressão na térmica 80 mm (mesma forma do comprovante de venda) ----------
  const thermalHtml = (title, body) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${H().esc(title)}</title><style>
      @page{size:80mm 200mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000}
      body{width:72mm;margin:0 auto;padding:2mm 0 6mm;font:12px/1.35 Arial,Helvetica,sans-serif}
      .c{text-align:center}.store{font-size:16px;font-weight:700}.hr{border-top:1px dashed #000;margin:6px 0}.title{font-weight:700;letter-spacing:.04em;font-size:14px}
      .row{display:flex;justify-content:space-between;gap:8px}.row span:last-child{text-align:right}.small{font-size:11px}.b{font-weight:700}.big{font-size:15px;font-weight:700}
      .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.04em;margin-top:4px}.sign{margin-top:26px;border-top:1px solid #000;text-align:center;font-size:11px;padding-top:2px}p{margin:2px 0}
    </style></head><body>${body}</body></html>`;
  function printThermal(title, body) { printHtml(thermalHtml(title, body)); }
  function printHtml(html) {
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
      serial: o.serial, service: o.service || o.problem, price_cents: o.price_cents, days: o.warranty_days, from: o.warranty_from || today(), source: 'os', source_id: o.id };
  }
  function warrantyHtml(w) {
    const { esc, brl, phoneBR } = H(), until = addDays(w.from, w.days || 0);
    return thermalHtml('Garantia' + (w.number ? ' OS ' + w.number : ''), `${storeHead()}<div class="c title">TERMO DE GARANTIA</div>
      <div class="row"><span>${w.number ? 'OS nº <b>' + w.number + '</b>' : 'Serviço'}</span><span>${ymd(w.from)}</span></div><div class="hr"></div>
      ${line('Cliente', w.customer_name)}${w.customer_phone ? `<p class="small">${esc(phoneBR(w.customer_phone))}</p>` : ''}
      ${line('Aparelho', w.device)}${line('IMEI / nº de série', w.serial)}${line('Serviço executado', w.service)}
      ${w.price_cents ? `<div class="row"><span class="lbl">Valor</span><span class="b">${brl(w.price_cents)}</span></div>` : ''}<div class="hr"></div>
      ${w.days ? `<div class="c big">Garantia: ${esc(warrantyText(w.days))}</div><div class="c">de ${ymd(w.from)} até <b>${ymd(until)}</b></div>` : '<div class="c big">Serviço sem garantia</div>'}
      <div class="hr"></div><p class="small">${esc(settings?.os_warranty_terms || DEFAULT_TERMS)}</p>
      <div class="sign">Assinatura da loja</div><div class="sign">Assinatura do cliente</div>`);
  }
  const printWarranty = w => printHtml(warrantyHtml(w));
  function warrantyMsg(w, url) {
    const { brl } = H(), until = addDays(w.from, w.days || 0);
    return [`Olá, ${H().greetName(w.customer_name) || 'cliente'}! Segue a garantia do seu serviço na ${settings?.name || 'loja'}:`, '',
      w.number ? `OS nº ${w.number}` : '', `Aparelho: ${w.device}`, w.serial ? `IMEI/série: ${w.serial}` : '', `Serviço: ${w.service || ''}`, w.price_cents ? `Valor: ${brl(w.price_cents)}` : '',
      w.days ? `Garantia de ${warrantyText(w.days)}: de ${ymd(w.from)} até ${ymd(until)}.` : 'Serviço sem garantia.', '',
      url ? `Termo da garantia (abrir, imprimir ou salvar em PDF):\n${url}` : '', '', settings?.os_warranty_terms || DEFAULT_TERMS].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n').replace(/\n{3,}/g, '\n\n');
  }
  // Janela da garantia: prévia do papel (80 mm), dias ajustáveis, imprimir e mensagem do WhatsApp com o link do termo.
  async function warrantyDialog(w) {
    if (!settings) await loadSettings();
    const { esc, openDialog, header, api } = H();
    const opts = WARRANTY.some(([d]) => d === w.days) ? WARRANTY : [...WARRANTY, [w.days, w.days + ' dias']];
    openDialog(`${header('Garantia' + (w.number ? ' · OS ' + w.number : ''))}
      <div class="so-wgrid"><div><p><b>${esc(w.customer_name || 'Cliente')}</b> · ${esc(w.device || '')}<br><span class="nv-help">${esc(w.service || '')}</span></p>
        <div class="fs-row"><label class="nv-field">Garantia<select id="soWDays">${opts.map(([d, t]) => `<option value="${d}" ${d === (w.days || 0) ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="nv-field">A partir de<input type="date" id="soWFrom" value="${w.from}"></label></div>
        <button type="button" class="nv-button" id="soWPrint">${FPIcon('printer')} Imprimir garantia</button>
        <h3 class="so-h3">Mensagem do WhatsApp</h3><textarea id="soWMsg" class="so-msg" rows="11"></textarea>
        <p class="nv-help" id="soWLink">Gerando o link do termo…</p>
        <div class="fs-row"><button type="button" class="nv-button secondary" id="soWWa">${FPIcon('message')} Abrir no WhatsApp</button>${w.customer_phone ? '' : '<span class="nv-help">Cliente sem telefone: escolha o contato no WhatsApp.</span>'}</div></div>
      <div><div class="nv-help">Prévia da impressão</div><iframe id="soWPrev" class="so-prev" title="Prévia da garantia"></iframe></div></div>`);
    let url = '', seq = 0;
    const cur = () => ({ ...w, days: Number($('soWDays').value), from: $('soWFrom').value || w.from });
    const upd = async () => {
      const c = cur(), my = ++seq;
      $('soWPrev').srcdoc = warrantyHtml(c); $('soWMsg').value = warrantyMsg(c, url);
      if (!w.source_id) { $('soWLink').textContent = ''; return; }
      try {
        const r = await api('/store/service-orders/warranty-link', 'POST', { source: w.source, id: w.source_id, days: c.days, from: c.from });
        if (my !== seq || !$('soWMsg')) return; url = r.url;
        $('soWMsg').value = warrantyMsg(c, url);
        $('soWLink').innerHTML = `O cliente abre o termo por este link e pode imprimir ou salvar em PDF: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
      } catch (e) { if ($('soWLink')) $('soWLink').textContent = 'Link do termo indisponível: ' + e.message; }
    };
    $('soWDays').onchange = upd; $('soWFrom').onchange = upd; upd();
    $('soWPrint').onclick = () => printWarranty(cur());
    $('soWWa').onclick = () => waOpen(w.customer_phone, $('soWMsg').value);
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
    previewSend('Comprovante da OS ' + o.number, o.customer_phone, [`Olá, ${H().greetName(o.customer_name) || 'cliente'}! Recebemos seu aparelho na ${settings?.name || 'loja'}.`, '\u200b', `OS nº ${o.number}`, `Aparelho: ${device(o)}`,
      o.problem ? `Defeito: ${o.problem}` : '', o.service ? `Serviço: ${o.service}` : '', o.status === 'quote' && !o.price_cents ? 'Valor: vamos fazer o orçamento e te avisamos.' : `Valor: ${brl(o.price_cents)}`,
      o.due_on ? `Prazo: ${ymd(o.due_on)}` : ''].filter(Boolean).join('\n').replace('\n\u200b\n', '\n\n'));
  }

  // Acessórios: guardados como texto "Gaveta de chip, Chip, Outro: fone".
  const accList = t => String(t || '').split(',').map(x => x.trim()).filter(Boolean);
  const accHas = (t, a) => accList(t).some(x => x.toLowerCase() === a.toLowerCase());
  const accOther = t => accList(t).filter(x => !ACCESSORIES.some(a => a.toLowerCase() === x.toLowerCase())).map(x => x.replace(/^Outro:\s*/i, '')).join(', ');
  let sugg = null;
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
        </div>
        <fieldset class="so-acc"><legend>O cliente deixou junto</legend>${ACCESSORIES.map(a => `<label><input type="checkbox" name="acc" value="${a}" ${accHas(o.accessories, a) ? 'checked' : ''}> ${a}</label>`).join('')}
          <label><input type="checkbox" name="accOther" ${accOther(o.accessories) ? 'checked' : ''}> Outro</label><input name="accOtherText" maxlength="80" placeholder="qual?" value="${esc(accOther(o.accessories))}"></fieldset>
        <label class="nv-field">Estado do aparelho na entrada<input name="condition" maxlength="500" value="${v('condition')}" placeholder="riscos, tela trincada, liga ou não…"></label></section>
      <section class="nv-form-panel"><h3>Serviço</h3>
        <label class="nv-field">Defeito relatado pelo cliente<input name="problem" maxlength="500" value="${v('problem')}"></label>
        <div class="fs-chips so-chips-q" id="soProbChips"></div>
        <label class="nv-field">Serviço a fazer<input name="service" maxlength="300" value="${v('service')}" placeholder="Troca de tela, bateria…"></label>
        <div class="fs-chips so-chips-q" id="soSvcChips"></div>
        <div class="so-grid"><label class="nv-field">Valor de venda (R$)<input name="price" inputmode="decimal" value="${price}" placeholder="0,00"></label>
        <label class="nv-field">Custo (R$)<input name="cost" inputmode="decimal" value="${o.cost_cents != null ? (o.cost_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''}" placeholder="peça + gastos"></label>
        <div class="nv-field"><span>Lucro</span><b id="soProfit" class="so-profit">—</b></div></div>
        <div class="nv-field"><span>Peça do estoque (baixa 1 quando o caixa receber a OS)</span><div id="soPart"></div><div id="soModelHit" class="fs-model-hit"></div></div>
        <div class="so-grid">
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
    let part = o.part_id ? { id: o.part_id, name: o.part_name, device_model: o.part_model, stock_qty: o.part_stock, cost_cents: o.part_cost_cents } : null;
    const money = el => el.value.trim() ? parseMoney(el.value) : null;
    const profit = () => { const p = money(f.elements.price), c = money(f.elements.cost); $('soProfit').textContent = Number.isFinite(p) && Number.isFinite(c) && p != null && c != null ? H().brl(p - c) : '—'; $('soProfit').className = 'so-profit' + (p != null && c != null && p < c ? ' fs-neg' : ''); };
    f.elements.accOtherText.oninput = () => { if (f.elements.accOtherText.value.trim()) f.elements.accOther.checked = true; };
    // Preço/custo que vieram da peça escolhida pelo aparelho: mudam junto se o aparelho mudar; digitou, fica o digitado.
    let partAuto = false, priceAuto = false, costAuto = false, noAuto = false;
    f.elements.price.oninput = () => { priceAuto = false; profit(); }; f.elements.cost.oninput = () => { costAuto = false; profit(); }; profit();
    const centsTxt = c => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const drawPart = () => {
      const box = $('soPart'); if (!box) return;
      if (part) {
        box.innerHTML = `<div class="fs-picked"><span><b>${esc(part.name)}${part.device_model ? ' ' + esc(part.device_model) : ''}</b> <small>${part.cost_cents != null ? 'custo ' + H().brl(part.cost_cents) : ''}${part.stock_qty != null ? ' · estoque ' + part.stock_qty : ''}</small></span><button type="button" class="fs-link" id="soPartX">Tirar peça</button></div>`;
        $('soPartX').onclick = () => { part = null; partAuto = false; noAuto = true; drawPart(); hits(false); }; return;
      }
      box.innerHTML = `<div class="fs-sugg"><input id="soPartQ" type="search" placeholder="Buscar peça: tela a32, bateria iphone…"><div id="soPartList" class="fs-results fs-drop"></div></div>`;
      const qi = $('soPartQ'), list = $('soPartList'); let tm;
      const load = async () => {
        let rows = []; try { rows = await api('/store/products?kind=part&q=' + encodeURIComponent(qi.value.trim() || f.elements.model.value.trim())); } catch (e) { list.textContent = e.message; return; }
        if (document.activeElement !== qi) return;
        list.innerHTML = rows.slice(0, 10).map((p, n) => `<button type="button" data-n="${n}"><b>${esc(p.name)}${p.device_model ? ' ' + esc(p.device_model) : ''}</b> <small>${p.cost_cents != null ? 'custo ' + H().brl(p.cost_cents) : 'sem custo'} · estoque ${p.stock_qty ?? '—'}</small></button>`).join('') || '<p>Nenhuma peça encontrada (cadastre em Estoque → Peças).</p>';
        list.querySelectorAll('[data-n]').forEach(b => b.onmousedown = e => { e.preventDefault(); setPart(rows[b.dataset.n], false); });
      };
      qi.onfocus = load; qi.oninput = () => { clearTimeout(tm); tm = setTimeout(load, 200); }; qi.onblur = () => setTimeout(() => { if (list.isConnected) list.innerHTML = ''; }, 150);
    };
    // Peça escolhida (na busca ou pelo aparelho): custo e preço do serviço vêm dela se estiverem vazios ou automáticos.
    const setPart = (p, auto) => {
      part = p; partAuto = auto; noAuto = false;
      if (p.cost_cents != null && (!f.elements.cost.value.trim() || costAuto || !auto)) { f.elements.cost.value = centsTxt(p.cost_cents); costAuto = auto; }
      if (p.price_cents > 0 && (!f.elements.price.value.trim() || priceAuto)) { f.elements.price.value = centsTxt(p.price_cents); priceAuto = true; }
      if (!f.elements.service.value.trim()) f.elements.service.value = 'Troca de ' + p.name.toLowerCase().replace(/\s+(com|sem) aro$/, '');
      profit(); drawPart(); $('soModelHit').innerHTML = '';
    };
    const clearAuto = () => { part = null; partAuto = false; if (priceAuto) { f.elements.price.value = ''; priceAuto = false; } if (costAuto) { f.elements.cost.value = ''; costAuto = false; } profit(); drawPart(); };
    // Aparelho digitado (marca + modelo) → telas do estoque que servem. Uma só exata: já entra; várias: escolher.
    let hitSeq = 0, hitTimer;
    const hits = async apply => {
      const box = $('soModelHit'); if (!box) return;
      if (part && !partAuto) { box.innerHTML = ''; return; }
      const model = f.elements.model.value.trim(), full = (f.elements.brand.value.trim() + ' ' + model).trim();
      if (model.length < 2) { if (partAuto) clearAuto(); box.innerHTML = ''; return; }
      const seq = ++hitSeq; let rows = [];
      try { rows = await api(`/store/parts/match?model=${encodeURIComponent(full)}&service=${encodeURIComponent(f.elements.service.value.trim())}`); } catch { return; }
      if (seq !== hitSeq || !box.isConnected) return;
      const exact = rows.filter(r => r.match === 'exact');
      if (partAuto && !rows.some(r => r.id === part.id)) clearAuto();
      if (apply && !noAuto && exact.length === 1 && part?.id !== exact[0].id) { setPart(exact[0], true); return; }
      const others = rows.filter(r => r.id !== part?.id);
      box.innerHTML = others.length ? `<div class="nv-help">${part ? 'Outras peças' : 'Peça do estoque'} para <b>${esc(full)}</b>${!part && exact.length > 1 ? ' (escolha uma)' : ''}:</div><div class="fs-hit-list">${others.map((p, n) => `<button type="button" class="fs-chip" data-hit="${n}"><b>${esc(p.name)} · ${esc(p.device_model || '')}</b><small>${p.price_cents > 0 ? H().brl(p.price_cents) + ' · ' : ''}custo ${p.cost_cents != null ? H().brl(p.cost_cents) : '—'} · estoque ${p.stock_qty ?? '—'}${p.match === 'close' ? ' · parecido' : ''}</small></button>`).join('')}</div>` : '';
      box.querySelectorAll('[data-hit]').forEach(b => b.onclick = () => setPart(others[b.dataset.hit], true));
    };
    for (const k of ['model', 'brand', 'service']) f.elements[k].addEventListener('input', () => { clearTimeout(hitTimer); hitTimer = setTimeout(() => hits(true), 350); });
    drawPart(); if (isNew) hits(false);
    // Atalhos: defeitos e serviços mais usados (serviço cadastrado também preenche valor e custo, se vazios).
    (async () => {
      try { sugg = sugg || await api('/store/service-orders/suggestions'); } catch { return; }
      if (!$('soProbChips')) return;
      $('soProbChips').innerHTML = sugg.problems.map((t, i) => `<button type="button" class="fs-chip" data-p="${i}">${esc(t)}</button>`).join('');
      $('soSvcChips').innerHTML = sugg.services.map((x, i) => `<button type="button" class="fs-chip" data-s="${i}">${esc(x.name)}${x.price_cents ? `<small>${H().brl(x.price_cents)}</small>` : ''}</button>`).join('');
      f.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { const el = f.elements.problem, t = sugg.problems[b.dataset.p]; el.value = el.value.trim() && !el.value.includes(t) ? el.value.trim() + ', ' + t : t; });
      f.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { const x = sugg.services[b.dataset.s]; f.elements.service.value = x.name;
        if (x.price_cents && (!f.elements.price.value.trim() || priceAuto) && !(part && priceAuto)) { f.elements.price.value = centsTxt(x.price_cents); priceAuto = true; }
        if (x.cost_cents != null && !f.elements.cost.value.trim()) { f.elements.cost.value = centsTxt(x.cost_cents); costAuto = true; } profit(); hits(true); });
    })();
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
      for (const k of ['device_type', 'brand', 'model', 'serial', 'color', 'condition', 'problem', 'service']) body[k] = el[k].value.trim();
      const other = el.accOtherText.value.trim();
      body.accessories = [...f.querySelectorAll('[name=acc]:checked')].map(x => x.value).concat(el.accOther.checked || other ? ['Outro' + (other ? ': ' + other : '')] : []).join(', ').slice(0, 200);
      const cost = el.cost.value.trim() ? parseMoney(el.cost.value) : null;
      if (cost != null && (!Number.isFinite(cost) || cost < 0)) { out.textContent = 'Custo inválido.'; return; }
      body.cost_cents = cost; body.part_id = part?.id || null;
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
      <div class="fs-row"><label class="nv-field">Valor aprovado (R$)<input name="price" inputmode="decimal" required value="${o.price_cents ? (o.price_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''}"></label>
      <label class="nv-field">Custo (R$)<input name="cost" inputmode="decimal" value="${o.cost_cents != null ? (o.cost_cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''}"></label></div>
      ${o.part_id ? `<p class="nv-help">Peça do estoque: ${esc(o.part_name || '')} (baixa quando o caixa receber).</p>` : '<p class="nv-help">Peça do estoque: escolha em "Ver / editar".</p>'}
      <div class="fs-row"><button class="nv-button">Mandar para a fila</button><button type="button" class="nv-button secondary" data-close-dialog>Voltar</button></div><p role="status" class="fs-neg"></p></form>`);
    const f = $('soAp'); f.elements.price.focus();
    f.onsubmit = async e => {
      e.preventDefault(); const p = parseMoney(f.elements.price.value), c = f.elements.cost.value.trim() ? parseMoney(f.elements.cost.value) : null;
      if (!Number.isFinite(p) || p < 0 || (c != null && !(c >= 0))) { f.querySelector('[role=status]').textContent = 'Valor inválido.'; return; }
      try { await api(`/store/service-orders/${o.id}/status`, 'POST', { status: 'queue', price_cents: p, cost_cents: c }); $('editorDialog').close(); H().feedback(`OS ${o.number} na fila de serviços.`); refresh(box, alive); }
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
    if (kind === 'sendquote') return previewSend('Orçamento da OS ' + o.number, o.customer_phone, fill(settings.os_quote_message || DEFAULT_QUOTE, o, { valor: o.price_cents ? brl(o.price_cents) : 'a combinar' }));
    if (kind === 'done') return move('done', {}, `OS ${o.number} concluída. Avise o cliente em Concluídos.`);
    if (kind === 'reopen') return move('queue', {}, `OS ${o.number} voltou para a fila.`);
    if (kind === 'undeliver') return move('done', {}, `Entrega da OS ${o.number} desfeita.`);
    if (kind === 'deliver') {
      if (o.pay_state === 'open' && !confirm(`A OS ${o.number} ainda está em A receber (${brl(o.pending_total_cents)}). Receba no caixa. Marcar como entregue mesmo assim?`)) return;
      return move('delivered', {}, `OS ${o.number} entregue. A garantia conta a partir de hoje.`);
    }
    if (kind === 'notify') {
      const valor = o.pay_state === 'open' ? `Valor: ${brl(o.pending_total_cents)}. ` : '';
      return previewSend('Avisar cliente · OS ' + o.number, o.customer_phone, fill(o.repaired ? (settings.os_ready_message || DEFAULT_READY) : DEFAULT_RETURN, o, { valor }),
        () => api(`/store/service-orders/${o.id}/notified`, 'POST').then(() => refresh(box, alive)).catch(() => {}));
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
      return warrantyDialog({ source: 'sale_item', source_id: row.item_id, customer_name: row.customer_name, customer_phone: row.customer_phone, device: row.pet || '', service: String(row.service || '').replace(/^OS \d+ · /, ''), price_cents: row.total_cents, days: row.warranty_days ?? settings.os_warranty_days, from: day });
    } catch (e) { H().feedback(e.message, true); }
  }

  const css = `.so-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}.so-head h2{margin:0}.so-bar{margin-bottom:14px}.so-tabs{margin-bottom:10px}
  .so-count{display:inline-block;min-width:20px;padding:0 6px;border-radius:999px;background:var(--nv-blue-soft,#e8f0fe);color:var(--nv-blue,#2563eb);font-size:12px;font-weight:700;text-align:center}
  .so-card{border:1px solid var(--nv-border);border-radius:12px;padding:10px 12px;margin:8px 0;display:grid;gap:4px;font-size:14px}.so-card small{color:var(--nv-muted)}
  .so-card.so-stuck{border-left:4px solid #f59e0b}.so-card.so-late{border-left:4px solid #b42318}.so-top{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.so-num{font-size:15px}.so-price{margin-left:auto;font-weight:700}
  .so-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.so-due{background:#fff1cc!important;color:#7a4b00!important}.so-red{background:#fdecea!important;color:#b42318!important}
  .so-acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px}.so-when{margin-left:auto}.so-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 12px}.so-span2{grid-column:span 2}
  .so-form .nv-form-panel{margin-bottom:12px}.so-acc{border:1px solid var(--nv-border);border-radius:12px;padding:8px 12px;margin:8px 0;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}.so-acc legend{font-size:13px;font-weight:600;padding:0 4px}.so-acc label{display:flex;align-items:center;gap:6px;font-size:14px}.so-acc input[type=checkbox]{width:18px;height:18px}.so-acc input[name=accOtherText]{flex:1 1 140px;min-width:120px;padding:6px 10px;border:1px solid var(--nv-border);border-radius:8px;font:inherit}
  .so-chips-q{margin:-4px 0 10px}.so-chips-q .fs-chip{min-height:34px;padding:5px 10px;font-size:13px}.so-profit{display:block;padding:12px 0;font-size:16px}
  .so-msg{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--nv-border);border-radius:10px;font:14px/1.45 inherit;font-family:inherit;margin:6px 0 10px;resize:vertical}
  .so-wgrid{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:18px;align-items:start}.so-prev{width:100%;height:560px;border:1px solid var(--nv-border);border-radius:10px;background:#fff;margin-top:4px}.so-h3{font-size:15px;margin:16px 0 0}
  @media(max-width:760px){.so-wgrid{grid-template-columns:1fr}.so-prev{height:420px}}.so-form .nv-field input,.so-form .nv-field select{width:100%}.fs-day-row .fs-link{padding:0 4px;font-size:12px}
  @media(max-width:700px){.so-grid{grid-template-columns:1fr 1fr}.so-span2{grid-column:1/-1}.so-when{margin-left:0;width:100%}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.append(st);
  window.FPServiceOrders = { mount, warrantyFromDay, printWarranty, warrantyDialog, enabled: () => window.FPSales?.h?.config()?.niche === 'electronics' };
})();
