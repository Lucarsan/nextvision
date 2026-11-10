// Painel "Animais" (lojas do nicho pet) e prontuário de cada animal.
// - Lista com busca (nome do pet, raça, tutor, telefone) e filtros de retorno.
// - Ficha: dados do pet, tutor (pode trocar), registros (vacina, vermífugo, antipulgas, procedimento,
//   consulta, exame, anotação) com próxima dose/retorno e atendimentos da loja.
// - Avisos: retornos vencidos e próximos, com mensagem pronta no WhatsApp do tutor.
// - Cadastro de cliente: seção "Animais" para cadastrar/editar os pets junto com o tutor.
// Usa api, $, safe, openDialog, dialogHeader, feedback, storeSettings e cachedCustomers do store.js.
(() => {
  const KINDS = { vaccine: 'Vacina', deworming: 'Vermífugo', antiparasitic: 'Antipulgas / carrapatos', procedure: 'Procedimento', consult: 'Consulta', exam: 'Exame', note: 'Anotação' };
  const TITLES = {
    vaccine: ['V8', 'V10', 'Antirrábica', 'Gripe canina (tosse dos canis)', 'Giárdia', 'Leishmaniose', 'V3 felina', 'V4 felina', 'V5 felina', 'FeLV'],
    deworming: ['Vermífugo'], antiparasitic: ['Antipulgas', 'Carrapaticida', 'Coleira antiparasitária'],
    procedure: ['Castração', 'Limpeza de tártaro', 'Curativo', 'Retirada de pontos', 'Microchip'],
    consult: ['Consulta', 'Retorno'], exam: ['Hemograma', 'Bioquímico', 'Ultrassom', 'Raio-X', 'Parasitológico'], note: ['Observação']
  };
  const NEXT_DAYS = { vaccine: 365, deworming: 90, antiparasitic: 30 };
  const SPECIES = ['Cão', 'Gato', 'Outro'], SIZES = ['Mini', 'Pequeno', 'Médio', 'Grande', 'Gigante'];
  const breeds = () => (FP.niche('pet').fields.find(f => f.key === 'breed') || {}).list || [];
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const dmy = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '';
  const age = iso => {
    if (!iso) return ''; const b = new Date(String(iso).slice(0, 10) + 'T12:00:00'), n = new Date();
    let m = (n.getFullYear() - b.getFullYear()) * 12 + n.getMonth() - b.getMonth(); if (n.getDate() < b.getDate()) m--;
    return m < 0 ? '' : m < 12 ? `${m} ${m === 1 ? 'mês' : 'meses'}` : `${Math.floor(m / 12)} ${Math.floor(m / 12) === 1 ? 'ano' : 'anos'}`;
  };
  const dueState = iso => { if (!iso) return ''; const d = String(iso).slice(0, 10), t = today(); return d < t ? 'late' : d <= addDays(t, 30) ? 'soon' : 'ok'; };
  const dueBadge = iso => { const s = dueState(iso); return s ? `<span class="fp-due fp-due-${s}">${s === 'late' ? 'venceu ' : 'retorno '}${dmy(iso)}</span>` : ''; };
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const opts = (list, cur) => list.map(v => `<option${v === cur ? ' selected' : ''}>${safe(v)}</option>`).join('');
  const petSummary = p => [p.species, p.breed, p.size ? 'porte ' + p.size : '', p.sex === 'F' ? 'fêmea' : p.sex === 'M' ? 'macho' : '', age(p.birth_date)].filter(Boolean).join(' · ');
  const waLink = (phone, text) => { let d = String(phone || '').replace(/\D/g, ''); if (!d) return ''; if (d.length <= 11) d = '55' + d; return `https://wa.me/${d}?text=${encodeURIComponent(text)}`; };

  // ---------- campos do pet (usados no cadastro de cliente e na ficha) ----------
  function petFields(p = {}, k = '') {
    const f = (name, label, input) => `<label class="nv-field">${label}${input}</label>`;
    const v = n => safe(p[n] ?? '');
    return `<div class="nv-form-grid fp-pet-grid">
      ${f('name', 'Nome do animal', `<input name="${k}name" value="${v('name')}" maxlength="80" required autocomplete="off">`)}
      ${f('species', 'Espécie', `<select name="${k}species"><option value=""></option>${opts(SPECIES.concat(p.species && !SPECIES.includes(p.species) ? [p.species] : []), p.species)}</select>`)}
      ${f('breed', 'Raça', `<input name="${k}breed" value="${v('breed')}" maxlength="80" list="fpBreeds" autocomplete="off">`)}
      ${f('size', 'Porte', `<select name="${k}size"><option value=""></option>${opts(SIZES, p.size)}</select>`)}
      ${f('sex', 'Sexo', `<select name="${k}sex"><option value=""></option><option value="M"${p.sex === 'M' ? ' selected' : ''}>Macho</option><option value="F"${p.sex === 'F' ? ' selected' : ''}>Fêmea</option></select>`)}
      ${f('birth_date', 'Nascimento', `<input type="date" name="${k}birth_date" value="${p.birth_date ? String(p.birth_date).slice(0, 10) : ''}">`)}
      ${f('weight_kg', 'Peso (kg)', `<input name="${k}weight_kg" inputmode="decimal" value="${p.weight_kg ? String(p.weight_kg).replace('.', ',') : ''}" maxlength="7">`)}
      ${f('color', 'Cor', `<input name="${k}color" value="${v('color')}" maxlength="60">`)}
      ${f('neutered', 'Castrado', `<select name="${k}neutered"><option value=""></option><option value="1"${p.neutered === true ? ' selected' : ''}>Sim</option><option value="0"${p.neutered === false ? ' selected' : ''}>Não</option></select>`)}
      ${f('coat', 'Pelagem', `<input name="${k}coat" value="${v('coat')}" maxlength="20" placeholder="Ex.: curta, longa">`)}
      ${f('temperament', 'Temperamento', `<input name="${k}temperament" value="${v('temperament')}" maxlength="40" placeholder="Ex.: dócil, agitado, morde">`)}
    </div><label class="nv-field">Observações (alergias, cuidados)<textarea name="${k}notes" rows="2" maxlength="2000">${v('notes')}</textarea></label>`;
  }
  function readPet(form, k = '') {
    const g = n => (form.elements[k + n]?.value || '').trim();
    const w = parseFloat(g('weight_kg').replace(',', '.'));
    return { name: g('name'), species: g('species'), breed: g('breed'), size: g('size'), sex: g('sex'), birth_date: g('birth_date'), color: g('color'),
      coat: g('coat'), temperament: g('temperament'), notes: g('notes'), weight_kg: w > 0 ? w : null, neutered: g('neutered') === '' ? null : g('neutered') === '1' };
  }
  const breedList = () => document.getElementById('fpBreeds') ? '' : `<datalist id="fpBreeds">${breeds().map(b => `<option value="${safe(b)}">`).join('')}</datalist>`;

  // ---------- seção "Animais" dentro do cadastro/edição de cliente ----------
  // Devolve { html, bind(form), save(customerId) }.
  function customerPetsEditor(existing = []) {
    let n = 0; const removed = new Set();
    const block = (p, key) => `<fieldset class="fp-pet-block" data-pet-block="${key}"${p.id ? ` data-pet-id="${safe(p.id)}"` : ''}><legend>${p.id ? safe(p.name) : 'Novo animal'}</legend>${petFields(p, key + '_')}<button type="button" class="nv-button secondary fp-pet-remove" data-pet-remove="${key}">${FPIcon('trash')}${p.id ? 'Remover este animal' : 'Descartar'}</button></fieldset>`;
    const html = `<section class="fp-pets-editor"><h3>${FPIcon('paw')}Animais</h3>${breedList()}<div data-pets-list>${existing.map(p => block(p, 'p' + (n++))).join('')}</div>
      <button type="button" class="nv-button secondary" data-pet-add>${FPIcon('plus')}Adicionar animal</button><p class="nv-help">Opcional. Você também pode cadastrar depois, em Animais.</p></section>`;
    return {
      html,
      bind(form) {
        form.querySelector('[data-pet-add]').onclick = () => { const key = 'p' + (n++); form.querySelector('[data-pets-list]').insertAdjacentHTML('beforeend', block({}, key)); form.querySelector(`[name="${key}_name"]`).focus(); };
        form.addEventListener('click', e => {
          const b = e.target.closest('[data-pet-remove]'); if (!b) return; const fs = form.querySelector(`[data-pet-block="${b.dataset.petRemove}"]`);
          if (fs.dataset.petId) { if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.lastChild.textContent = 'Clique de novo para remover'; return; } removed.add(fs.dataset.petId); }
          fs.remove();
        });
      },
      async save(form, customerId) {
        for (const fs of form.querySelectorAll('[data-pet-block]')) {
          const pet = readPet(form, fs.dataset.petBlock + '_'); if (!pet.name) continue;
          if (fs.dataset.petId) await api('/pets/' + fs.dataset.petId, 'PATCH', pet); else await api('/customers/' + customerId + '/pets', 'POST', pet);
        }
        for (const id of removed) await api('/pets/' + id, 'DELETE');
      }
    };
  }

  // ---------- painel Animais ----------
  let pets = [], filter = 'all', search = '';
  async function load(box, alive) {
    const [list, due] = await Promise.all([api('/pets'), api('/pet-records/due?days=30')]); if (!alive()) return;
    pets = list;
    const late = due.filter(r => dueState(r.next_date) === 'late').length;
    box.innerHTML = `<section class="nv-card"><div class="nv-heading"><h2>Animais</h2><button class="nv-button" id="fpNewPet">+ Cadastrar animal</button></div>
      <div class="nv-heading"><input id="fpPetSearch" type="search" placeholder="Pesquisar por animal, raça, tutor ou telefone" aria-label="Pesquisar animais" value="${safe(search)}"><span id="fpPetCount" class="nv-help"></span></div>
      <div class="fp-chips" role="group" aria-label="Filtro">${[['all', 'Todos'], ['due', `Retornos em 30 dias (${due.length})`], ['late', `Vencidos (${late})`]].map(([k, l]) => `<button type="button" class="fp-chip${filter === k ? ' on' : ''}" data-pet-filter="${k}">${l}</button>`).join('')}</div>
      <div id="fpPetList" class="nv-customer-list"></div></section>
      <section class="nv-card"><div class="nv-heading"><h2>Avisos de retorno</h2><span class="nv-help">vencidos e próximos 30 dias</span></div><div id="fpDue">${dueList(due)}</div></section>`;
    $('fpPetSearch').oninput = e => { search = e.target.value; draw(); };
    box.querySelectorAll('[data-pet-filter]').forEach(b => b.onclick = () => { filter = b.dataset.petFilter; box.querySelectorAll('[data-pet-filter]').forEach(x => x.classList.toggle('on', x === b)); draw(); });
    $('fpNewPet').onclick = () => newPet(() => load(box, alive));
    draw();
  }
  function dueList(due) {
    if (!due.length) return '<p class="nv-help">Nenhum retorno vencido ou nos próximos 30 dias.</p>';
    const store = storeSettings.name || 'a loja';
    return `<div class="fp-due-list">${due.map(r => {
      const late = dueState(r.next_date) === 'late';
      const text = `Olá, ${String(r.customer_name || '').split(' ')[0]}! Aqui é da ${store}. ${late ? 'Passou a data' : 'Está chegando a data'} de ${KINDS[r.kind] === 'Vacina' ? 'vacina' : 'retorno'} do(a) ${r.pet_name}: ${r.title}, ${late ? 'que venceu em' : 'em'} ${dmy(r.next_date)}. Quer agendar?`;
      const wa = waLink(r.customer_phone, text);
      return `<article class="fp-due-row"><div><strong><button type="button" class="fp-linkbtn" data-open-pet="${safe(r.pet_id)}">${safe(r.pet_name)}</button></strong> · ${safe(r.title)} ${dueBadge(r.next_date)}<br><small>${safe(r.customer_name)}${r.customer_phone ? ' · ' + safe(r.customer_phone) : ''}</small></div>
        <div class="nv-row">${wa ? `<a class="nv-button secondary" href="${safe(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}<button type="button" class="nv-button secondary" data-record-done="${safe(r.id)}" title="Marcar como resolvido">Resolvido</button></div></article>`;
    }).join('')}</div>`;
  }
  function draw() {
    const box = $('fpPetList'); if (!box) return;
    const qn = norm(search.trim()), digits = search.replace(/\D/g, '');
    const list = pets.filter(p => (!qn || [p.name, p.breed, p.species, p.customer_name].some(v => norm(v).includes(qn)) || (digits.length >= 3 && String(p.customer_phone || '').replace(/\D/g, '').includes(digits)))
      && (filter === 'all' || (filter === 'late' ? dueState(p.next_due) === 'late' : ['late', 'soon'].includes(dueState(p.next_due)))));
    $('fpPetCount').textContent = `${list.length} de ${pets.length} animais`;
    const shown = list.slice(0, 200);
    box.innerHTML = shown.map(p => `<article class="nv-customer-row"><div class="nv-customer-avatar fp-pet-avatar">${FPIcon('paw')}</div><div class="nv-customer-info"><h3><button type="button" class="fp-linkbtn" data-open-pet="${safe(p.id)}">${safe(p.name)}</button> ${dueBadge(p.next_due)}</h3><p>${safe(petSummary(p))}</p><p>Tutor: <button type="button" class="fp-linkbtn" data-history-customer="${safe(p.customer_id)}">${safe(p.customer_name)}</button>${p.customer_phone ? ' · ' + safe(p.customer_phone) : ''}</p></div><div class="nv-customer-actions"><button class="nv-button secondary" data-open-pet="${safe(p.id)}">Ficha</button></div></article>`).join('')
      + (list.length > shown.length ? `<p class="nv-help">Mostrando 200 de ${list.length}. Pesquise pelo nome para encontrar os demais.</p>` : '')
      || '<p class="nv-help">Nenhum animal encontrado.</p>';
  }

  // ---------- ficha do pet ----------
  async function openPet(id) {
    const p = await api('/pets/' + id);
    const recs = p.records.map(r => `<li class="fp-rec"><div><span class="fp-rec-kind">${safe(KINDS[r.kind] || r.kind)}</span> <strong>${safe(r.title)}</strong> · ${dmy(r.record_date)}${r.next_date ? (r.done_next ? ` <span class="fp-due fp-due-ok">próxima ${dmy(r.next_date)} ✓</span>` : ' ' + dueBadge(r.next_date).replace('retorno', 'próxima')) : ''}${r.notes ? `<br><small>${safe(r.notes)}</small>` : ''}</div><div class="nv-row"><button type="button" class="nv-button secondary" data-record-edit="${safe(r.id)}">Editar</button></div></li>`).join('');
    const orders = p.orders.map(o => `<li>${dmy(o.created_at)} · ${safe(o.service || o.process || 'Atendimento')} · ${o.status === 'completed' ? 'concluído' : o.status === 'live' ? 'em andamento' : o.status === 'paused' ? 'pausado' : 'na fila'}</li>`).join('');
    openDialog(`${dialogHeader(FPIcon('paw') + safe(p.name))}<div class="fp-pet-card">
      <p class="fp-pet-sum">${safe(petSummary(p)) || 'Sem dados do animal'}${p.weight_kg ? ' · ' + String(p.weight_kg).replace('.', ',') + ' kg' : ''}${p.color ? ' · ' + safe(p.color) : ''}${p.neutered ? ' · castrado' : ''}</p>
      ${p.notes ? `<p class="fp-pet-notes">${safe(p.notes)}</p>` : ''}
      <p>Tutor: <button type="button" class="fp-linkbtn" data-history-customer="${safe(p.customer_id)}">${safe(p.customer_name)}</button>${p.customer_phone ? ' · ' + safe(p.customer_phone) : ''}</p>
      <div class="nv-row"><button type="button" class="nv-button secondary" id="fpPetEdit">Editar dados</button><button type="button" class="nv-button" id="fpRecAdd">+ Registrar vacina, procedimento…</button></div>
      <div id="fpRecForm"></div>
      <h3>Prontuário</h3>${recs ? `<ul class="fp-rec-list">${recs}</ul>` : '<p class="nv-help">Nenhum registro ainda.</p>'}
      ${orders ? `<h3>Atendimentos na loja</h3><ul class="fp-orders">${orders}</ul>` : ''}</div>`);
    $('fpRecAdd').onclick = () => recordForm(p);
    $('fpPetEdit').onclick = () => editPet(p);
    document.querySelectorAll('[data-record-edit]').forEach(b => b.onclick = () => recordForm(p, p.records.find(r => r.id === b.dataset.recordEdit)));
  }
  function recordForm(pet, r = null) {
    const box = $('fpRecForm'); const kind = r?.kind || 'vaccine';
    box.innerHTML = `<form id="fpRec" class="fp-rec-form" autocomplete="off"><div class="nv-form-grid">
      <label class="nv-field">Tipo<select name="kind">${Object.entries(KINDS).map(([k, l]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="nv-field">O que foi feito<input name="title" maxlength="120" required list="fpRecTitles" value="${safe(r?.title || '')}" placeholder="Ex.: V10, Castração"></label><datalist id="fpRecTitles"></datalist>
      <label class="nv-field">Data<input type="date" name="record_date" required value="${r ? String(r.record_date).slice(0, 10) : today()}"></label>
      <label class="nv-field">Próxima dose / retorno<input type="date" name="next_date" value="${r?.next_date ? String(r.next_date).slice(0, 10) : ''}"></label></div>
      <div class="nv-row fp-quick-next"><span class="nv-help">Retorno em:</span>${[[21, '21 dias'], [30, '30 dias'], [90, '3 meses'], [365, '1 ano']].map(([d, l]) => `<button type="button" class="fp-chip" data-next="${d}">${l}</button>`).join('')}<button type="button" class="fp-chip" data-next="0">sem retorno</button></div>
      <label class="nv-field">Observações<textarea name="notes" rows="2" maxlength="2000" placeholder="Lote, laboratório, veterinário, reação…">${safe(r?.notes || '')}</textarea></label>
      ${r?.next_date ? `<label class="nv-check"><input type="checkbox" name="done_next"${r.done_next ? ' checked' : ''}> Retorno já resolvido</label>` : ''}
      <div class="nv-row"><button class="nv-button">${r ? 'Salvar' : 'Registrar'}</button>${r ? '<button type="button" class="nv-button secondary fp-danger" id="fpRecDel">Excluir</button>' : ''}<button type="button" class="nv-button secondary" id="fpRecCancel">Cancelar</button></div><p role="status"></p></form>`;
    const f = $('fpRec');
    const titles = () => { $('fpRecTitles').innerHTML = (TITLES[f.elements.kind.value] || []).map(t => `<option value="${safe(t)}">`).join(''); };
    const suggestNext = () => { const d = NEXT_DAYS[f.elements.kind.value]; if (!r && d && f.elements.record_date.value) f.elements.next_date.value = addDays(f.elements.record_date.value, d); };
    titles(); suggestNext();
    f.elements.kind.onchange = () => { titles(); if (!r) { f.elements.next_date.value = ''; suggestNext(); } };
    f.elements.record_date.onchange = suggestNext;
    f.querySelectorAll('[data-next]').forEach(b => b.onclick = () => { const d = +b.dataset.next; f.elements.next_date.value = d ? addDays(f.elements.record_date.value || today(), d) : ''; });
    $('fpRecCancel').onclick = () => { box.innerHTML = ''; };
    if ($('fpRecDel')) $('fpRecDel').onclick = async e => { const b = e.currentTarget; if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Clique de novo para excluir'; return; } await api('/pet-records/' + r.id, 'DELETE'); await afterChange(pet.id); };
    f.onsubmit = async e => {
      e.preventDefault(); const g = n => f.elements[n]?.value.trim() || '';
      const body = { kind: g('kind'), title: g('title'), record_date: g('record_date'), next_date: g('next_date') || null, notes: g('notes') };
      if (r?.next_date) body.done_next = !!f.elements.done_next?.checked;
      try { await api(r ? '/pet-records/' + r.id : '/pets/' + pet.id + '/records', r ? 'PATCH' : 'POST', body); await afterChange(pet.id); feedback(r ? 'Registro atualizado.' : 'Registro salvo no prontuário.'); }
      catch (error) { f.querySelector('[role="status"]').textContent = error.message; }
    };
    f.elements.title.focus();
  }
  async function afterChange(petId) {
    await openPet(petId);
    if (activeView === 'pets') { pets = await api('/pets'); const due = await api('/pet-records/due?days=30'); const d = $('fpDue'); if (d) d.innerHTML = dueList(due); draw(); }
  }
  function ownerPicker(form, currentId) {
    const box = form.querySelector('[data-owner]');
    const picker = FP.customerPicker(box, cachedCustomers.slice(), () => {}, { placeholder: 'Buscar tutor por nome, telefone ou nome do pet' });
    const cur = cachedCustomers.find(c => c.id === currentId); if (cur) picker.pick(cur);
    return () => box.querySelector('[name="customer_id"]').value;
  }
  async function ensureCustomers() { if (!cachedCustomers.length) cachedCustomers = await api('/customers'); }
  async function editPet(p) {
    await ensureCustomers();
    openDialog(`${dialogHeader('Editar ' + safe(p.name))}<form id="fpPetForm" autocomplete="off">${breedList()}<div class="nv-field"><span>Tutor</span><div data-owner></div></div>${petFields(p)}
      <div class="nv-row"><button class="nv-button">Salvar</button><button type="button" class="nv-button secondary" id="fpPetBack">Voltar</button><button type="button" class="nv-button secondary fp-danger" id="fpPetDel">Excluir animal</button></div><p role="status"></p></form>`);
    const f = $('fpPetForm'); const owner = ownerPicker(f, p.customer_id);
    $('fpPetBack').onclick = () => openPet(p.id);
    $('fpPetDel').onclick = async e => { const b = e.currentTarget; if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Clique de novo para excluir'; return; } await api('/pets/' + p.id, 'DELETE'); $('editorDialog').close(); await refresh(); feedback('Animal excluído.'); };
    f.onsubmit = async e => {
      e.preventDefault(); const customer_id = owner();
      if (!customer_id) { f.querySelector('[role="status"]').textContent = 'Escolha o tutor.'; return; }
      try { await api('/pets/' + p.id, 'PATCH', { ...readPet(f), customer_id }); await refresh(); await openPet(p.id); feedback('Dados do animal salvos.'); }
      catch (error) { f.querySelector('[role="status"]').textContent = error.message; }
    };
  }
  async function newPet(done, customerId = '') {
    await ensureCustomers();
    openDialog(`${dialogHeader('Cadastrar animal')}<form id="fpPetForm" autocomplete="off">${breedList()}<div class="nv-field"><span>Tutor</span><div data-owner></div><p class="nv-help">Não achou? <button type="button" class="fp-linkbtn" id="fpNewOwner">Cadastrar novo tutor</button></p></div><div id="fpOwnerNew" hidden></div>${petFields({})}
      <div class="nv-row"><button class="nv-button">Cadastrar animal</button><button type="button" class="nv-button secondary" data-close-dialog>Cancelar</button></div><p role="status"></p></form>`);
    const f = $('fpPetForm'); const owner = ownerPicker(f, customerId); let newOwner = false;
    $('fpNewOwner').onclick = () => { newOwner = true; f.querySelector('[data-owner]').closest('.nv-field').hidden = true; const b = $('fpOwnerNew'); b.hidden = false; b.innerHTML = '<h3>Novo tutor</h3>' + FP.customerFields({}, 'owner_'); b.querySelector('[name="owner_name"]').focus(); };
    f.onsubmit = async e => {
      e.preventDefault(); const st = f.querySelector('[role="status"]');
      try {
        let customer_id = newOwner ? '' : owner();
        if (newOwner) { const c = await api('/customers', 'POST', FP.readCustomer(f, 'owner_')); customer_id = c.id; }
        if (!customer_id) { st.textContent = 'Escolha o tutor ou cadastre um novo.'; return; }
        const p = await api('/customers/' + customer_id + '/pets', 'POST', readPet(f));
        await refresh(); feedback('Animal cadastrado.'); if (done) await done(); await openPet(p.id);
      } catch (error) { st.textContent = error.message; }
    };
  }
  async function refresh() {
    cachedCustomers = await api('/customers');
    if (activeView === 'customers' && typeof drawCustomers === 'function') drawCustomers();
    if (activeView === 'pets') { pets = await api('/pets'); draw(); }
  }

  document.addEventListener('click', async e => {
    const open = e.target.closest('[data-open-pet]'); const done = e.target.closest('[data-record-done]');
    try {
      if (open) { e.preventDefault(); await openPet(open.dataset.openPet); }
      else if (done) {
        const all = await api('/pet-records/due?days=30'); const r = all.find(x => x.id === done.dataset.recordDone); if (!r) return;
        await api('/pet-records/' + r.id, 'PATCH', { kind: r.kind, title: r.title, record_date: String(r.record_date).slice(0, 10), next_date: String(r.next_date).slice(0, 10), notes: r.notes || '', done_next: true });
        const fresh = await api('/pet-records/due?days=30'); const d = $('fpDue'); if (d) d.innerHTML = dueList(fresh); pets = await api('/pets'); draw(); feedback('Retorno marcado como resolvido.');
      }
    } catch (error) { feedback(error.message, true); }
  });

  window.FPPets = { load, openPet, newPet, customerPetsEditor, enabled: () => window.__fpNiche === 'pet' };
})();
