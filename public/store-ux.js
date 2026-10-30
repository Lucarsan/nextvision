// Campos por nicho, sugestões de marca/modelo/raça, busca de cliente e sugestão de endereço.
// Carregado antes de store.js; expõe window.FP.
(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PHONES = {
    Apple: ['iPhone 11', 'iPhone 12', 'iPhone 12 Pro', 'iPhone 13', 'iPhone 13 Pro', 'iPhone 14', 'iPhone 14 Pro', 'iPhone 14 Pro Max', 'iPhone 15', 'iPhone 15 Pro', 'iPhone 15 Pro Max', 'iPhone 16', 'iPhone 16 Pro', 'iPhone 16 Pro Max', 'iPhone SE', 'iPad', 'MacBook Air', 'MacBook Pro'],
    Samsung: ['Galaxy A05', 'Galaxy A06', 'Galaxy A14', 'Galaxy A15', 'Galaxy A16', 'Galaxy A25', 'Galaxy A34', 'Galaxy A35', 'Galaxy A54', 'Galaxy A55', 'Galaxy M14', 'Galaxy M15', 'Galaxy M34', 'Galaxy M35', 'Galaxy M55', 'Galaxy S23', 'Galaxy S23 FE', 'Galaxy S24', 'Galaxy S24 FE', 'Galaxy S24 Ultra', 'Galaxy Z Flip', 'Galaxy Tab A9'],
    Motorola: ['Moto E13', 'Moto E14', 'Moto G04', 'Moto G05', 'Moto G14', 'Moto G24', 'Moto G34', 'Moto G35', 'Moto G54', 'Moto G55', 'Moto G75', 'Moto G84', 'Moto G85', 'Edge 40', 'Edge 40 Neo', 'Edge 50', 'Edge 50 Fusion', 'Razr 40', 'Razr 50'],
    Xiaomi: ['Redmi 12', 'Redmi 13', 'Redmi 13C', 'Redmi 14C', 'Redmi A3', 'Redmi Note 12', 'Redmi Note 13', 'Redmi Note 13 Pro', 'Redmi Note 14', 'Poco C65', 'Poco M6', 'Poco X6', 'Poco X6 Pro', 'Poco X7', 'Xiaomi 14T'],
    Realme: ['C53', 'C55', 'C61', 'C67', 'Note 50', 'Realme 12', 'Realme 12 Pro'],
    LG: ['K41S', 'K52', 'K62', 'Velvet', 'Monitor', 'TV'],
    Asus: ['Zenfone', 'ROG Phone', 'Vivobook', 'Zenbook'],
    Lenovo: ['IdeaPad', 'ThinkPad', 'Tab M10'],
    Dell: ['Inspiron', 'Vostro', 'Latitude'],
    HP: ['Pavilion', '250 G9', 'ProBook'],
    Acer: ['Aspire 5', 'Nitro 5'],
    Positivo: ['Motion', 'Vision', 'Twist'],
    Multilaser: ['Ultra', 'Legacy'],
    Sony: ['PlayStation 4', 'PlayStation 5', 'Xperia'],
    Microsoft: ['Xbox One', 'Xbox Series S', 'Xbox Series X', 'Surface'],
    Nintendo: ['Switch', 'Switch Lite', 'Switch OLED'],
    Nokia: ['C12', 'C22', 'G21']
  };
  const CARS = {
    Fiat: ['Mobi', 'Argo', 'Cronos', 'Strada', 'Toro', 'Pulse', 'Fastback', 'Uno', 'Palio', 'Siena', 'Fiorino'],
    Volkswagen: ['Gol', 'Polo', 'Virtus', 'T-Cross', 'Nivus', 'Saveiro', 'Voyage', 'Fox', 'Amarok', 'Taos'],
    Chevrolet: ['Onix', 'Onix Plus', 'Tracker', 'S10', 'Spin', 'Montana', 'Prisma', 'Celta', 'Cruze'],
    Toyota: ['Corolla', 'Corolla Cross', 'Hilux', 'Yaris', 'Etios', 'SW4'],
    Hyundai: ['HB20', 'HB20S', 'Creta', 'Tucson'],
    Renault: ['Kwid', 'Sandero', 'Logan', 'Duster', 'Oroch', 'Captur'],
    Honda: ['Civic', 'City', 'Fit', 'HR-V', 'WR-V', 'CG 160', 'Biz', 'Pop 110i', 'CB 300F', 'XRE 300'],
    Jeep: ['Renegade', 'Compass', 'Commander'],
    Ford: ['Ka', 'Fiesta', 'EcoSport', 'Ranger', 'Territory'],
    Nissan: ['Kicks', 'Versa', 'Frontier', 'March'],
    Peugeot: ['208', '2008', '3008'],
    'Citroën': ['C3', 'C4 Cactus', 'C3 Aircross'],
    Yamaha: ['Fazer 250', 'Factor 150', 'Lander 250', 'NMax', 'XTZ 150'],
    BYD: ['Dolphin', 'Dolphin Mini', 'Song Plus', 'Seal']
  };
  const BREEDS = ['Sem raça definida (SRD)', 'Shih Tzu', 'Poodle', 'Lhasa Apso', 'Yorkshire', 'Spitz Alemão', 'Maltês', 'Pinscher', 'Golden Retriever', 'Labrador', 'Bulldog Francês', 'Pug', 'Border Collie', 'Pastor Alemão', 'Rottweiler', 'Pitbull', 'Dachshund', 'Beagle', 'Chow Chow', 'Siamês', 'Persa', 'Maine Coon'];
  const COLORS = ['Branco', 'Preto', 'Prata', 'Cinza', 'Vermelho', 'Azul', 'Marrom', 'Bege', 'Verde', 'Amarelo'];
  const opts = list => list.map(v => `<option value="${esc(v)}">`).join('');
  // Campos do item por nicho. "key" é a chave gravada em orders.details.
  const NICHES = {
    electronics: { noun: 'aparelho', itemType: 'device', fields: [
      { key: 'device_kind', label: 'Tipo de aparelho', list: ['Celular', 'Tablet', 'Notebook', 'Computador', 'Videogame', 'Smartwatch', 'Outro'] },
      { key: 'brand', label: 'Marca', list: Object.keys(PHONES) },
      { key: 'model', label: 'Modelo', dependsOn: 'brand', lists: PHONES }] },
    automotive: { noun: 'veículo', itemType: 'vehicle', fields: [
      { key: 'brand', label: 'Marca', list: Object.keys(CARS) }, { key: 'model', label: 'Modelo', dependsOn: 'brand', lists: CARS },
      { key: 'identifier', label: 'Placa', upper: true }, { key: 'color', label: 'Cor', list: COLORS }] },
    pet: { noun: 'pet', itemType: 'pet', fields: [
      { key: 'pet_name', label: 'Nome do pet' }, { key: 'species', label: 'Espécie', list: ['Cão', 'Gato', 'Outro'] },
      { key: 'breed', label: 'Raça', list: BREEDS }, { key: 'size', label: 'Porte', list: ['Mini', 'Pequeno', 'Médio', 'Grande', 'Gigante'] }] },
    food: { noun: 'pedido', itemType: 'other', fields: [] },
    general: { noun: 'item', itemType: 'other', fields: [{ key: 'model', label: 'Item' }] }
  };
  NICHES.bodyshop = NICHES.automotive; NICHES.carwash = NICHES.automotive;
  const niche = n => NICHES[n] || NICHES.general;
  function itemFields(nicheKey, d = {}) {
    const cfg = niche(nicheKey);
    if (!cfg.fields.length) return '';
    return `<input type="hidden" name="detail_item_type" value="${cfg.itemType}"><div class="nv-form-grid fp-item-grid">` + cfg.fields.map(f => {
      const id = 'dl-' + f.key + '-' + Math.random().toString(36).slice(2, 7);
      const list = f.list ? opts(f.list) : f.dependsOn ? opts(f.lists[d[f.dependsOn]] || Object.values(f.lists).flat()) : '';
      return `<label class="nv-field">${esc(f.label)}<input name="detail_${f.key}" value="${esc(d[f.key] || '')}" maxlength="120" autocomplete="off" ${list ? `list="${id}"` : ''} ${f.upper ? 'style="text-transform:uppercase"' : ''} ${f.dependsOn ? `data-depends="${f.dependsOn}"` : ''}></label>${list ? `<datalist id="${id}">${list}</datalist>` : ''}`;
    }).join('') + '</div>';
  }
  // Modelo acompanha a marca escolhida.
  document.addEventListener('input', e => {
    const input = e.target; if (!input.name || !input.name.startsWith('detail_')) return;
    const form = input.form; if (!form) return;
    const key = input.name.slice(7);
    form.querySelectorAll(`[data-depends="${key}"]`).forEach(dep => {
      const cfg = Object.values(NICHES).flatMap(n => n.fields).find(f => f.key === dep.name.slice(7) && f.dependsOn === key);
      const dl = dep.list; if (!cfg || !dl) return;
      dl.innerHTML = opts(cfg.lists[input.value] || Object.values(cfg.lists).flat());
    });
  });
  const detailInfo = (nicheKey, d = {}) => {
    const cfg = niche(nicheKey); const rows = cfg.fields.map(f => [f.label, d[f.key]]).filter(([, v]) => v);
    return rows;
  };
  const itemLabel = (nicheKey, d = {}) => {
    const cfg = niche(nicheKey);
    if (cfg.itemType === 'pet') return d.pet_name || 'pet';
    return [d.brand, d.model].filter(Boolean).join(' ') || d.device_kind || cfg.noun;
  };

  // Busca de cliente: digita parte do nome, telefone ou CPF e escolhe.
  function customerPicker(container, customers, onPick) {
    container.innerHTML = `<div class="fp-combo"><input type="search" class="fp-combo-input" placeholder="Digite o nome, telefone ou CPF do cliente" autocomplete="off" aria-label="Buscar cliente" role="combobox" aria-expanded="false"><input type="hidden" name="customer_id" required><ul class="fp-combo-list" role="listbox" hidden></ul><div class="fp-combo-picked" hidden></div></div>`;
    const input = container.querySelector('.fp-combo-input'), hidden = container.querySelector('[name="customer_id"]'), list = container.querySelector('.fp-combo-list'), picked = container.querySelector('.fp-combo-picked');
    let active = -1, matches = [];
    const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const show = () => {
      const q = norm(input.value.trim()), digits = input.value.replace(/\D/g, '');
      matches = q.length < 1 ? [] : customers.filter(c => norm(c.name).includes(q) || (digits.length >= 3 && (String(c.phone || '').replace(/\D/g, '').includes(digits) || String(c.cpf || '').includes(digits)))).slice(0, 8);
      list.innerHTML = matches.map((c, i) => `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}"><strong>${esc(c.name)}</strong><span>${esc(c.phone || c.email || '')}</span></li>`).join('') + (q.length ? `<li role="option" data-new="1" class="fp-combo-new">+ Cadastrar "${esc(input.value.trim())}"</li>` : '');
      list.hidden = !q.length; input.setAttribute('aria-expanded', String(!list.hidden));
    };
    const pick = c => { hidden.value = c.id; input.hidden = true; list.hidden = true; picked.hidden = false; picked.innerHTML = `<div><strong>${esc(c.name)}</strong><span>${esc(c.phone || c.email || 'sem contato')}</span></div><button type="button" class="nv-button secondary">Trocar</button>`; picked.querySelector('button').onclick = reset; onPick && onPick(c); };
    const reset = () => { hidden.value = ''; input.hidden = false; picked.hidden = true; input.value = ''; input.focus(); onPick && onPick(null); };
    input.addEventListener('input', () => { active = -1; show(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { active = Math.min(matches.length - 1, active + 1); show(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); show(); e.preventDefault(); }
      else if (e.key === 'Enter' && !list.hidden) { e.preventDefault(); if (matches[active >= 0 ? active : 0]) pick(matches[active >= 0 ? active : 0]); }
      else if (e.key === 'Escape') list.hidden = true;
    });
    list.addEventListener('mousedown', e => { const li = e.target.closest('li'); if (!li) return; e.preventDefault(); if (li.dataset.new) container.dispatchEvent(new CustomEvent('fp-new-customer', { detail: input.value.trim(), bubbles: true })); else pick(matches[Number(li.dataset.i)]); });
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
    return { pick, reset, add: c => { customers.push(c); } };
  }

  // Endereço: CEP preenche sozinho; digitando a rua, sugere ruas da cidade da loja (ViaCEP, gratuito).
  function addressAssist(form, store) {
    const cep = form.querySelector('[data-cep]'), street = form.querySelector('[data-street]'); if (!street || street.dataset.assist) return;
    street.dataset.assist = '1';
    const wrap = document.createElement('div'); wrap.className = 'fp-combo fp-addr'; street.parentNode.insertBefore(wrap, street); wrap.append(street);
    const list = document.createElement('ul'); list.className = 'fp-combo-list'; list.hidden = true; list.setAttribute('role', 'listbox'); wrap.append(list);
    const hint = document.createElement('p'); hint.className = 'nv-help fp-addr-hint'; wrap.after(hint);
    let timer = null, rows = [], active = -1, seq = 0;
    const label = r => [r.logradouro, r.bairro, r.localidade + '/' + r.uf].filter(Boolean).join(', ');
    const fill = r => { street.value = label(r) + ', '; if (cep && r.cep) cep.value = r.cep; list.hidden = true; street.focus(); hint.textContent = 'Complete com o número.'; };
    const draw = () => { list.innerHTML = rows.map((r, i) => `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}"><strong>${esc(r.logradouro)}</strong><span>${esc([r.bairro, r.cep].filter(Boolean).join(' · '))}</span></li>`).join(''); list.hidden = !rows.length; };
    const city = () => ({ city: store.city || '', state: store.state || '' });
    if (!city().city) hint.textContent = 'Para sugerir ruas enquanto digita, informe a cidade da loja em Configurações → Perfil. Pelo CEP já funciona.';
    cep && cep.addEventListener('input', async () => {
      const d = cep.value.replace(/\D/g, ''); if (d.length !== 8) return;
      try { const r = await (await fetch('https://viacep.com.br/ws/' + d + '/json/')).json(); if (!r.erro) fill(r); else hint.textContent = 'CEP não encontrado.'; } catch { hint.textContent = 'Não foi possível consultar o CEP agora.'; }
    });
    street.addEventListener('input', () => {
      clearTimeout(timer); const { city: c, state: uf } = city();
      const typed = street.value.trim(); if (typed.includes(',')) { list.hidden = true; return; }
      const q = typed.replace(/^(rua|r\.|avenida|av\.?|travessa|tv\.?|alameda|al\.?)\s+/i, '');
      if (!c || !uf || q.length < 3) { rows = []; draw(); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const res = await (await fetch('https://viacep.com.br/ws/' + encodeURIComponent(uf) + '/' + encodeURIComponent(c) + '/' + encodeURIComponent(q) + '/json/')).json();
          if (mine !== seq) return;
          rows = Array.isArray(res) ? res.slice(0, 10) : []; active = -1; draw();
          hint.textContent = rows.length ? '' : 'Nenhuma rua encontrada em ' + c + '/' + uf + ' com esse nome.';
        } catch { hint.textContent = 'Sugestões indisponíveis no momento; digite o endereço completo.'; }
      }, 280);
    });
    street.addEventListener('keydown', e => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { active = Math.min(rows.length - 1, active + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (rows[Math.max(0, active)]) fill(rows[Math.max(0, active)]); }
      else if (e.key === 'Escape') list.hidden = true;
    });
    list.addEventListener('mousedown', e => { const li = e.target.closest('li'); if (!li) return; e.preventDefault(); fill(rows[Number(li.dataset.i)]); });
    street.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  }
  const formatCpf = v => { const d = String(v || '').replace(/\D/g, '').slice(0, 11); return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2'); };
  function customerFields(c = {}, prefix = '') {
    const f = (name, label, value = '', extra = '') => `<label class="nv-field">${label}<input name="${prefix}${name}" value="${esc(value)}" ${extra}></label>`;
    return `<div class="nv-form-grid">${f('name', 'Nome completo', c.name, 'required maxlength="120" autocomplete="off"')}${f('phone', 'Telefone / WhatsApp', c.phone, 'inputmode="tel" maxlength="30"')}${f('cpf', 'CPF', formatCpf(c.cpf), 'inputmode="numeric" maxlength="14" data-cpf')}${f('birth_date', 'Data de nascimento', c.birth_date ? String(c.birth_date).slice(0, 10) : '', 'type="date"')}${f('email', 'E-mail', c.email, 'type="email"')}${f('postal_code', 'CEP', c.postal_code, 'inputmode="numeric" maxlength="9" data-cep')}</div>${f('address', 'Endereço (comece a digitar a rua)', c.address, 'maxlength="500" autocomplete="off" data-street')}`;
  }
  document.addEventListener('input', e => { if (e.target.matches('[data-cpf]')) e.target.value = formatCpf(e.target.value); });
  const readCustomer = (form, prefix = '') => { const g = n => (form.elements[prefix + n]?.value || '').trim(); return { name: g('name'), phone: g('phone'), cpf: g('cpf').replace(/\D/g, ''), birth_date: g('birth_date'), email: g('email'), postal_code: g('postal_code').replace(/\D/g, ''), address: g('address') }; };

  // Lista que reordena arrastando (mouse e toque).
  function sortable(container, itemSelector, onDrop) {
    let dragging = null, placeholder = null, startY = 0, offsetY = 0;
    container.addEventListener('pointerdown', e => {
      const handle = e.target.closest('[data-drag-handle]'); if (!handle) return;
      dragging = handle.closest(itemSelector); if (!dragging) return;
      e.preventDefault(); handle.setPointerCapture(e.pointerId);
      const rect = dragging.getBoundingClientRect(); startY = e.clientY; offsetY = 0;
      placeholder = document.createElement('div'); placeholder.className = 'fp-drag-placeholder'; placeholder.style.height = rect.height + 'px';
      dragging.after(placeholder); dragging.classList.add('fp-dragging'); dragging.style.width = rect.width + 'px';
      dragging.style.position = 'fixed'; dragging.style.left = rect.left + 'px'; dragging.style.top = rect.top + 'px'; dragging.style.zIndex = 50;
      const move = ev => {
        offsetY = ev.clientY - startY; dragging.style.transform = `translateY(${offsetY}px)`;
        const siblings = [...container.querySelectorAll(itemSelector)].filter(el => el !== dragging);
        const target = siblings.find(el => { const r = el.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
        if (target) container.insertBefore(placeholder, target); else container.append(placeholder);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
        dragging.removeAttribute('style'); dragging.classList.remove('fp-dragging'); placeholder.replaceWith(dragging);
        const ids = [...container.querySelectorAll(itemSelector)].map(el => el.dataset.id); dragging = null; onDrop(ids);
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
    });
  }
  window.FP = { niche, itemFields, detailInfo, itemLabel, customerPicker, addressAssist, customerFields, readCustomer, sortable, formatCpf, esc };
})();
