// Peça certa para o aparelho digitado no serviço: "A12" acha a "Tela · Samsung A02/A12",
// "Note 8" acha "Redmi Note 8", "iPhone 11" acha "IP 11". O modelo da peça pode listar vários aparelhos
// que usam a mesma peça, separados por "/" ou "|" ("Moto E7/E7 Power/E7i Power"); a marca do primeiro vale
// para os seguintes ("Realme C51/C53/Note 50" = Realme Note 50).
//
// Resultado: exact (o aparelho é exatamente um dos da peça) ou close (começa igual: "A14" → A14 4G e A14 5G).
// Marcas genéricas (Samsung, Galaxy, Motorola, Moto, Xiaomi) não contam; famílias (Redmi, Poco, Realme,
// iPhone, Infinix, Tecno, LG) contam quando as duas pontas informam: "iPhone 12" não acha "Redmi 12".

const GENERIC = new Set(['samsung', 'galaxy', 'sm', 'motorola', 'moto', 'xiaomi', 'mi', 'celular', 'smartphone', 'aparelho']);
const FAMILY = new Set(['redmi', 'poco', 'realme', 'iphone', 'infinix', 'tecno', 'lg', 'nokia', 'positivo', 'multilaser']);
// Palavras do serviço que pedem a mesma peça (o nome da peça começa com a palavra da esquerda).
const SYNONYMS = { tela: ['tela', 'display', 'frontal', 'touch', 'lcd', 'visor'], bateria: ['bateria'], conector: ['conector', 'carga', 'placa de carga'], tampa: ['tampa', 'traseira'] };

export const fold = v => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function words(text) {
  return fold(text)
    .replace(/\biphone\s*(\d)/g, 'iphone $1').replace(/\bip\s*(?=\d)/g, 'iphone ').replace(/\bapple\b/g, 'iphone')
    .replace(/\bnot\b/g, 'note')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}
// Chaves de um nome: "full" mantém a família (redminote8), "core" tira (note8).
function keys(ws) {
  const w = ws.filter(x => !GENERIC.has(x));
  const fam = w.filter(x => FAMILY.has(x));
  return { full: w.join(''), core: w.filter(x => !FAMILY.has(x)).join(''), fam };
}

// Aparelhos de uma peça: "Samsung A02/A12" → [Samsung A02, Samsung A12].
export function aliases(deviceModel) {
  const parts = String(deviceModel || '').split(/[/|;,]+/).map(s => s.trim()).filter(Boolean);
  const out = []; let brand = [];
  for (const p of parts) {
    let ws = words(p); if (!ws.length) continue;
    const isBrand = x => GENERIC.has(x) || FAMILY.has(x);
    if (isBrand(ws[0])) { const n = ws.findIndex(x => !isBrand(x)); brand = n < 0 ? ws : ws.slice(0, n); }
    else ws = [...brand, ...ws];
    out.push({ text: p, ...keys(ws) });
  }
  return out;
}

function compare(typed, a) {
  if (!typed.core || !a.core) return null;
  if (typed.fam.length && a.fam.length && !typed.fam.some(f => a.fam.includes(f))) return null;
  if (typed.full === a.full || typed.core === a.core) return 'exact';
  // "A14" → "A14 4G"; "Note 13" → "Note 13 Pro" / "Note 13 4G"; "A05S" → "A05" (aparelho parecido).
  if (typed.core.length >= 2 && a.core.startsWith(typed.core) && /^([a-z]|[45]g)/.test(a.core.slice(typed.core.length))) return 'close';
  if (a.core.length >= 2 && typed.core.startsWith(a.core) && /^(s|4g|5g|e|i|plus|pro|core|power|prime)$/.test(typed.core.slice(a.core.length))) return 'close';
  return null;
}

// Tipo de peça que o serviço pede: "Troca de tela" → "tela". Serviço vazio = qualquer peça; serviço sem
// peça conhecida (ex.: formatação) → null (não sugere peça).
export function partKindFor(service) {
  const s = fold(service).trim(); if (!s) return '';
  for (const [kind, list] of Object.entries(SYNONYMS)) if (list.some(w => s.includes(w))) return kind;
  return null;
}

// parts: peças da loja ({ id, name, device_model, ... }). Devolve as que servem, exatas primeiro.
export function matchParts(parts, model, service = '') {
  // Digitado com "/" (ex.: escolheu "Samsung A02/A12" nas sugestões): vale qualquer um dos aparelhos.
  const typedList = aliases(model).filter(t => t.core);
  if (!typedList.length) return [];
  const kind = partKindFor(service);
  if (kind === null) return [];
  const out = [];
  for (const p of parts) {
    if (kind && !fold(p.name).trim().startsWith(kind)) continue;
    let best = null;
    for (const a of aliases(p.device_model)) for (const typed of typedList) {
      const m = compare(typed, a);
      if (m === 'exact') best = 'exact'; else if (m && !best) best = m;
    }
    if (best) out.push({ ...p, match: best });
  }
  return out.sort((a, b) => (a.match === b.match ? 0 : a.match === 'exact' ? -1 : 1)
    || ((b.stock_qty > 0) - (a.stock_qty > 0)) || fold(a.device_model).localeCompare(fold(b.device_model)) || fold(a.name).localeCompare(fold(b.name))).slice(0, 12);
}
