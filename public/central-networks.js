// Central: "Redes" — lojas com várias unidades (ex.: Audace Joias, 7 quiosques).
// Cria a rede, define o endereço próprio (audace.ficoupronto.com), liga as unidades com CNPJ e rótulo
// e cria o login do dono da rede. Usa os utilitários globais do app.js: api, el, safe, msg, render.
(() => {
  const fmtCnpj = c => c && c.length === 14 ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : '';
  let selected = null;

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
    const users = await api('/master/networks/' + net.id + '/users');
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
        + '<td style="display:flex;gap:6px"><button type="button" class="ct-btn ghost unSave" style="height:34px">Salvar</button><button type="button" class="ct-btn ghost unRemove" style="height:34px">Tirar da rede</button></td></tr>').join('') || '<tr><td colspan="5" class="ct-muted">Nenhuma unidade ligada.</td></tr>')
      + '</tbody></table></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-top:12px"><label>Ligar loja à rede<select id="unAdd">' + (free.map(s => '<option value="' + safe(s.id) + '">' + safe(s.name) + '</option>').join('') || '<option value="">Nenhuma loja livre</option>') + '</select></label>'
      + '<button type="button" class="ct-btn" id="unAddBtn"' + (free.length ? '' : ' disabled') + '>Ligar</button></div>'
      + '<p class="ct-muted" style="margin:8px 0 0">Cada unidade é uma loja com CNPJ, caixa e estoque próprios. Crie as lojas em "Lojas" e ligue aqui.</p></section>'
      + '<section><h2>Login do dono da rede</h2><p class="ct-muted">Vê o painel com todas as unidades. Não opera o caixa.</p><div class="ct-table-wrap"><table class="ct-table"><thead><tr><th>Nome</th><th>E-mail</th><th>Situação</th><th></th></tr></thead><tbody>'
      + (users.map(u => '<tr><td>' + safe(u.name) + '</td><td>' + safe(u.email) + '</td><td>' + (u.active ? 'Ativo' : 'Desativado') + '</td><td><button type="button" class="ct-btn ghost nuToggle" data-id="' + safe(u.id) + '" data-active="' + (u.active ? '1' : '') + '" style="height:34px">' + (u.active ? 'Desativar' : 'Ativar') + '</button></td></tr>').join('') || '<tr><td colspan="4" class="ct-muted">Nenhum login ainda.</td></tr>')
      + '</tbody></table></div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-top:12px">'
      + '<label>Nome<input id="nuName" maxlength="120"></label><label>E-mail<input id="nuEmail" type="email"></label><label>Senha (12+ caracteres)<input id="nuPass" type="password" autocomplete="new-password"></label>'
      + '<button type="button" class="ct-btn" id="nuCreate">Criar login</button></div></section>';
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
    document.querySelectorAll('.unRemove').forEach(b => b.onclick = act(async () => {
      if (!confirm('Tirar esta loja da rede? Ela continua funcionando sozinha.')) throw Error('');
      await api('/master/tenants/' + b.closest('tr').dataset.id + '/network', 'PATCH', { network_id: null });
      return 'Loja tirada da rede.';
    }));
    el('unAddBtn').onclick = act(async () => { await api('/master/tenants/' + el('unAdd').value + '/network', 'PATCH', { network_id: net.id }); return 'Loja ligada à rede.'; });
    document.querySelectorAll('.nuToggle').forEach(b => b.onclick = act(async () => { await api('/master/network-users/' + b.dataset.id, 'PATCH', { active: !b.dataset.active }); return 'Login atualizado.'; }));
    el('nuCreate').onclick = act(async () => {
      await api('/master/networks/' + net.id + '/users', 'POST', { name: el('nuName').value.trim(), email: el('nuEmail').value.trim(), password: el('nuPass').value });
      return 'Login criado. Entregue a senha ao dono da rede por um canal seguro.';
    });
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
