// Histórico do cliente com a loja: o que comprou, quanto gastou, como pagou, serviços (aparelho, peça, garantia)
// e pedidos. Abre ao clicar no nome ou na foto do cliente em qualquer parte do painel ([data-customer-history]).
(() => {
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const dt = d => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dmy = d => d ? new Date(d + (String(d).length === 10 ? 'T12:00:00' : '')).toLocaleDateString('pt-BR') : '';
  const METHODS = { cash: 'Dinheiro', pix: 'Pix', debit: 'Débito', credit: 'Crédito', other: 'Outro' };
  const STATUS = { queued: 'Na fila', live: 'Em atendimento', paused: 'Pausado', completed: 'Finalizado' };
  const DETAIL = { brand: 'Marca', model: 'Modelo', device: 'Aparelho', service: 'Serviço', notes: 'Observações', plate: 'Placa', color: 'Cor', pet: 'Pet', breed: 'Raça', size: 'Porte', imei: 'IMEI', defect: 'Defeito' };
  const icon = n => (window.FPIcon ? window.FPIcon(n) : '');
  const phoneLink = p => { const d = String(p || '').replace(/\D/g, ''); return d ? `https://wa.me/${d.startsWith('55') ? '' : '55'}${d}` : ''; };

  async function api(path) {
    const r = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('nv_token') }, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(data.error || 'Não foi possível abrir o histórico');
    return data;
  }

  function saleCard(x, today) {
    const items = x.items.map(i => {
      const w = i.warranty_until ? (i.warranty_until >= today ? `<span class="ch-ok">garantia até ${dmy(i.warranty_until)}</span>` : `<span class="ch-muted">garantia venceu em ${dmy(i.warranty_until)}</span>`) : '';
      const extra = [i.device_model && i.service ? 'aparelho: ' + esc(i.device_model) : '', i.supplier_name ? 'fornecedor: ' + esc(i.supplier_name) : '', i.unit_cost_cents != null && i.service ? 'custo ' + brl(i.unit_cost_cents) : '', w].filter(Boolean).join(' · ');
      return `<li>${i.service ? icon('wrench') : i.gift ? icon('gift') : ''}<b>${i.quantity > 1 ? i.quantity + 'x ' : ''}${esc(i.name)}${i.variant ? ' ' + esc(i.variant) : ''}</b>${i.gift ? ' <small>(brinde)</small>' : ''} <span class="ch-right">${i.gift ? 'brinde' : brl(i.total_cents)}</span>${extra ? `<br><small>${extra}</small>` : ''}</li>`;
    }).join('');
    return `<article class="ch-card${x.canceled_at ? ' ch-canceled' : ''}" data-text="${esc([x.description, ...x.items.map(i => [i.name, i.variant, i.device_model].join(' '))].join(' ').toLowerCase())}">
      <div class="ch-top"><div><b>${x.items.some(i => i.service) ? 'Serviço' : 'Compra'} #${x.sale_number}</b> · ${dt(x.created_at)}${x.order_number ? ` · pedido ${esc(x.order_number)}` : ''}</div><b>${brl(x.total_cents)}</b></div>
      <small>${Array.isArray(x.payments) && x.payments.length ? x.payments.map(p => `${METHODS[p.method] || p.method} ${brl(p.amount_cents)}`).join(' + ') : METHODS[x.payment_method] || x.payment_method}${x.discount_cents ? ' · desconto ' + brl(x.discount_cents) : ''}${x.cashback_used_cents ? ' · cashback usado ' + brl(x.cashback_used_cents) : ''}${x.seller_name ? ' · atendido por ' + esc(x.seller_name) : ''}${x.canceled_at ? ` · <span class="ch-neg">cancelada: ${esc(x.cancel_reason || '')}</span>` : ''}</small>
      ${items ? `<ul class="ch-items">${items}</ul>` : x.description ? `<p class="ch-desc">${esc(x.description)}</p>` : ''}
      ${items && x.description ? `<p class="ch-desc">${esc(x.description)}</p>` : ''}</article>`;
  }
  function orderCard(o) {
    const det = Object.entries(o.details || {}).filter(([, v]) => String(v || '').trim()).map(([k, v]) => `${esc(DETAIL[k] || k)}: <b>${esc(v)}</b>`).join(' · ');
    return `<article class="ch-card" data-text="${esc([o.process, ...Object.values(o.details || {})].join(' ').toLowerCase())}">
      <div class="ch-top"><div><b>Pedido ${esc(o.order_number || '')}</b> · ${dt(o.created_at)}</div><span class="nv-pill">${STATUS[o.status] || o.status}</span></div>
      <small>${esc(o.process || '')}${o.completed_at ? ' · concluído em ' + dt(o.completed_at) : ''}</small>${det ? `<p class="ch-desc">${det}</p>` : ''}</article>`;
  }

  async function open(id) {
    // Janela própria, por cima de qualquer outra (não apaga uma venda ou formulário aberto embaixo).
    let d = $('chDialog');
    if (!d) { d = document.createElement('dialog'); d.id = 'chDialog'; d.className = 'nv-dialog'; d.setAttribute('aria-labelledby', 'chTitle'); document.body.appendChild(d); d.addEventListener('click', e => { if (e.target.closest('[data-ch-close]')) d.close(); }); }
    d.innerHTML = '<p class="nv-help">Carregando histórico…</p>'; if (!d.open) d.showModal();
    let h; try { h = await api(`/store/customers/${id}/history`); } catch (e) { d.innerHTML = `<div class="nv-heading"><h2>Histórico</h2><button type="button" class="nv-button secondary" data-ch-close aria-label="Fechar">${icon('x')}</button></div><p class="ch-neg">${esc(e.message)}</p>`; return; }
    const c = h.customer, t = h.totals;
    const timeline = [...h.sales.map(x => ({ at: x.created_at, html: saleCard(x, h.today) })), ...h.orders.map(o => ({ at: o.created_at, html: orderCard(o) }))].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const wa = phoneLink(c.phone);
    d.innerHTML = `<div class="nv-heading"><h2 id="chTitle">${esc(c.name)}</h2><button type="button" class="nv-button secondary" data-ch-close aria-label="Fechar">${icon('x')}</button></div>
      <p class="nv-help">${c.phone ? (wa ? `<a href="${wa}" target="_blank" rel="noopener">${esc(c.phone)}</a>` : esc(c.phone)) : 'sem telefone'}${c.email ? ' · ' + esc(c.email) : ''}${c.address ? ' · ' + esc(c.address) : ''} · cliente desde ${dmy(String(t.first_at || c.created_at).slice(0, 10))}</p>
      <div class="ch-kpis"><div><small>Total gasto</small><b>${brl(t.spent_cents)}</b></div><div><small>Compras</small><b>${t.sales}</b></div><div><small>Serviços</small><b>${t.services}</b></div><div><small>Pedidos</small><b>${t.orders}</b></div><div><small>Última vez</small><b>${t.last_at ? dmy(String(t.last_at).slice(0, 10)) : '—'}</b></div></div>
      ${Object.keys(t.by_method).length ? `<p class="ch-pills">${Object.entries(t.by_method).map(([k, v]) => `<span class="fs-pill">${METHODS[k] || k} <b>${brl(v.total_cents)}</b> <small>(${v.count})</small></span>`).join('')}</p>` : ''}
      ${(h.pets || []).length ? `<div class="ch-pets"><b>Pets</b><ul>${h.pets.map(p => `<li><b>${esc(p.name)}</b>${[p.species, p.breed, p.size ? 'porte ' + p.size : '', p.sex === 'F' ? 'fêmea' : p.sex === 'M' ? 'macho' : '', p.birth_date ? 'nasc. ' + dmy(String(p.birth_date).slice(0, 10)) : '', p.weight_kg ? String(p.weight_kg).replace('.', ',') + ' kg' : '', p.color, p.neutered ? 'castrado' : ''].filter(Boolean).map(x => ' · ' + esc(x)).join('')}${p.notes ? `<br><small>${esc(p.notes)}</small>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${h.loyalty?.enabled ? `<p class="nv-help">${icon('gift')} Fidelidade: ${h.loyalty.checkins} de ${h.loyalty.target}${h.loyalty.complete ? ' · <b>prêmio liberado</b>' : ''}</p>` : ''}
      ${h.cashback?.balance_cents ? `<p class="nv-help">Cashback: <b>${brl(h.cashback.balance_cents)}</b>${h.cashback.next_expires_on ? ` (vence ${dmy(h.cashback.next_expires_on)})` : ''}</p>` : ''}
      ${h.warranties.length ? `<div class="ch-warr"><b>Garantias valendo</b><ul>${h.warranties.map(w => `<li>${esc(w.name)}${w.device_model ? ' · ' + esc(w.device_model) : ''} — até <b>${dmy(w.until)}</b> (venda #${w.sale_number})</li>`).join('')}</ul></div>` : ''}
      <input type="search" id="chSearch" class="ch-search" placeholder="Procurar no histórico: ${FP.ex('hist')}…" aria-label="Procurar no histórico">
      <div id="chList">${timeline.map(x => x.html).join('') || '<p class="nv-help">Nada registrado ainda para este cliente.</p>'}</div>`;
    $('chSearch').oninput = e => { const t = e.target.value.trim().toLowerCase(); $('chList').querySelectorAll('.ch-card').forEach(el => { el.hidden = !!t && !el.dataset.text.includes(t); }); };
  }

  const css = document.createElement('style');
  css.textContent = `.fp-cust-link{cursor:pointer;border-radius:4px}.fp-cust-link:hover,.fp-cust-link:focus-visible{text-decoration:underline;color:var(--nv-primary,#f25c1f);outline:none}.fp-cust-avatar{cursor:pointer}.fp-cust-avatar:hover{outline:2px solid var(--nv-primary,#f25c1f);outline-offset:1px}
  .fp-linkbtn{all:unset;cursor:pointer;color:inherit;font:inherit}.fp-linkbtn:hover,.fp-linkbtn:focus-visible{text-decoration:underline;color:var(--nv-primary,#f25c1f)}
  .ch-kpis{display:flex;flex-wrap:wrap;gap:18px;margin:10px 0}.ch-kpis div{display:flex;flex-direction:column}.ch-kpis small{color:var(--nv-muted)}.ch-kpis b{font-size:20px}
  .ch-pills{display:flex;flex-wrap:wrap;gap:6px}.ch-warr{background:#ecfdf3;border:1px solid #abefc6;border-radius:12px;padding:8px 12px;margin:8px 0;font-size:14px}.ch-warr ul{margin:4px 0 0;padding-left:18px}
  .ch-search{width:100%;margin:10px 0;padding:10px 12px;border:1px solid var(--nv-border,#e5e7eb);border-radius:10px;font:inherit}
  .ch-card{border:1px solid var(--nv-border,#e5e7eb);border-radius:12px;padding:10px 12px;margin-bottom:8px}.ch-card small{color:var(--nv-muted)}.ch-canceled{opacity:.6}
  .ch-top{display:flex;justify-content:space-between;gap:10px;align-items:baseline}.ch-items{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:4px;font-size:14px}.ch-items li{display:block}.ch-items .fp-ic{width:14px;height:14px;vertical-align:-2px;margin-right:4px}
  .ch-right{float:right}.ch-desc{margin:6px 0 0;font-size:14px}.ch-pets{border:1px solid var(--nv-border,#e5e7eb);border-radius:12px;padding:8px 12px;margin:8px 0;font-size:14px}.ch-pets ul{margin:4px 0 0;padding-left:18px}.ch-ok{color:#027a48}.ch-neg{color:#b42318}.ch-muted{color:var(--nv-muted)}`;
  document.head.appendChild(css);
  window.FPCustomerHistory = { open };
  // Qualquer nome/foto marcado com data-customer-history abre o histórico (clique ou Enter/Espaço).
  const trigger = e => { const el = e.target.closest?.('[data-customer-history]'); if (!el || el.matches('button[data-history-customer]')) return false; e.preventDefault(); e.stopPropagation(); open(el.dataset.customerHistory); return true; };
  document.addEventListener('click', trigger, true);
  document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-customer-history]')) trigger(e); });
})();
