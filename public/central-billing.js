// Central: "Cobranças" pelo Asaas — quem paga (loja avulsa ou rede), mensalidade, implantação parcelada,
// cobranças avulsas, situação de cada uma, carência e bloqueio automático.
// Usa os utilitários globais do app.js: api, el, safe, msg, render.
(() => {
  let selected = null;
  const brl = c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const dmy = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—';
  const dt = d => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'nunca';
  const toCents = s => { s = String(s || '').trim().replace(/[R$\s]/g, ''); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = Number(s); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
  const money = c => (c / 100).toFixed(2).replace('.', ',');
  const addMonths = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate(); const x = new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))); return x.toISOString().slice(0, 10); };
  const fmtDoc = d => !d ? '' : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  const STATUS = { PENDING: ['Aguardando', 'muted'], OVERDUE: ['Vencida', 'bad'], RECEIVED: ['Paga', 'ok'], CONFIRMED: ['Paga (confirmada)', 'ok'], RECEIVED_IN_CASH: ['Paga por fora', 'ok'], REFUNDED: ['Estornada', 'warn'], REFUND_REQUESTED: ['Estorno pedido', 'warn'], CHARGEBACK_REQUESTED: ['Contestação', 'bad'], CHARGEBACK_DISPUTE: ['Contestação', 'bad'], AWAITING_RISK_ANALYSIS: ['Em análise', 'warn'] };
  const chip = (t, k) => '<span class="ct-chip ' + k + '">' + safe(t) + '</span>';
  const statusChip = (c, today) => c.deleted ? chip('Cancelada', 'muted') : (c.status === 'PENDING' && String(c.due_date).slice(0, 10) < today) ? chip('Vencida', 'bad') : chip(...(STATUS[c.status] || [c.status, 'muted']));
  const MODE = { charge: ['Cobrar', 'ok'], exempt: ['Isenta', 'muted'], paused: ['Pausada', 'warn'] };
  const KIND = { setup: 'Implantação', monthly: 'Mensalidade', other: 'Avulsa' };

  function situation(a, today) {
    if (!a.account_id) return chip('Sem cadastro', 'muted');
    if (a.mode === 'exempt') return chip('Isenta', 'muted');
    if (a.blocked_at) return chip('Bloqueada', 'bad');
    if (a.block_override_until && String(a.block_override_until).slice(0, 10) >= today) return chip('Liberada até ' + dmy(a.block_override_until), 'warn');
    if (a.overdue_count) return chip(a.overdue_count + ' vencida(s) · ' + brl(a.overdue_cents), 'warn');
    return a.next_open || a.subscription ? chip('Em dia', 'ok') : chip('Sem cobrança', 'muted');
  }

  async function listPage() {
    const d = await api('/master/billing');
    const blocked = d.accounts.filter(a => a.blocked_at).length, late = d.accounts.filter(a => a.overdue_count && !a.blocked_at).length;
    let h = '<section><div class="ct-card-head"><h2>Asaas</h2><div><button type="button" class="ct-btn ghost" id="blSync">Sincronizar agora</button></div></div>'
      + (d.configured ? '<p>Ligado em <b>' + (d.environment === 'sandbox' ? 'sandbox (teste)' : 'produção') + '</b>. Última conferência: ' + dt(d.last_sync_at) + (d.last_sync_error ? ' · <span style="color:#B91C1C">' + safe(d.last_sync_error) + '</span>' : '') + '. Confere sozinho a cada 30 min no expediente.</p>'
        + '<p id="blHook" class="ct-muted">Conferindo o aviso automático (webhook)…</p>'
        : '<p><b>Ainda não ligado.</b> No Render, em Environment, crie <code>ASAAS_API_KEY</code> com a chave da API do Asaas (Minha conta → Integrações → Chave de API; começa com <code>$aact_prod_</code>). O servidor reinicia sozinho; depois volte aqui e clique em “Configurar aviso automático”.</p>')
      + '</section>';
    h += '<section><div class="ct-kpis">'
      + '<div class="ct-kpi"><span>Recebido no mês</span><strong>' + brl(d.month.received_cents) + '</strong></div>'
      + '<div class="ct-kpi"><span>Em aberto até o fim do mês</span><strong>' + brl(d.month.open_cents) + '</strong></div>'
      + '<div class="ct-kpi"><span>Em atraso (na carência)</span><strong>' + late + '</strong></div>'
      + '<div class="ct-kpi"><span>Bloqueadas por falta de pagamento</span><strong>' + blocked + '</strong>' + (blocked ? '<em class="bad">sem acesso ao painel</em>' : '') + '</div></div></section>';
    h += '<section><h2>Quem paga</h2><p class="ct-muted">Unidades de rede pagam pela rede. Loja sem cadastro não é cobrada nem bloqueada.</p><div style="overflow:auto"><table><thead><tr><th>Cliente</th><th>Cobrança</th><th>Mensalidade</th><th>Próximo vencimento</th><th>Situação</th><th></th></tr></thead><tbody>'
      + d.accounts.map(a => '<tr><td><b>' + safe(a.name) + '</b><br><small class="ct-muted">' + (a.network_id ? 'Rede · ' + a.units + ' unidade(s)' : 'Loja · ' + safe(a.slug)) + (a.cpf_cnpj ? ' · ' + fmtDoc(a.cpf_cnpj) : '') + '</small></td>'
        + '<td>' + (a.account_id ? chip(...MODE[a.mode]) + (a.mode === 'charge' && a.auto_block ? '<br><small class="ct-muted">bloqueia após ' + a.grace_days + ' dia(s)</small>' : '') : '—') + '</td>'
        + '<td>' + (a.subscription ? brl(a.subscription.value_cents) : '—') + '</td>'
        + '<td>' + (a.next_open ? dmy(a.next_open.due_date) + '<br><small class="ct-muted">' + brl(a.next_open.value_cents) + ' · ' + safe(a.next_open.description) + '</small>' : '—') + '</td>'
        + '<td>' + situation(a, d.today) + (a.last_error ? '<br><small style="color:#B91C1C">' + safe(a.last_error) + '</small>' : '') + '</td>'
        + '<td><button type="button" class="ct-btn ghost blOpen" style="height:34px" data-account="' + safe(a.account_id || '') + '" data-tenant="' + safe(a.tenant_id || '') + '" data-network="' + safe(a.network_id || '') + '" data-name="' + safe(a.name) + '">' + (a.account_id ? 'Abrir' : 'Configurar') + '</button></td></tr>').join('')
      + '</tbody></table></div></section>';
    render(h);
    el('blSync').onclick = async () => { el('blSync').disabled = true; try { const r = await api('/master/billing/sync', 'POST'); msg(r.error ? 'Conferido com erro: ' + r.error : 'Conferido com o Asaas.' + (r.changes.length ? ' Mudanças: ' + r.changes.map(c => c.action === 'blocked' ? 'bloqueio' : 'liberação').join(', ') + '.' : '')); await listPage(); } catch (e) { msg(e.message); el('blSync').disabled = false; } };
    document.querySelectorAll('.blOpen').forEach(b => b.onclick = () => { selected = { account: b.dataset.account || null, tenant_id: b.dataset.tenant || null, network_id: b.dataset.network || null, name: b.dataset.name }; load().catch(e => msg(e.message)); });
    if (d.configured) hookStatus().catch(e => { el('blHook').innerHTML = 'Aviso automático: ' + safe(e.message); });
  }

  async function hookStatus() {
    const w = await api('/master/billing/webhook'), box = el('blHook'); if (!box) return;
    box.innerHTML = (w.exists ? (w.interrupted ? chip('Aviso automático pausado no Asaas', 'bad') + ' Os avisos param até reativar. ' : w.enabled ? chip('Aviso automático ligado', 'ok') + ' ' : chip('Aviso automático desligado', 'warn') + ' ') : chip('Aviso automático não configurado', 'warn') + ' Sem ele, pagamentos só aparecem na conferência a cada 30 min. ')
      + '<button type="button" class="ct-btn ghost" id="blHookBtn" style="height:34px">' + (w.exists ? 'Reconfigurar / reativar' : 'Configurar aviso automático') + '</button>';
    el('blHookBtn').onclick = async () => { el('blHookBtn').disabled = true; try { await api('/master/billing/webhook', 'POST'); msg('Aviso automático configurado no Asaas.'); await hookStatus(); } catch (e) { msg(e.message); el('blHookBtn').disabled = false; } };
  }

  async function load() {
    if (!selected) return listPage();
    let data = null;
    if (selected.account) data = await api('/master/billing/accounts/' + selected.account);
    const a = data?.account || { name: selected.name, mode: 'charge', grace_days: 5, auto_block: true, billing_type: 'UNDEFINED', notes: '' };
    const today = data?.today || new Date().toISOString().slice(0, 10);
    const active = data?.subscriptions.find(s => s.status === 'active');
    let h = '<p><button type="button" class="ct-btn ghost" id="blBack" style="height:34px">← Todas</button></p>';
    if (a.blocked_at) h += '<section style="border:2px solid #FCA5A5"><h2>Bloqueada por falta de pagamento</h2><p>Desde ' + dt(a.blocked_at) + '. ' + (selected.network_id ? 'A rede e todas as unidades estão' : 'A loja está') + ' sem acesso ao painel, link do cliente e vídeo. Libera sozinho quando o Asaas confirmar o pagamento. Para liberar antes, use “Liberar até” abaixo.</p></section>';
    h += '<section><h2>' + safe(selected.name) + ' — quem paga</h2><div class="ct-form" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">'
      + '<label>Cobrança<select id="bMode"><option value="charge">Cobrar</option><option value="exempt">Isenta (nunca cobrar nem bloquear)</option><option value="paused">Pausada (guarda o cadastro)</option></select></label>'
      + '<label>Nome ou razão social<input id="bName" maxlength="120" value="' + safe(a.name) + '"></label>'
      + '<label>CPF ou CNPJ<input id="bDoc" inputmode="numeric" value="' + safe(fmtDoc(a.cpf_cnpj)) + '"></label>'
      + '<label>E-mail (o Asaas manda a cobrança)<input id="bEmail" type="email" value="' + safe(a.email || '') + '"></label>'
      + '<label>Celular com DDD<input id="bPhone" inputmode="tel" value="' + safe(a.phone || '') + '"></label>'
      + '<label>Forma de pagamento<select id="bType"><option value="UNDEFINED">Cliente escolhe (Pix, boleto ou cartão)</option><option value="PIX">Só Pix</option><option value="BOLETO">Boleto (com Pix)</option></select></label>'
      + '<label>Dias de carência depois do vencimento<input id="bGrace" type="number" min="0" max="60" value="' + a.grace_days + '"></label>'
      + '<label style="display:flex;gap:8px;align-items:center"><input id="bAuto" type="checkbox"' + (a.auto_block ? ' checked' : '') + '> Bloquear sozinho depois da carência</label>'
      + (selected.network_id ? '<label>Valor por unidade/mês (R$)<input id="bUnit" inputmode="decimal" placeholder="250,00" value="' + (a.unit_price_cents ? money(a.unit_price_cents) : '') + '"></label><label>Dia do vencimento<input id="bDay" type="number" min="1" max="28" value="' + (a.due_day || 20) + '"></label>' : '')
      + '<label>Liberar até (não bloqueia até essa data)<input id="bOverride" type="date" value="' + safe(a.block_override_until ? String(a.block_override_until).slice(0, 10) : '') + '"></label>'
      + '</div><label>Observações<textarea id="bNotes" maxlength="2000" rows="2">' + safe(a.notes || '') + '</textarea></label>'
      + '<p><button type="button" class="ct-btn" id="bSave">Salvar</button> ' + (a.asaas_customer_id ? '<small class="ct-muted">Cliente no Asaas: ' + safe(a.asaas_customer_id) + '</small>' : '') + '</p></section>';
    const perUnit = !!(selected.network_id && a.unit_price_cents);
    if (data && perUnit) {
      const on = data.units.filter(u => u.billing_since);
      h += '<section><h2>Mensalidade por unidade</h2><p>' + brl(a.unit_price_cents) + ' por unidade liberada · vence todo dia ' + (a.due_day || 20) + '. Hoje: <b>' + on.length + ' de ' + data.units.length + '</b> unidade(s) = <b>' + brl(on.length * a.unit_price_cents) + '/mês</b>.</p>'
        + '<p class="ct-muted">Liberar cobra o mês cheio já no próximo vencimento em aberto. Parar tira a unidade das próximas cobranças.</p>'
        + '<table><thead><tr><th>Unidade</th><th>Cobrança</th><th></th></tr></thead><tbody>'
        + data.units.map(u => '<tr><td>' + safe(u.unit_label || u.name) + '</td><td>' + (u.billing_since ? chip('Liberada desde ' + dmy(u.billing_since), 'ok') : chip('Não cobra', 'muted')) + '</td><td><button type="button" class="ct-btn ' + (u.billing_since ? 'ghost' : '') + ' uBill" style="height:32px" data-id="' + safe(u.id) + '" data-on="' + (u.billing_since ? '0' : '1') + '" data-name="' + safe(u.unit_label || u.name) + '">' + (u.billing_since ? 'Parar de cobrar' : 'Liberar cobrança') + '</button></td></tr>').join('')
        + '</tbody></table></section>';
    } else if (data?.units?.length > 1) h += '<section><h2>Unidades cobertas</h2><p>' + data.units.map(u => safe(u.unit_label || u.name) + ' ' + chip(u.status === 'suspended' ? 'suspensa' : u.status === 'trial' ? 'teste' : 'ativa', u.status === 'suspended' ? 'bad' : 'ok')).join(' · ') + '</p>' + (selected.network_id ? '<p class="ct-muted">Para cobrar por unidade, preencha “Valor por unidade/mês” acima e salve.</p>' : '') + '</section>';
    if (data && a.mode === 'charge') {
      if (perUnit) h += '<section><h2>Mensalidade</h2>' + (active ? '<p><b>' + brl(active.value_cents) + '</b> por mês · ' + safe(active.description) + '</p><p class="ct-muted">O valor muda sozinho quando você libera ou para uma unidade.</p>' : '<p class="ct-muted">Nenhuma unidade liberada: ainda não há mensalidade no Asaas.</p>') + '</section>';
      else h += '<section><h2>Mensalidade</h2>' + (active
        ? '<p><b>' + brl(active.value_cents) + '</b> por mês · ' + safe(active.description) + ' · desde ' + dmy(active.first_due_date) + (active.end_date ? ' até ' + dmy(active.end_date) : '') + '</p><p class="ct-muted">O Asaas gera a cobrança de cada mês e manda ao cliente. Para mudar o valor, cancele e crie outra.</p><button type="button" class="ct-btn ghost" id="sCancel" data-id="' + safe(active.id) + '">Cancelar mensalidade</button>'
        : '<div class="ct-form" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px"><label>Descrição<input id="sDesc" value="Mensalidade Ficou Pronto"></label><label>Valor por mês (R$)<input id="sValue" inputmode="decimal" placeholder="1.750,00"></label><label>Primeiro vencimento<input id="sFirst" type="date"></label><label>Término (opcional)<input id="sEnd" type="date"></label></div><p><button type="button" class="ct-btn" id="sCreate">Criar mensalidade no Asaas</button></p>')
        + '</section>';
      h += '<section><h2>Nova cobrança (implantação ou avulsa)</h2><div class="ct-form" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">'
        + '<label>Tipo<select id="cKind"><option value="setup">Implantação</option><option value="other">Avulsa</option></select></label>'
        + '<label>Descrição<input id="cDesc" value="Implantação Ficou Pronto"></label>'
        + '<label>Valor total (R$)<input id="cTotal" inputmode="decimal" placeholder="2.500,00"></label>'
        + '<label>Parcelas<input id="cN" type="number" min="1" max="24" value="1"></label>'
        + '<label>1º vencimento<input id="cFirst" type="date" value="' + today + '"></label>'
        + '</div><p><button type="button" class="ct-btn ghost" id="cSplit">Montar parcelas</button></p><div id="cRows"></div></section>';
      h += '<section><h2>Cobranças</h2>' + (data.charges.length ? '<div style="overflow:auto"><table><thead><tr><th>Descrição</th><th>Valor</th><th>Vencimento</th><th>Situação</th><th>Pago em</th><th></th></tr></thead><tbody>'
        + data.charges.map(c => '<tr' + (c.deleted ? ' style="opacity:.55"' : '') + '><td>' + safe(c.description || KIND[c.kind]) + '<br><small class="ct-muted">' + KIND[c.kind] + '</small></td><td>' + brl(c.value_cents) + '</td><td>' + dmy(c.due_date) + '</td><td>' + statusChip(c, today) + '</td><td>' + dmy(c.paid_at) + '</td><td style="white-space:nowrap">'
          + (c.invoice_url && !c.deleted ? '<a class="ct-link" href="' + safe(c.invoice_url) + '" target="_blank" rel="noopener">Abrir</a> <button type="button" class="ct-btn ghost cCopy" style="height:30px" data-url="' + safe(c.invoice_url) + '">Copiar link</button> ' : '')
          + (!c.deleted && ['PENDING', 'OVERDUE'].includes(c.status) ? '<button type="button" class="ct-btn ghost cCash" style="height:30px" data-id="' + safe(c.id) + '" data-value="' + c.value_cents + '">Recebi por fora</button> <button type="button" class="ct-btn ghost cDel" style="height:30px" data-id="' + safe(c.id) + '">Cancelar</button>' : '')
          + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="ct-muted">Nenhuma cobrança ainda.</p>') + '</section>';
    }
    render(h);
    el('blBack').onclick = () => { selected = null; load().catch(e => msg(e.message)); };
    el('bMode').value = a.mode; el('bType').value = a.billing_type;
    el('bSave').onclick = async () => {
      el('bSave').disabled = true;
      try {
        const r = await api('/master/billing/accounts', 'PUT', { ...(selected.network_id ? { network_id: selected.network_id } : { tenant_id: selected.tenant_id }), mode: el('bMode').value, name: el('bName').value.trim(), cpf_cnpj: el('bDoc').value, email: el('bEmail').value.trim(), phone: el('bPhone').value, billing_type: el('bType').value, grace_days: Number(el('bGrace').value), auto_block: el('bAuto').checked, block_override_until: el('bOverride').value || null, notes: el('bNotes').value, ...(selected.network_id ? { unit_price_cents: el('bUnit').value.trim() ? toCents(el('bUnit').value) : null, due_day: Number(el('bDay').value) || 20 } : {}) });
        selected.account = r.account.id; await load(); msg(r.warning || 'Cadastro salvo.');
      } catch (e) { msg(e.message); el('bSave').disabled = false; }
    };
    document.querySelectorAll('.uBill').forEach(b => b.onclick = async () => {
      const on = b.dataset.on === '1';
      if (!confirm(on ? 'Liberar a cobrança de ' + b.dataset.name + '? Entra o mês cheio (' + brl(a.unit_price_cents) + ') já na próxima cobrança.' : 'Parar de cobrar ' + b.dataset.name + '? Sai das próximas cobranças em aberto.')) return;
      b.disabled = true;
      try { const r = await api('/master/billing/accounts/' + a.id + '/units/' + b.dataset.id, 'POST', { active: on }); await load(); msg(r.warning || (on ? 'Unidade liberada.' : 'Unidade fora da cobrança.') + (r.value_cents !== undefined ? ' Mensalidade agora: ' + brl(r.value_cents) + '.' : '')); }
      catch (e) { msg(e.message); await load().catch(() => {}); }
    });
    if (!data || a.mode !== 'charge') return;
    if (el('sCancel')) el('sCancel').onclick = async () => { if (!confirm('Cancelar a mensalidade? O Asaas apaga as cobranças futuras ainda não pagas dela.')) return; try { await api('/master/billing/subscriptions/' + el('sCancel').dataset.id, 'DELETE'); msg('Mensalidade cancelada.'); await load(); } catch (e) { msg(e.message); } };
    if (el('sCreate')) el('sCreate').onclick = async () => {
      const value = toCents(el('sValue').value); if (!(value >= 500)) return msg('Informe o valor da mensalidade.'); if (!el('sFirst').value) return msg('Informe o primeiro vencimento.');
      if (!confirm('Criar mensalidade de ' + brl(value) + ' com primeiro vencimento em ' + dmy(el('sFirst').value) + '? O Asaas passa a cobrar todo mês.')) return;
      el('sCreate').disabled = true;
      try { await api('/master/billing/accounts/' + a.id + '/subscriptions', 'POST', { description: el('sDesc').value.trim(), value_cents: value, first_due_date: el('sFirst').value, end_date: el('sEnd').value || '' }); msg('Mensalidade criada no Asaas.'); await load(); } catch (e) { msg(e.message); el('sCreate').disabled = false; }
    };
    el('cSplit').onclick = () => {
      const total = toCents(el('cTotal').value), n = Math.max(1, Math.min(24, Number(el('cN').value) || 1)), first = el('cFirst').value;
      if (!(total >= 500)) return msg('Informe o valor total.'); if (!first) return msg('Informe o 1º vencimento.');
      const base = Math.floor(total / n), rest = total - base * n;
      const rows = Array.from({ length: n }, (_, i) => ({ v: base + (i === 0 ? rest : 0), d: addMonths(first, i) }));
      el('cRows').innerHTML = '<p class="ct-muted">Ajuste valor e data de cada parcela se precisar (ex.: 1ª na assinatura, as outras dia 20).</p><table><thead><tr><th>Parcela</th><th>Valor (R$)</th><th>Vencimento</th></tr></thead><tbody>'
        + rows.map((r, i) => '<tr><td>' + (i + 1) + '/' + n + '</td><td><input class="cV" inputmode="decimal" value="' + money(r.v) + '" style="width:120px"></td><td><input class="cD" type="date" value="' + r.d + '"></td></tr>').join('')
        + '</tbody></table><p id="cSum"></p><p><button type="button" class="ct-btn" id="cCreate">Criar ' + (n > 1 ? n + ' cobranças' : 'cobrança') + ' no Asaas</button></p>';
      const sum = () => { const s = [...document.querySelectorAll('.cV')].reduce((t, x) => t + (toCents(x.value) || 0), 0); el('cSum').innerHTML = 'Soma: <b>' + brl(s) + '</b>' + (s !== total ? ' <span style="color:#B45309">(total informado: ' + brl(total) + ')</span>' : ''); };
      document.querySelectorAll('.cV').forEach(x => x.oninput = sum); sum();
      el('cCreate').onclick = async () => {
        const inst = [...document.querySelectorAll('#cRows tbody tr')].map(tr => ({ value_cents: toCents(tr.querySelector('.cV').value), due_date: tr.querySelector('.cD').value }));
        if (inst.some(i => !(i.value_cents >= 500) || !i.due_date)) return msg('Confira valor (mínimo R$ 5,00) e vencimento de cada parcela.');
        if (!confirm('Criar ' + inst.length + ' cobrança(s) no Asaas para ' + a.name + ', somando ' + brl(inst.reduce((t, i) => t + i.value_cents, 0)) + '? O Asaas avisa o cliente por e-mail/SMS.')) return;
        el('cCreate').disabled = true;
        try { await api('/master/billing/accounts/' + a.id + '/charges', 'POST', { kind: el('cKind').value, description: el('cDesc').value.trim(), installments: inst }); msg('Cobrança(s) criada(s) no Asaas.'); await load(); } catch (e) { msg(e.message); el('cCreate').disabled = false; }
      };
    };
    document.querySelectorAll('.cCopy').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.url); msg('Link copiado.'); } catch { prompt('Link da cobrança', b.dataset.url); } });
    document.querySelectorAll('.cDel').forEach(b => b.onclick = async () => { if (!confirm('Cancelar esta cobrança no Asaas? O link deixa de funcionar.')) return; try { await api('/master/billing/charges/' + b.dataset.id, 'DELETE'); msg('Cobrança cancelada.'); await load(); } catch (e) { msg(e.message); } });
    document.querySelectorAll('.cCash').forEach(b => b.onclick = async () => {
      const v = prompt('Valor recebido (R$)', money(Number(b.dataset.value))); if (v === null) return; const d = prompt('Data do recebimento (dd/mm/aaaa)', dmy(today)); if (d === null) return;
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d.trim()); if (!m) return msg('Data inválida.');
      try { await api('/master/billing/charges/' + b.dataset.id + '/receive', 'POST', { value_cents: toCents(v), paid_at: m[3] + '-' + m[2] + '-' + m[1] }); msg('Baixa feita no Asaas.'); await load(); } catch (e) { msg(e.message); }
    });
  }

  window.billingPage = async function billingPage() { selected = null; render('<section>Carregando…</section>'); await load(); };
})();
