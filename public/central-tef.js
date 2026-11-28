// Central → Redes: TEF Stone (AutoTEF) por unidade.
// Modos: desligado (como hoje), simulador (pinpad de mentira, para treinar; nunca vira NFC-e),
// teste Stone (sandbox, Stone Code de teste) e produção. Usa os utilitários globais do app.js: api, el, safe.
(() => {
  const MODES = { off: 'Desligado (maquininha avulsa)', simulator: 'Simulador (treino, não cobra)', sandbox: 'Teste Stone (sandbox)', production: 'Produção' };
  const ST = { pending: 'Aguardando', approved: 'Aprovada', declined: 'Recusada', error: 'Erro', expired: 'Expirada', unknown: 'Sem resposta', reversed: 'Estornada' };
  const brl = c => 'R$ ' + (c / 100).toFixed(2).replace('.', ',');
  window.tefCard = function tefCard(box, units) {
    if (!box) return;
    if (!units.length) { box.innerHTML = '<h2>Pinpad Stone (TEF)</h2><p class="ct-muted">Ligue uma unidade à rede primeiro.</p>'; return; }
    // Lojas com caixa fora de qualquer rede (ex.: Loja teste) também aparecem, para testes e homologação da Stone.
    let extra = [];
    let unitId = sessionStorage.getItem('tef_unit') || units[0].id;
    const all = () => units.concat(extra);
    async function start() {
      try { extra = (await api('/master/tenants')).filter(t => t.sales_enabled && !t.network_id && !units.some(u => u.id === t.id)); } catch { extra = []; }
      if (!all().some(u => u.id === unitId)) unitId = units[0].id;
      load();
    }
    const opt = u => '<option value="' + safe(u.id) + '"' + (u.id === unitId ? ' selected' : '') + '>' + safe(u.unit_label || u.name) + '</option>';
    async function load() {
      box.innerHTML = '<h2>Pinpad Stone (TEF)</h2><p class="ct-muted">Carregando…</p>';
      let t; try { t = await api('/master/tenants/' + unitId + '/tef'); } catch (e) { box.innerHTML = '<h2>Pinpad Stone (TEF)</h2><p class="ct-muted">' + safe(e.message) + '</p>'; return; }
      box.innerHTML = '<h2>Pinpad Stone (TEF)</h2>'
        + '<p class="ct-muted">O caixa do quiosque manda o valor para o pinpad pelo programa AutoTEF (Slim) instalado no computador da loja. Sandbox e produção pedem o Stone Code da conta da unidade (o de teste é diferente do de produção).</p>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:8px 0">'
        + '<label>Unidade<select id="tfUnit">' + units.map(opt).join('') + (extra.length ? '<optgroup label="Fora da rede (testes)">' + extra.map(opt).join('') + '</optgroup>' : '') + '</select></label>'
        + '<label>Modo<select id="tfMode">' + Object.entries(MODES).map(([k, l]) => '<option value="' + k + '"' + (t.mode === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>'
        + '<label>Stone Code<input id="tfCode" value="' + safe(t.stone_code || '') + '" inputmode="numeric" style="width:130px"></label>'
        + '<label>Porta do pinpad<input id="tfPort" value="' + safe(t.pinpad_port || '') + '" placeholder="automática" style="width:110px"></label>'
        + '<label>Endereço do Slim<input id="tfUrl" value="' + safe(t.local_url || '') + '" placeholder="http://127.0.0.1:8000" style="width:190px"></label>'
        + '<button type="button" class="ct-btn" id="tfSave">Salvar</button></div>'
        + '<p class="ct-muted" style="margin:4px 0 0">Nome da aplicação (Partner name): <b>' + safe(t.partner_name || 'FICOUPRONTO 1.0') + '</b></p>'
        + (t.last.length ? '<p class="ct-muted" style="margin:6px 0 0">Últimas cobranças: ' + t.last.map(x => safe(ST[x.status] || x.status) + ' ' + brl(x.amount_cents) + (x.mode === 'simulator' ? ' (simulador)' : '')).join(' · ') + '</p>' : '')
        + '<p id="tfMsg" class="ct-muted" style="min-height:1.2em;margin-top:8px"></p>';
      el('tfUnit').onchange = e => { unitId = e.target.value; sessionStorage.setItem('tef_unit', unitId); load(); };
      el('tfSave').onclick = async () => {
        el('tfMsg').textContent = 'Aguarde…';
        try {
          await api('/master/tenants/' + unitId + '/tef', 'PATCH', { mode: el('tfMode').value, stone_code: el('tfCode').value.trim() || null, pinpad_port: el('tfPort').value.trim() || null, local_url: el('tfUrl').value.trim() || null });
          await load(); el('tfMsg').textContent = 'Salvo. O caixa da unidade passa a usar na próxima vez que abrir.';
        } catch (e) { el('tfMsg').textContent = e.message; el('tfMsg').style.color = '#b42318'; }
      };
    }
    start();
  };
})();
