// Central → Redes: emissor de NFC-e (ACBr API) por unidade, só homologação.
// Dados do emitente, cadastro na ACBr, certificado A1 (repassado, não gravado), QR Code/CSC e cupom de teste.
// Usa os utilitários globais do app.js: api, el, safe.
(() => {
  const ST = { authorized: 'Autorizado', rejected: 'Rejeitado', processing: 'Aguardando', error: 'Erro (não transmitido)', canceled: 'Cancelado' };
  const PAY = { '01': 'Dinheiro', '03': 'Crédito', '04': 'Débito', '17': 'Pix' };
  const when = d => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const b64 = file => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => no(Error('Não consegui ler o arquivo')); r.readAsDataURL(file); });

  window.acbrCard = function acbrCard(box, units) {
    if (!box) return;
    if (!units.length) { box.innerHTML = '<h2>Emissor de NFC-e (ACBr)</h2><p class="ct-muted">Ligue uma unidade à rede primeiro.</p>'; return; }
    let unitId = sessionStorage.getItem('acbr_unit') || units[0].id;
    if (!units.some(u => u.id === unitId)) unitId = units[0].id;
    const say = (t, bad) => { const m = el('acbrMsg'); if (m) { m.textContent = t; m.style.color = bad ? '#b42318' : ''; } };
    const run = fn => async () => { say('Aguarde…'); try { const t = await fn(); say(t || ''); } catch (e) { say(e.message, true); } };

    async function load() {
      box.innerHTML = '<h2>Emissor de NFC-e (ACBr) · homologação</h2><p class="ct-muted">Carregando…</p>';
      let s; try { s = await api('/master/tenants/' + unitId + '/acbr'); } catch (e) { box.innerHTML = '<h2>Emissor de NFC-e (ACBr)</h2><p class="ct-muted">' + safe(e.message) + '</p>'; return; }
      const f = s.fiscal, a = f.fiscal_address || {}, cert = s.certificate && !s.certificate.error ? s.certificate : null;
      const ok = (yes, t) => '<li>' + (yes ? '✅ ' : '⬜ ') + t + '</li>';
      box.innerHTML = '<h2>Emissor de NFC-e (ACBr) · homologação</h2>'
        + '<p class="ct-muted">Teste sem valor fiscal e sem gastar crédito. Produção fica para depois do teste aprovado.</p>'
        + '<label>Unidade<select id="acbrUnit">' + units.map(u => '<option value="' + safe(u.id) + '"' + (u.id === unitId ? ' selected' : '') + '>' + safe(u.unit_label || u.name) + '</option>').join('') + '</select></label>'
        + '<ul style="list-style:none;padding:0;margin:10px 0;line-height:1.7">'
        + ok(s.configured, 'Credenciais da ACBr no servidor' + (s.configured ? ' (' + safe(s.environment) + ')' : ': falta ACBR_CLIENT_ID e ACBR_CLIENT_SECRET no Render'))
        + ok(!s.problems.length, 'Dados do emitente' + (s.problems.length ? ': ' + safe(s.problems.join('; ')) : ''))
        + ok(!!s.company, 'Empresa cadastrada na ACBr')
        + ok(!!cert, 'Certificado A1' + (cert?.not_valid_after ? ' (vence ' + new Date(cert.not_valid_after).toLocaleDateString('pt-BR') + ')' : ''))
        + ok(!!s.nfce && !s.nfce.error, 'NFC-e configurada' + (s.nfce?.sefaz ? ' (' + (Number(s.nfce.sefaz.id_csc) ? 'QR Code v2, CSC ' + safe(s.nfce.sefaz.id_csc) : 'QR Code v3, sem CSC') + ')' : ''))
        + '</ul>' + (s.error ? '<p style="color:#b42318">' + safe(s.error) + '</p>' : '')
        + '<details' + (s.problems.length ? ' open' : '') + '><summary><b>1. Dados do emitente</b></summary><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:8px 0">'
        + '<label>CNPJ<input value="' + safe(f.cnpj || '') + '" disabled style="width:150px"></label>'
        + '<label>Razão social<input id="acLegal" value="' + safe(f.legal_name || '') + '" style="width:260px"></label>'
        + '<label>Inscrição estadual<input id="acIe" value="' + safe(f.state_registration || '') + '" style="width:130px"></label>'
        + '<label>Terminal (idTermPag)<input id="acTerm" value="' + safe(f.payment_terminal_id || '') + '" style="width:130px"></label>'
        + '<label>E-mail fiscal<input id="acEmail" type="email" value="' + safe(f.fiscal_email || '') + '" style="width:220px"></label></div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:8px 0">'
        + '<label>Logradouro<input id="acStreet" value="' + safe(a.street || '') + '" style="width:220px"></label>'
        + '<label>Número<input id="acNum" value="' + safe(a.number || '') + '" style="width:80px"></label>'
        + '<label>Complemento<input id="acCpl" value="' + safe(a.complement || '') + '" style="width:140px"></label>'
        + '<label>Bairro<input id="acDist" value="' + safe(a.district || '') + '" style="width:150px"></label>'
        + '<label>Município<select id="acCity">' + Object.entries(s.cities).map(([c, n]) => '<option value="' + c + '"' + ((a.city_code || '2304400') === c ? ' selected' : '') + '>' + safe(n) + '</option>').join('') + '</select></label>'
        + '<label>CEP<input id="acCep" value="' + safe(a.cep || '') + '" style="width:100px"></label>'
        + '<button type="button" class="ct-btn" id="acSave">Salvar dados</button></div></details>'
        + '<details><summary><b>2. Cadastrar na ACBr</b></summary><p class="ct-muted">Cria (ou atualiza) a empresa na ACBr com os dados acima.</p><button type="button" class="ct-btn" id="acCompany">' + (s.company ? 'Atualizar empresa' : 'Cadastrar empresa') + '</button></details>'
        + '<details><summary><b>3. Certificado A1</b></summary><p class="ct-muted">O arquivo e a senha vão direto para a ACBr; o FicouPronto não guarda nenhum dos dois.</p><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end"><label>Arquivo .pfx<input id="acPfx" type="file" accept=".pfx,.p12"></label><label>Senha do certificado<input id="acPwd" type="password" autocomplete="new-password" style="width:180px"></label><button type="button" class="ct-btn" id="acCert">Enviar certificado</button></div></details>'
        + '<details><summary><b>4. QR Code da NFC-e</b></summary><p class="ct-muted">Primeiro tente o QR Code v3 (sem CSC). Se a SEFAZ-CE rejeitar, informe o CSC <b>de homologação</b> (é diferente do de produção).</p><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end"><button type="button" class="ct-btn" id="acV3">Usar QR Code v3</button><label>ID do CSC<input id="acCscId" type="number" min="1" style="width:90px"></label><label>CSC<input id="acCsc" type="password" autocomplete="off" style="width:220px"></label><button type="button" class="ct-btn ghost" id="acV2">Usar CSC</button></div></details>'
        + '<details open><summary><b>5. Cupom de teste</b></summary><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:8px 0"><label>Pagamento<select id="acPay"><option value="credit">Cartão de crédito</option><option value="debit">Cartão de débito</option><option value="pix">Pix</option><option value="cash">Dinheiro</option></select></label><button type="button" class="ct-btn" id="acTest">Emitir cupom de teste</button></div>'
        + (s.tests.length ? '<div class="ct-table-wrap"><table class="ct-table"><thead><tr><th>Quando</th><th>Nº</th><th>Pagamento</th><th>Situação</th><th>Chave / motivo</th><th></th></tr></thead><tbody>'
          + s.tests.map(t => '<tr><td>' + when(t.created_at) + '</td><td>' + t.number + '</td><td>' + (PAY[t.tpag] || safe(t.tpag)) + '</td><td>' + (ST[t.status] || safe(t.status)) + '</td><td style="max-width:420px;word-break:break-all">' + safe(t.access_key || t.error || '') + '</td><td>' + (['processing', 'error'].includes(t.status) ? '<button type="button" class="ct-btn ghost acSync" data-id="' + safe(t.id) + '" style="height:30px">Consultar</button>' : '') + '</td></tr>').join('')
          + '</tbody></table></div>' : '<p class="ct-muted">Nenhum cupom de teste ainda.</p>')
        + '</details><p id="acbrMsg" class="ct-muted" style="min-height:1.2em;margin-top:8px"></p>';

      el('acbrUnit').onchange = e => { unitId = e.target.value; sessionStorage.setItem('acbr_unit', unitId); load(); };
      const reload = async t => { await load(); return t; };
      el('acSave').onclick = run(async () => {
        const city = el('acCity');
        await api('/master/tenants/' + unitId + '/fiscal', 'PATCH', { legal_name: el('acLegal').value.trim() || undefined, state_registration: el('acIe').value.trim() || undefined, payment_terminal_id: el('acTerm').value.trim() || null });
        await api('/master/tenants/' + unitId + '/fiscal-address', 'PATCH', { fiscal_email: el('acEmail').value.trim() || null, fiscal_address: { street: el('acStreet').value.trim(), number: el('acNum').value.trim() || 'S/N', complement: el('acCpl').value.trim() || null, district: el('acDist').value.trim(), city_code: city.value, city: city.options[city.selectedIndex].text, cep: el('acCep').value } });
        return reload('Dados salvos.');
      });
      el('acCompany').onclick = run(async () => { const r = await api('/master/tenants/' + unitId + '/acbr/company', 'POST'); return reload(r.created ? 'Empresa cadastrada na ACBr.' : 'Empresa atualizada na ACBr.'); });
      el('acCert').onclick = run(async () => {
        const file = el('acPfx').files[0]; if (!file) throw Error('Escolha o arquivo .pfx');
        if (!el('acPwd').value) throw Error('Informe a senha do certificado');
        const r = await api('/master/tenants/' + unitId + '/acbr/certificate', 'PUT', { certificado: await b64(file), password: el('acPwd').value });
        el('acPwd').value = ''; return reload('Certificado enviado' + (r.certificate?.not_valid_after ? ' (vence ' + new Date(r.certificate.not_valid_after).toLocaleDateString('pt-BR') + ')' : '') + '.');
      });
      el('acV3').onclick = run(async () => { await api('/master/tenants/' + unitId + '/acbr/nfce-config', 'PUT', { id_csc: 0, csc: '' }); return reload('NFC-e configurada com QR Code v3.'); });
      el('acV2').onclick = run(async () => { await api('/master/tenants/' + unitId + '/acbr/nfce-config', 'PUT', { id_csc: Number(el('acCscId').value), csc: el('acCsc').value.trim() }); el('acCsc').value = ''; return reload('NFC-e configurada com CSC.'); });
      el('acTest').onclick = run(async () => {
        const r = await api('/master/tenants/' + unitId + '/acbr/test-nfce', 'POST', { method: el('acPay').value });
        return reload('Cupom nº ' + r.number + ': ' + (ST[r.status] || r.status) + (r.error ? ' — ' + r.error : ''));
      });
      box.querySelectorAll('.acSync').forEach(b => b.onclick = run(async () => { const r = await api('/master/fiscal-documents/' + b.dataset.id + '/sync', 'POST'); return reload(r.found ? 'Situação: ' + (ST[r.status] || r.status) + (r.error ? ' — ' + r.error : '') : r.error); }));
    }
    load();
  };
})();
