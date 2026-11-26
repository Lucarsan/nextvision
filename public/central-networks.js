// Central: "Redes" — lojas com várias unidades (ex.: Audace Joias, 7 quiosques).
// Cria a rede, define o endereço próprio (audace.ficoupronto.com), liga as unidades com CNPJ e rótulo
// e cria o login do dono da rede. Usa os utilitários globais do app.js: api, el, safe, msg, render.
(() => {
  const fmtCnpj = c => c && c.length === 14 ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : '';
  let selected = null;
  // 'hidden' precisa vencer o display:flex das listas de unidades.
  if (!document.getElementById('netHiddenCss')) document.head.insertAdjacentHTML('beforeend', '<style id="netHiddenCss">#content [hidden]{display:none!important}</style>');

  // ---- Pessoas da rede: donos, supervisores e o pessoal de cada unidade ----
  const FUNCS = { dono: 'Dono (rede toda)', supervisor: 'Supervisor', vendedora: 'Vendedora (PIN, sem login)', gerente: 'Gerente da loja', responsavel: 'Responsável com login', consultora: 'Operador novato com login' };
  const unitName = u => u.unit_label || u.name;
  const funcSelect = cur => '<select class="pFunc">' + Object.entries(FUNCS).map(([k, v]) => '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>';
  // Onde a pessoa atua: dono = toda a rede; supervisor = várias unidades; demais = uma unidade.
  const wherePicker = (p, units) => '<div class="pWhere">'
    + '<span class="pAll ct-muted"' + (p.function === 'dono' ? '' : ' hidden') + '>Todas as unidades</span>'
    + '<select class="pUnit"' + (['dono', 'supervisor'].includes(p.function) ? ' hidden' : '') + '><option value="">Escolha…</option>' + units.map(u => '<option value="' + safe(u.id) + '"' + (u.id === p.unit_id ? ' selected' : '') + '>' + safe(unitName(u)) + '</option>').join('') + '</select>'
    + '<div class="pUnits"' + (p.function === 'supervisor' ? '' : ' hidden') + ' style="display:flex;flex-wrap:wrap;gap:4px 10px">' + units.map(u => '<label style="display:inline-flex;gap:4px;align-items:center;font-weight:500"><input type="checkbox" value="' + safe(u.id) + '"' + ((p.unit_ids || []).includes(u.id) ? ' checked' : '') + '>' + safe(unitName(u)) + '</label>').join('') + '</div></div>';
  const personRow = (p, units) => '<tr data-id="' + safe(p.id || '') + '"' + (p.id ? '' : ' class="pNew"') + '>'
    + '<td><input class="pName" maxlength="120" value="' + safe(p.name || '') + '" placeholder="Nome" style="width:170px"></td>'
    + '<td><input class="pEmail" type="email" maxlength="200" value="' + safe(p.email || '') + '" placeholder="email@exemplo.com" style="width:210px"' + ((p.function || 'vendedora') === 'vendedora' ? ' hidden' : '') + '><span class="pNoEmail ct-muted"' + ((p.function || 'vendedora') === 'vendedora' ? '' : ' hidden') + '>sem login</span></td>'
    + '<td><input class="pPin" inputmode="numeric" maxlength="4" pattern="\\d{4}" placeholder="' + (p.has_pin ? '•••• (trocar)' : (p.id ? 'sem PIN' : 'gera sozinho')) + '" style="width:110px"></td>'
    + '<td>' + funcSelect(p.function || 'vendedora') + '</td><td>' + wherePicker({ function: 'vendedora', ...p }, units) + '</td>'
    + (p.id ? '<td><label style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" class="pActive"' + (p.active ? ' checked' : '') + '>Ativo</label></td>'
      + '<td style="white-space:nowrap"><button type="button" class="ct-btn ghost pSave" style="height:34px">Salvar</button>' + (p.function === 'vendedora' ? '' : ' <button type="button" class="ct-btn ghost pLink" style="height:34px"' + (p.active ? '' : ' disabled') + '>Enviar link de senha</button>') + '</td>'
      : '<td></td><td><button type="button" class="ct-btn pAdd" style="height:34px">Adicionar</button></td>') + '</tr>';
  const peopleSection = (people, units) => '<section><h2>Pessoas da rede</h2><p class="ct-muted">Vendedoras não têm login: o computador do quiosque fica aberto com a senha da unidade e cada venda é confirmada com o PIN de 4 dígitos de quem vendeu. Donos veem a rede toda; supervisores, só as unidades marcadas. O PIN de dono, supervisor ou gerente autoriza cancelamento no quiosque. "Enviar link de senha" manda por e-mail um link para a pessoa criar a própria senha.</p>'
    + '<div class="ct-table-wrap"><table class="ct-table"><thead><tr><th>Nome</th><th>E-mail</th><th>PIN</th><th>Função</th><th>Onde atua</th><th>Situação</th><th></th></tr></thead><tbody>'
    + people.map(p => personRow(p, units)).join('') + personRow({}, units) + '</tbody></table></div></section>';
  const readPerson = row => {
    const func = row.querySelector('.pFunc').value, body = { name: row.querySelector('.pName').value.trim(), function: func };
    const email = row.querySelector('.pEmail').value.trim(); if (func !== 'vendedora' && email) body.email = email;
    const pin = row.querySelector('.pPin').value.trim(); if (pin) body.pin = pin;
    if (func === 'supervisor') body.unit_ids = [...row.querySelectorAll('.pUnits input:checked')].map(i => i.value);
    else if (func !== 'dono') body.unit_id = row.querySelector('.pUnit').value || null;
    const act = row.querySelector('.pActive'); if (act) body.active = act.checked;
    return body;
  };
  function bindPeople(net, units, act) {
    document.querySelectorAll('.pFunc').forEach(sel => sel.onchange = () => {
      const w = sel.closest('tr').querySelector('.pWhere'), f = sel.value;
      w.querySelector('.pAll').hidden = f !== 'dono'; w.querySelector('.pUnit').hidden = ['dono', 'supervisor'].includes(f); w.querySelector('.pUnits').hidden = f !== 'supervisor';
      const tr = sel.closest('tr'); tr.querySelector('.pEmail').hidden = f === 'vendedora'; tr.querySelector('.pNoEmail').hidden = f !== 'vendedora';
    });
    document.querySelectorAll('.pSave').forEach(b => b.onclick = act(async () => {
      const row = b.closest('tr'); const r = await api('/master/network-people/' + row.dataset.id, 'PATCH', readPerson(row));
      return 'Pessoa salva.' + (r.temporary_pin ? ' PIN (aparece só agora): ' + r.temporary_pin + '.' : '');
    }));
    document.querySelectorAll('.pLink').forEach(b => b.onclick = act(async () => {
      const r = await api('/master/users/' + b.closest('tr').dataset.id + '/password-link', 'POST'); return 'Link de nova senha enviado para ' + r.email + '.';
    }));
    document.querySelectorAll('.pAdd').forEach(b => b.onclick = act(async () => {
      const r = await api('/master/networks/' + net.id + '/people', 'POST', readPerson(b.closest('tr')));
      return 'Pessoa criada.' + (r.temporary_pin ? ' PIN (aparece só agora): ' + r.temporary_pin + '.' : '') + (r.temporary_password ? ' Senha temporária (aparece só agora): ' + r.temporary_password + ' · ou use "Enviar link de senha".' : '');
    }));
  }

  async function load() {
    const [networks, stores] = await Promise.all([api('/master/networks'), api('/master/tenants')]);
    if (!selected && networks.length) selected = networks[0].id;
    const net = networks.find(n => n.id === selected);
    const list = '<section><h2>Redes</h2><div class="ct-table-wrap"><table class="ct-table"><thead><tr><th>Rede</th><th>Endereço</th><th>Unidades</th><th>Situação</th><th></th></tr></thead><tbody>'
      + (networks.map(n => '<tr><td><strong>' + safe(n.name) + '</strong></td><td>' + (n.hostname ? safe(n.hostname) : '<span class="ct-muted">—</span>') + '</td><td>' + n.units_count + '</td><td>' + (n.status === 'active' ? 'Ativa' : 'Suspensa') + '</td><td><button type="button" class="ct-btn ghost netOpen" data-id="' + safe(n.id) + '" style="height:34px">' + (n.id === selected ? 'Aberta' : 'Abrir') + '</button></td></tr>').join('') || '<tr><td colspan="5" class="ct-muted">Nenhuma rede ainda.</td></tr>')
      + '</tbody></table></div>'
      + '<h3 style="margin-top:18px">Nova rede</h3><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">'
      + '<label>Nome<input id="netName" maxlength="120" placeholder="Audace Joias"></label>'
      + '<label>Identificador<input id="netSlug" maxlength="60" placeholder="audace" pattern="[a-z0-9-]{3,60}"></label>'
      + '<label>Endereço (opcional)<input id="netHost" maxlength="253" placeholder="audace.ficoupronto.com"></label>'
      + '<button type="button" class="ct-btn" id="netCreate">Criar rede</button></div></section>';
    if (!net) { render(list); bindList(); return; }

    const units = await api('/master/networks/' + net.id + '/units');
    const people = await api('/master/networks/' + net.id + '/people');
    const free = stores.filter(s => !s.network_id);
    const detail = '<section><h2>' + safe(net.name) + '</h2>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">'
      + '<label>Endereço próprio<input id="netEdHost" maxlength="253" value="' + safe(net.hostname || '') + '" placeholder="audace.ficoupronto.com"></label>'
      + '<label>Logo (https://)<input id="netEdLogo" maxlength="500" value="' + safe(net.logo_url || '') + '" placeholder="https://…"></label>'
      + '<label>Cor da marca<input id="netEdColor" type="color" value="' + safe(net.brand_color || '#111827') + '"></label>'
      + '<label>Situação<select id="netEdStatus"><option value="active"' + (net.status === 'active' ? ' selected' : '') + '>Ativa</option><option value="suspended"' + (net.status === 'suspended' ? ' selected' : '') + '>Suspensa</option></select></label>'
      + '<button type="button" class="ct-btn" id="netSave">Salvar</button></div>'
      + '<p class="ct-muted" style="margin:8px 0 0">O endereço próprio também precisa existir na Cloudflare (CNAME para o portal) e como domínio personalizado no Render.</p></section>'
      + '<section><h2>Unidades</h2><div class="ct-table-wrap"><table class="ct-table"><thead><tr><th>Loja</th><th>Rótulo no painel</th><th>CNPJ</th><th>Situação</th><th></th></tr></thead><tbody>'
      + (units.map(u => '<tr data-id="' + safe(u.id) + '"><td><strong>' + safe(u.name) + '</strong></td>'
        + '<td><input class="unLabel" maxlength="60" value="' + safe(u.unit_label || '') + '" placeholder="Ex.: Maracanaú" style="width:150px"></td>'
        + '<td><input class="unCnpj" maxlength="18" value="' + safe(fmtCnpj(u.cnpj)) + '" placeholder="00.000.000/0000-00" style="width:170px"></td>'
        + '<td>' + safe(u.status) + (u.sales_enabled ? '' : ' <span class="ct-muted">(caixa desligado)</span>') + '</td>'
        + '<td style="display:flex;gap:6px"><button type="button" class="ct-btn ghost unSave" style="height:34px">Salvar</button><button type="button" class="ct-btn ghost unKiosk" style="height:34px">Nova senha do quiosque</button><button type="button" class="ct-btn ghost unImport" style="height:34px">Importar planilha</button><button type="button" class="ct-btn ghost unDepot" style="height:34px" data-depot="' + (u.depot ? '1' : '') + '">' + (u.depot ? 'É o depósito central' : 'Marcar como depósito') + '</button><button type="button" class="ct-btn ghost unRemove" style="height:34px">Tirar da rede</button></td></tr>').join('') || '<tr><td colspan="5" class="ct-muted">Nenhuma unidade ligada.</td></tr>')
      + '</tbody></table></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-top:12px"><label>Ligar loja à rede<select id="unAdd">' + (free.map(s => '<option value="' + safe(s.id) + '">' + safe(s.name) + '</option>').join('') || '<option value="">Nenhuma loja livre</option>') + '</select></label>'
      + '<button type="button" class="ct-btn" id="unAddBtn"' + (free.length ? '' : ' disabled') + '>Ligar</button>'
        + '<button type="button" class="ct-btn ghost" id="netImport" style="margin-left:auto">Importar peças para todas as unidades</button></div>'
      + '<p class="ct-muted" style="margin:8px 0 0">Cada unidade é uma loja com CNPJ, caixa e estoque próprios. Crie as lojas em "Lojas" e ligue aqui.</p></section>'
      + '<section><h2>Exportar dados da rede</h2><p class="ct-muted">Planilhas (CSV) de todo o período. Use quando a rede pedir os dados, inclusive bloqueada.</p><p>' + ['vendas', 'itens', 'clientes', 'estoque'].map(k => '<button type="button" class="ct-btn ghost netEx" data-k="' + k + '" style="height:34px;margin-right:6px">' + k[0].toUpperCase() + k.slice(1) + '</button>').join('') + '</p></section>'
      + '<section><h2>Créditos do emissor de NFC-e</h2><p class="ct-muted">Pacote de operações comprado do emissor (ex.: ACBr API). O dono da rede vê no painel; aviso por e-mail em 85% e 100%.</p><p id="fcNow" class="ct-muted">Carregando…</p>'
      + '<div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap"><label>Emissor<input id="fcProv" value="ACBr API" style="width:140px"></label><label>Operações<input id="fcOps" type="number" min="1" style="width:110px"></label><label>Valor (R$)<input id="fcPrice" inputmode="decimal" style="width:110px"></label><label>Data da compra<input id="fcDate" type="date"></label><button type="button" class="ct-btn" id="fcAdd">Registrar pacote</button></div>'
      + '<div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-top:10px"><label>Usado segundo o painel do emissor<input id="fcUsed" type="number" min="0" style="width:140px"></label><button type="button" class="ct-btn ghost" id="fcAdj">Acertar usado</button></div></section>'
      + '<section><h2>Vídeos de treinamento</h2><p class="ct-muted">Vídeo no Cloudflare R2. Vendedora assiste no quiosque com o PIN; supervisor e gestão no painel da rede, onde acompanham quem já viu.</p><div id="trCard"></div></section>'
      + '<section><h2>Implantação das unidades</h2><p class="ct-muted">Checklist "unidade pronta". A rede vê o mesmo quadro no painel dela (menu Implantação) e dá o aceite por lá.</p><div id="onbCard"></div></section>'
      + '<section id="acbrCard"></section>'
      + '<section id="tefCard"></section>'
      + '<section><h2>Resumo diário por e-mail</h2><p class="ct-muted">Todo dia às 8h, o resumo do dia anterior (vendas por unidade, formas de pagamento, cancelamentos e diferença de caixa).</p><div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap"><label>E-mails (separados por vírgula)<input id="netRepEmails" style="width:420px" value="' + safe((net.report_emails || []).join(', ')) + '"></label><button type="button" class="ct-btn" id="netRepSave">Salvar</button></div></section>'
      + '<section><h2>Comissão por faixa</h2><p class="ct-muted">A faixa alcançada pelas vendas do mês da vendedora vale sobre o total do mês. Ex.: 2% a partir de R$ 0, 3% a partir de R$ 20.000, 4% a partir de R$ 30.000.</p>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">' + [0, 1, 2].map(i => { const t = (net.commission_tiers || [])[i] || {}; return '<label>A partir de (R$)<input class="tierMin" inputmode="decimal" style="width:120px" value="' + (t.min_cents != null ? (t.min_cents / 100).toFixed(2).replace('.', ',') : '') + '"></label><label>%<input class="tierPct" inputmode="decimal" style="width:70px" value="' + (t.percent != null ? String(t.percent).replace('.', ',') : ['2', '3', '4'][i]) + '"></label>'; }).join('<span style="width:12px"></span>')
      + '<button type="button" class="ct-btn" id="tierSave">Salvar faixas</button></div></section>'
      + peopleSection(people, units);
    render(list + detail);
    bindList();
    const act = fn => async () => { try { const done = await fn(); await load(); msg(done || ''); } catch (e) { msg(e.message); } };
    el('netSave').onclick = act(async () => {
      await api('/master/networks/' + net.id, 'PATCH', { hostname: el('netEdHost').value.trim() || null, logo_url: el('netEdLogo').value.trim() || null, brand_color: el('netEdColor').value, status: el('netEdStatus').value });
      return 'Rede salva.';
    });
    document.querySelectorAll('.unSave').forEach(b => b.onclick = act(async () => {
      const row = b.closest('tr');
      await api('/master/tenants/' + row.dataset.id + '/network', 'PATCH', { unit_label: row.querySelector('.unLabel').value.trim() || null, cnpj: row.querySelector('.unCnpj').value.trim() || null });
      return 'Unidade salva.';
    }));
    // Senha do computador do quiosque (abre o caixa da unidade). Mostrada uma vez; a senha antiga deixa de valer.
    document.querySelectorAll('.unKiosk').forEach(b => b.onclick = act(async () => {
      if (!confirm('Gerar uma nova senha para o quiosque desta unidade? O computador da loja vai precisar entrar de novo.')) throw Error('');
      const r = await api('/master/tenants/' + b.closest('tr').dataset.id + '/kiosk-password', 'POST', {});
      return 'Senha do quiosque ' + r.unit + ' (aparece só agora): ' + r.password;
    }));
    // Importar peças ou clientes (.xlsx do sistema antigo). Confere primeiro, mostra o resumo e só grava se confirmar.
    const sendSheet = async (tenantId, file, dry) => {
      const r = await fetch('/api/master/tenants/' + tenantId + '/import' + (dry ? '?dry_run=1' : ''), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: file });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw Error(j.error || 'Erro na importação'); return j;
    };
    const describe = s => (s.kind === 'products'
      ? s.total + ' peças (' + s.new + ' novas, ' + s.update + ' já cadastradas)' + (s.negative_stock ? '; ' + s.negative_stock + ' com estoque negativo' : '') + (s.no_ncm ? '; ' + s.no_ncm + ' sem NCM' : '') + (s.inactive ? '; ' + s.inactive + ' inativas' : '')
      : s.total + ' clientes (' + s.new + ' novos, ' + s.update + ' já cadastrados); ' + s.with_cpf + ' com CPF, ' + s.with_phone + ' com telefone, ' + s.with_email + ' com e-mail')
      + (s.skipped.length ? '. Ignoradas ' + s.skipped.length + ' linhas: ' + s.skipped.slice(0, 5).map(x => 'linha ' + x.line + ' (' + x.reason + ')').join(', ') + (s.skipped.length > 5 ? '…' : '') : '');
    // Catálogo único da rede: mesma planilha de peças em todas as unidades; peça nova entra com estoque 0.
    el('netImport').onclick = () => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.xlsx';
      input.onchange = act(async () => {
        const file = input.files[0]; if (!file) throw Error('');
        const send = async dry => { const r = await fetch('/api/master/networks/' + net.id + '/import' + (dry ? '?dry_run=1' : ''), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: file }); const j = await r.json().catch(() => ({})); if (!r.ok) throw Error(j.error || 'Erro na importação'); return j; };
        const pre = await send(true);
        const lines = pre.units.map(u => u.unit + ': ' + u.new + ' novas, ' + u.update + ' já cadastradas').join('\n');
        if (!confirm('Peças para ' + pre.store + ': ' + pre.total + ' na planilha.\n\n' + lines + '\n\nPeças novas entram com estoque 0 (o estoque de cada loja vem da contagem). Peças já cadastradas mantêm o estoque.' + (pre.skipped.length ? '\nIgnoradas ' + pre.skipped.length + ' linhas: ' + pre.skipped.slice(0, 5).map(x => 'linha ' + x.line + ' (' + x.reason + ')').join(', ') : '') + '\n\nGravar agora?')) throw Error('Importação cancelada.');
        const done = await send(false);
        return 'Peças importadas em ' + done.store + ': ' + done.new + ' novas, ' + done.update + ' atualizadas.';
      });
      input.click();
    };
    document.querySelectorAll('.unImport').forEach(b => b.onclick = () => {
      const tenantId = b.closest('tr').dataset.id, input = document.createElement('input');
      input.type = 'file'; input.accept = '.xlsx';
      input.onchange = act(async () => {
        const file = input.files[0]; if (!file) throw Error('');
        const pre = await sendSheet(tenantId, file, true);
        if (!confirm('Planilha de ' + (pre.kind === 'products' ? 'PEÇAS' : 'CLIENTES') + ' para ' + pre.store + ':\n\n' + describe(pre) + '\n\nGravar agora?')) throw Error('Importação cancelada.');
        const done = await sendSheet(tenantId, file, false);
        return 'Importado em ' + done.store + ': ' + describe(done);
      });
      input.click();
    });
    document.querySelectorAll('.unDepot').forEach(b => b.onclick = act(async () => {
      const on = !b.dataset.depot;
      if (!confirm(on ? 'Marcar esta loja como depósito central? O quiosque dela abre direto no Estoque (envio e recebimento).' : 'Deixar de ser o depósito central?')) throw Error('');
      await api('/master/tenants/' + b.closest('tr').dataset.id + '/depot', 'PATCH', { depot: on });
      return on ? 'Loja marcada como depósito central.' : 'Loja deixou de ser depósito.';
    }));
    document.querySelectorAll('.unRemove').forEach(b => b.onclick = act(async () => {
      if (!confirm('Tirar esta loja da rede? Ela continua funcionando sozinha.')) throw Error('');
      await api('/master/tenants/' + b.closest('tr').dataset.id + '/network', 'PATCH', { network_id: null });
      return 'Loja tirada da rede.';
    }));
    el('unAddBtn').onclick = act(async () => { await api('/master/tenants/' + el('unAdd').value + '/network', 'PATCH', { network_id: net.id }); return 'Loja ligada à rede.'; });
    document.querySelectorAll('.netEx').forEach(b => b.onclick = act(async () => {
      const r = await fetch('/api/master/networks/' + net.id + '/export/' + b.dataset.k, { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) throw Error((await r.json().catch(() => ({}))).error || 'Erro ao exportar');
      const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = net.slug + '-' + b.dataset.k + '.csv'; a.click(); return 'Planilha baixada.';
    }));
    const fcShow = c => { el('fcNow').innerHTML = c.purchased ? '<b>' + c.used.toLocaleString('pt-BR') + ' de ' + c.purchased.toLocaleString('pt-BR') + '</b> usadas (' + c.percent.toLocaleString('pt-BR') + '%) · ' + c.packages.length + ' pacote(s)' : 'Nenhum pacote registrado.'; };
    window.fpTraining?.({ box: el('trCard'), mode: 'master', api, networkId: net.id });
    window.fpOnboarding?.({ box: el('onbCard'), mode: 'master', api, networkId: net.id, networkName: net.name.split(/\s+/)[0] });
    window.acbrCard?.(el('acbrCard'), units);
    window.tefCard?.(el('tefCard'), units);
    api('/master/networks/' + net.id + '/fiscal-credits').then(fcShow).catch(e => { el('fcNow').textContent = e.message; });
    el('fcDate').value = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    el('fcAdd').onclick = act(async () => { const c = await api('/master/networks/' + net.id + '/fiscal-credits/packages', 'POST', { provider: el('fcProv').value.trim(), operations: Number(el('fcOps').value), price_cents: Math.round(Number((el('fcPrice').value || '0').replace(/\./g, '').replace(',', '.')) * 100), purchased_on: el('fcDate').value }); fcShow(c); return 'Pacote registrado.'; });
    el('fcAdj').onclick = act(async () => { const c = await api('/master/networks/' + net.id + '/fiscal-credits/adjust', 'POST', { used_total: Number(el('fcUsed').value) }); fcShow(c); return 'Usado acertado.'; });
    el('netRepSave').onclick = act(async () => { await api('/master/networks/' + net.id + '/report-emails', 'PUT', { emails: el('netRepEmails').value.split(',').map(x => x.trim()).filter(Boolean) }); return 'E-mails do resumo diário salvos.'; });
    el('tierSave').onclick = act(async () => {
      const mins = [...document.querySelectorAll('.tierMin')], pcts = [...document.querySelectorAll('.tierPct')];
      const tiers = mins.map((m, i) => ({ m: m.value.trim(), p: pcts[i].value.trim() })).filter(x => x.m !== '' && x.p !== '')
        .map(x => ({ min_cents: Math.round(Number(x.m.replace(/\./g, '').replace(',', '.')) * 100), percent: Number(x.p.replace(',', '.')) }));
      await api('/master/networks/' + net.id + '/commission-tiers', 'PUT', { tiers });
      return 'Faixas de comissão salvas.';
    });
    bindPeople(net, units, act);
  }

  function bindList() {
    document.querySelectorAll('.netOpen').forEach(b => b.onclick = () => { selected = b.dataset.id; load().catch(e => msg(e.message)); });
    el('netCreate').onclick = async () => {
      try {
        const n = await api('/master/networks', 'POST', { name: el('netName').value.trim(), slug: el('netSlug').value.trim(), hostname: el('netHost').value.trim() || null });
        selected = n.id; msg('Rede criada.'); await load();
      } catch (e) { msg(e.message); }
    };
  }

  window.networksPage = async function networksPage() { render('<section>Carregando…</section>'); await load(); };
})();
