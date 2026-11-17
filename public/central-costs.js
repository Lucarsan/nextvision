// Central: "Custos" — quanto cada loja e cada dono (grupo de lojas) custam por mês.
// Usa os utilitários globais do app.js: api, el, safe, msg, render.
(() => {
  const RULE = { per_camera: 'Por câmera', per_store: 'Igual por loja', by_usage: 'Pelo uso', platform: 'Só da plataforma (não rateia)' };
  const brl = v => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd = v => 'US$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const mb = b => ((Number(b) || 0) / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' MB';
  const hours = slots => ((Number(slots) || 0) * 5 / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' h';
  const kpi = (label, value, note = '') => '<div class="ct-kpi"><span>' + safe(label) + '</span><strong style="font-size:28px">' + safe(value) + '</strong><em>' + safe(note) + '</em></div>';
  const lastMonths = () => { const out = [], d = new Date(Date.now() - 3 * 3600000); for (let i = 0; i < 6; i++) { out.push(d.toISOString().slice(0, 7)); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); } return out; };
  const monthName = m => new Date(m + '-15T12:00:00Z').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  let month = null, data = null;

  function itemRow(it = { name: '', amount: 0, currency: 'BRL', rule: 'per_camera' }) {
    return '<tr class="costItem"><td><input class="ciName" maxlength="60" value="' + safe(it.name) + '" placeholder="Ex.: chip/internet da câmera" style="width:100%"></td>'
      + '<td><input class="ciAmount" type="number" min="0" step="0.01" value="' + safe(it.amount) + '" style="width:110px"></td>'
      + '<td><select class="ciCur"><option' + (it.currency === 'BRL' ? ' selected' : '') + '>BRL</option><option' + (it.currency === 'USD' ? ' selected' : '') + '>USD</option></select></td>'
      + '<td><select class="ciRule">' + Object.entries(RULE).map(([k, v]) => '<option value="' + k + '"' + (it.rule === k ? ' selected' : '') + '>' + v + '</option>').join('') + '</select></td>'
      + '<td><button type="button" class="ct-btn ghost ciDel" style="height:34px">Remover</button></td></tr>';
  }

  function page(d) {
    const n = d.neon || {}, groups = d.groups || [], stores = d.stores || [];
    const groupNames = [...new Set(stores.map(s => s.billing_group).filter(Boolean))];
    const neonCard = n.available
      ? kpi('Banco (Neon) no mês', usd(n.total_usd), (n.plan ? 'plano ' + n.plan : 'plano grátis') + ' · ' + brl(n.total_usd * d.usd_brl) + ' · computação ' + usd(n.compute_usd) + ' · espaço ' + usd(n.storage_usd))
      : kpi('Banco (Neon) no mês', '—', n.reason || 'sem dados');
    const head = '<section><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px">'
      + neonCard
      + kpi('Custos fixos cadastrados', usd(d.totals.fixed_usd), brl(d.totals.fixed_usd * d.usd_brl) + ' por mês')
      + kpi('Total rateado entre as lojas', brl(d.totals.allocated_usd * d.usd_brl), usd(d.totals.allocated_usd) + ' · cotação R$ ' + Number(d.usd_brl).toLocaleString('pt-BR'))
      + kpi('Medindo desde', d.measuring_since ? new Date(d.measuring_since + 'T12:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'agora', 'o uso por loja começa a contar na publicação desta página')
      + '</div>'
      + (n.other_projects?.length ? '<p class="ct-muted" style="margin:12px 0 0">Outros projetos na mesma conta do Neon (não entram no rateio das lojas): ' + n.other_projects.map(p => safe(p.name) + ' ' + usd(p.total_usd)).join(' · ') + '.</p>' : '')
      + '<p class="ct-muted" style="margin:8px 0 0">Valores antes dos créditos: é o custo real de cada loja, mesmo que hoje o crédito do Neon pague a fatura.</p></section>';

    const groupTable = '<section><h2>Por dono (grupo de lojas)</h2><p class="ct-muted">Lojas sem grupo aparecem sozinhas. Para juntar lojas do mesmo dono, dê o mesmo nome de grupo a elas na tabela de baixo.</p>'
      + '<div class="ct-table-wrap"><table class="ct-table"><thead><tr><th>Dono / grupo</th><th>Lojas</th><th>Câmeras</th><th>Custo do mês</th><th>Em dólar</th></tr></thead><tbody>'
      + (groups.map(g => '<tr><td><strong>' + safe(g.name) + '</strong>' + (g.grouped ? '' : ' <span class="ct-muted">(sem grupo)</span>') + '</td><td>' + g.stores.map(s => safe(s.name)).join(', ') + '</td><td>' + g.cameras + '</td><td><strong>' + brl(g.total_brl) + '</strong></td><td>' + usd(g.total_usd) + '</td></tr>').join('') || '<tr><td colspan="5" class="ct-muted">Nenhuma loja ativa.</td></tr>')
      + '</tbody></table></div></section>';

    const storeTable = '<section><h2>Por loja</h2><p class="ct-muted">Banco acordado: tempo em que a loja usou o banco (cada janela de 5 min é dividida entre as lojas que usaram nela). Espaço: dados da loja guardados no banco. Plataforma: a parte da central e das rotinas, dividida pelo uso de cada loja.</p>'
      + '<datalist id="costGroups">' + groupNames.map(g => '<option value="' + safe(g) + '">').join('') + '</datalist>'
      + '<div class="ct-table-wrap"><table class="ct-table"><thead><tr><th>Loja</th><th>Grupo (dono)</th><th>Câmeras</th><th>Banco acordado</th><th>Espaço</th><th>Acessos</th><th>Banco</th><th>Plataforma</th><th>Fixos</th><th>Total</th></tr></thead><tbody>'
      + (stores.map(s => '<tr><td><strong>' + safe(s.name) + '</strong>' + (s.status !== 'active' ? ' <span class="ct-muted">(' + safe(s.status) + ')</span>' : '') + '</td>'
        + '<td><input class="costGroup" data-id="' + safe(s.id) + '" list="costGroups" maxlength="80" value="' + safe(s.billing_group || '') + '" placeholder="—" style="width:140px"></td>'
        + '<td>' + (s.cameras || 0) + '</td><td>' + hours(s.usage.active_slots) + ' <span class="ct-muted">(' + s.compute_share + '%)</span></td>'
        + '<td>' + mb(s.storage_bytes) + ' <span class="ct-muted">(' + s.storage_share + '%)</span></td><td>' + (Number(s.usage.requests) || 0).toLocaleString('pt-BR') + '</td>'
        + '<td>' + usd(s.neon_usd) + '</td><td>' + usd(s.platform_usd) + '</td><td>' + usd(s.fixed_usd) + '</td><td><strong>' + brl(s.total_brl) + '</strong></td></tr>').join('') || '<tr><td colspan="10" class="ct-muted">Nenhuma loja ativa.</td></tr>')
      + '</tbody></table></div><p class="ct-muted" style="margin:8px 0 0">Plataforma (central, monitoramento, rotinas): banco acordado ' + hours(d.platform.usage.active_slots) + ', ' + (Number(d.platform.usage.requests) || 0).toLocaleString('pt-BR') + ' acessos'
      + (d.platform.fixed_usd ? ' · custos fixos só da plataforma: ' + usd(d.platform.fixed_usd) : '') + '.</p></section>';

    const settings = '<section><h2>Custos fixos e cotação</h2><p class="ct-muted">Cadastre o que você paga todo mês para manter as lojas (ex.: chip/internet por câmera, domínio, ferramentas) e como dividir.</p>'
      + '<label style="display:inline-flex;gap:8px;align-items:center">Cotação do dólar (R$)<input id="costFx" type="number" min="0.01" step="0.01" value="' + safe(d.usd_brl) + '" style="width:110px"></label>'
      + '<div class="ct-table-wrap" style="margin-top:12px"><table class="ct-table"><thead><tr><th>Custo</th><th>Valor por mês</th><th>Moeda</th><th>Como dividir</th><th></th></tr></thead><tbody id="costItems">'
      + (d.cost_items || []).map(itemRow).join('') + '</tbody></table></div>'
      + '<div style="display:flex;gap:8px;margin-top:10px"><button type="button" class="ct-btn ghost" id="costAdd">Adicionar custo</button><button type="button" class="ct-btn" id="costSave">Salvar e recalcular</button></div></section>';
    return head + groupTable + storeTable + settings;
  }

  async function load() {
    render('<section>Calculando os custos…</section>');
    data = await api('/master/costs?month=' + encodeURIComponent(month));
    render(page(data));
    document.querySelectorAll('.costGroup').forEach(inp => inp.onchange = async () => {
      try { await api('/master/tenants/' + inp.dataset.id + '/billing-group', 'PATCH', { billing_group: inp.value.trim() }); msg('Grupo salvo.'); await load(); } catch (e) { msg(e.message); }
    });
    const bindDel = () => document.querySelectorAll('.ciDel').forEach(b => b.onclick = () => b.closest('tr').remove());
    bindDel();
    el('costAdd').onclick = () => { el('costItems').insertAdjacentHTML('beforeend', itemRow()); bindDel(); };
    el('costSave').onclick = async () => {
      const items = [...document.querySelectorAll('.costItem')].map(r => ({ name: r.querySelector('.ciName').value.trim(), amount: Number(r.querySelector('.ciAmount').value) || 0, currency: r.querySelector('.ciCur').value, rule: r.querySelector('.ciRule').value })).filter(x => x.name);
      try { await api('/master/costs/settings', 'PUT', { usd_brl: Number(el('costFx').value) || 5.5, cost_items: items }); msg('Custos salvos.'); await load(); } catch (e) { msg(e.message); }
    };
  }

  window.costsPage = async function costsPage() {
    month = month || lastMonths()[0];
    el('headActions').innerHTML = '<select id="costMonth" style="height:40px;border-radius:10px;border:1px solid #E5E7EB;padding:0 10px;font:inherit">' + lastMonths().map(m => '<option value="' + m + '"' + (m === month ? ' selected' : '') + '>' + monthName(m) + '</option>').join('') + '</select>';
    el('costMonth').onchange = e => { month = e.target.value; void load().catch(err => msg(err.message)); };
    await load();
  };
})();
