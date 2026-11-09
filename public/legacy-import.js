// Leitura das planilhas exportadas por outro sistema de pet shop ("clientes.xls" e "animais.xls").
// Esses .xls são tabelas HTML; algumas linhas vêm sem <tr> de abertura, por isso o corte é por </tr>.
// O resultado vai em lotes para /api/customers/import-legacy (idempotente pelo código antigo).
(function (root) {
  const decode = s => { const el = (root.document || {}).createElement ? root.document.createElement('textarea') : null; if (el) { el.innerHTML = s; return el.value; } return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)); };
  function parseTable(text) {
    const s = text.slice(Math.max(0, text.search(/<table/i)));
    const out = [];
    for (const chunk of s.split(/<\/tr>/i)) {
      const cells = [...chunk.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => decode(m[1].replace(/<[^>]+>/g, '')).trim());
      if (cells.length) out.push(cells);
    }
    const head = out.shift() || [];
    return out.filter(r => r.length >= head.length - 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  }
  const digits = s => String(s || '').replace(/\D/g, '');
  const date = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); if (!m) return null; const y = +m[1], mo = +m[2], d = +m[3]; const dt = new Date(Date.UTC(y, mo - 1, d)); return y >= 1990 && y <= 2030 && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? m[0] : null; };
  const title = s => String(s || '').trim().split(/\s+/).filter(Boolean).map(w => w.length > 2 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join(' ');
  function phone(s) {
    let n = digits(s); if ((n.length === 12 || n.length === 13) && n.startsWith('55')) n = n.slice(2);
    if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
    if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
    return String(s || '').trim() || null;
  }
  function cpf(s) {
    const n = digits(s); if (n.length !== 11 || /^(\d)\1+$/.test(n)) return null;
    for (const k of [9, 10]) { let sum = 0; for (let i = 0; i < k; i++) sum += +n[i] * (k + 1 - i); if ((sum * 10) % 11 % 10 !== +n[k]) return null; }
    return n;
  }
  const pick = (r, ...names) => { for (const n of names) if (r[n] !== undefined) return String(r[n]).trim(); return ''; };
  function mapCustomers(rows) {
    return rows.map(r => {
      const street = [title(pick(r, 'Endereco', 'Endereço')), pick(r, 'Numero', 'Número'), pick(r, 'Complemento')].filter(Boolean).join(', ');
      const uf = pick(r, 'Estado', 'UF').toUpperCase();
      const city = pick(r, 'Cidade') ? title(pick(r, 'Cidade')) + (uf ? '/' + uf : '') : '';
      const address = [street, title(pick(r, 'Bairro')), city].filter(Boolean).join(' - ');
      const email = pick(r, 'Email', 'E-mail').toLowerCase(); const cep = digits(pick(r, 'CEP'));
      return { ext: pick(r, 'CdCliente', 'Codigo', 'Código'), name: pick(r, 'Nome').slice(0, 120), phone: phone(pick(r, 'Telefone', 'Celular', 'WhatsApp')),
        email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null, cpf: cpf(pick(r, 'CPF')), birth: date(pick(r, 'Nascimento')),
        address: address.slice(0, 500) || null, cep: cep.length === 8 ? cep : null, created: /^\d{4}-\d{2}-\d{2}/.test(pick(r, 'DataCadastro')) ? pick(r, 'DataCadastro').slice(0, 19) : null };
    }).filter(c => c.ext && c.name);
  }
  const SPECIES = { CAO: 'Cão', 'CÃO': 'Cão', GATO: 'Gato', 'PORQUINHO DA ÍNDIA': 'Porquinho-da-índia', CHITZU: 'Cão' };
  const SIZES = { P: 'Pequeno', M: 'Médio', G: 'Grande', MI: 'Mini', GI: 'Gigante' };
  const fmt = d => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4);
  function mapPets(rows) {
    return rows.map(r => {
      const rawSp = pick(r, 'Especie', 'Espécie'); const sp = rawSp ? (SPECIES[rawSp.toUpperCase()] || rawSp) : null;
      const breed = pick(r, 'Raca', 'Raça') || (rawSp.toUpperCase() === 'CHITZU' ? 'Shih-tzu' : '');
      const notes = [];
      if (pick(r, 'Obs')) notes.push(pick(r, 'Obs'));
      if (pick(r, 'Planos')) notes.push('Plano: ' + pick(r, 'Planos'));
      for (const k of Object.keys(r)) if ((k.startsWith('Vacina') || k === 'Vermifugo' || k === 'Ectoparasita') && String(r[k]).trim()) { const v = String(r[k]).trim(); notes.push(k + ': ' + (date(v) ? fmt(date(v)) : v)); }
      const coatKey = Object.keys(r).find(k => /pelagem/i.test(k)); const coat = coatKey ? String(r[coatKey]).trim() : '';
      const w = parseFloat(String(pick(r, 'Peso')).replace(',', '.')) || 0; const sex = pick(r, 'Sexo').toUpperCase(); const neut = pick(r, 'Castrado').toLowerCase();
      return { ext: pick(r, 'CdAnimal', 'Codigo', 'Código'), cust: pick(r, 'CdCliente'), name: (pick(r, 'Nome') || 'Sem nome').slice(0, 80), species: sp, breed: breed.slice(0, 80) || null,
        sex: sex === 'M' || sex === 'F' ? sex : null, birth: date(pick(r, 'Nascimento')), color: pick(r, 'Cor').slice(0, 60) || null, weight: w > 0 && w < 999 ? w : null,
        size: SIZES[pick(r, 'Porte').toUpperCase()] || null, coat: coat === 'Médio' || coat === 'Longo' ? coat : null,
        neutered: neut === 'sim' ? true : neut === 'não' || neut === 'nao' ? false : null, notes: notes.join('\n').slice(0, 2000) || null };
    }).filter(p => p.ext && p.cust);
  }
  root.FPLegacy = { parseTable, mapCustomers, mapPets };
})(typeof window !== 'undefined' ? window : globalThis);
