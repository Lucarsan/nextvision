// Etiquetas com código de barras (EAN-13 para códigos internos válidos; Code 128 para os demais).
// Mesmo desenho das etiquetas do painel da loja (store-sales.js), para o painel da rede.
// Uso: window.FPLabels.print([{ p: { name, price_cents, barcode }, n }], título, aviso)
(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = c => 'R$ ' + ((Number(c) || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let feedback = (msg) => alert(msg);
  const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
  const EAN_P = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  const C128 = '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'.split(' ');
  const validEan13 = c => /^\d{13}$/.test(c) && Number(c[12]) === (10 - (c.slice(0, 12).split('').reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0) % 10)) % 10;
  function barcodeModules(code) {
    if (validEan13(code)) {
      const d = code.split('').map(Number), par = EAN_P[d[0]];
      let bits = '101'; for (let i = 1; i <= 6; i++) bits += (par[i - 1] === 'L' ? EAN_L : EAN_G)[d[i]];
      bits += '01010'; for (let i = 7; i <= 12; i++) bits += EAN_R[d[i]]; bits += '101';
      return { bits, ean: true };
    }
    const vals = [104, ...[...code].map(ch => ch.charCodeAt(0) - 32)];
    vals.push(vals.reduce((a, v, i) => a + v * (i || 1), 0) % 103, 106);
    let bits = ''; for (const v of vals) [...C128[v]].forEach((w, i) => { bits += (i % 2 ? '0' : '1').repeat(Number(w)); });
    return { bits, ean: false };
  }
  function barcodeSvg(code, height = 50) {
    const { bits, ean } = barcodeModules(code), quiet = ean ? 9 : 10, w = bits.length + quiet * 2;
    let rects = '', x = 0;
    while (x < bits.length) { if (bits[x] === '1') { let e = x; while (bits[e] === '1') e++; rects += `<rect x="${x + quiet}" y="0" width="${e - x}" height="${height}"/>`; x = e; } else x++; }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges" class="bc">${rects}</svg>`;
  }
  // Imprime etiquetas de um ou vários produtos na mesma página: folha A4 (3 colunas) ou impressora de etiquetas
  // (uma por página, 50×30 mm). Na A4 dá para pular as posições já usadas de uma folha aproveitada.
  // items: [{ p: produto, n: quantidade }]
  function printLabelSheet(items, title) {
    items = items.filter(x => x.p?.barcode && x.n > 0).map(x => ({ p: x.p, n: Math.max(1, Math.min(500, x.n | 0)) }));
    if (!items.length) { feedback('Nenhuma etiqueta para imprimir (produto sem código de barras?).', true); return false; }
    const total = items.reduce((a, x) => a + x.n, 0);
    if (total > 1500) { feedback('No máximo 1.500 etiquetas por vez.', true); return false; }
    const w = window.open('', '_blank'); if (!w) { feedback('Libere pop-ups para imprimir as etiquetas.', true); return false; }
    const label = p => `<div class="lb"><div class="nm">${esc(p.name)}</div><div class="pr">${brl(p.price_cents)}</div>${barcodeSvg(p.barcode)}<div class="cd">${esc(p.barcode)}</div></div>`;
    const labels = items.map(x => label(x.p).repeat(x.n)).join('');
    const name = title || (items.length === 1 ? items[0].p.name : `${items.length} produtos`);
    w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Etiquetas · ${esc(name)}</title><style id="pg"></style><style>
      *{box-sizing:border-box}body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff}
      .bar{padding:10px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #ddd;font-size:14px}.bar button{font:inherit;padding:8px 14px;cursor:pointer}.bar input[type=number]{width:60px;font:inherit;padding:4px}
      .lb{display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;text-align:center;break-inside:avoid;page-break-inside:avoid}
      .nm{font-size:10pt;font-weight:700;line-height:1.15;max-height:2.3em;overflow:hidden;width:100%}.pr{font-size:13pt;font-weight:700;margin:1mm 0}.bc{width:100%;height:12mm;fill:#000}.cd{font-size:8pt;letter-spacing:.5px}
      body.a4 .sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:0}body.a4 .lb{height:33.9mm;padding:2mm 4mm;border:1px dashed #ccc}body.a4 .skip{height:33.9mm;border:1px dashed #eee;background:repeating-linear-gradient(45deg,#fafafa 0 6px,#f0f0f0 6px 12px)}
      body.th .lb{width:50mm;height:30mm;padding:1.5mm 2mm;page-break-after:always}body.th .bc{height:10mm}body.th .skip,body.th .askip{display:none}
      @media print{.bar{display:none}body.a4 .lb{border-color:transparent}body.a4 .skip{border-color:transparent;background:none}}
    </style></head><body class="a4"><div class="bar"><b>${total} etiqueta(s) · ${esc(name)}</b>
      <label><input type="radio" name="fmt" value="a4" checked> Folha A4 (3 por linha)</label><label><input type="radio" name="fmt" value="th"> Impressora de etiquetas 50×30 mm</label>
      <label class="askip">Pular <input type="number" id="skip" min="0" max="80" value="0"> posições já usadas da folha</label>
      <button onclick="print()">Imprimir</button></div><div class="sheet"><span id="skips" style="display:contents"></span>${labels}</div>
      <script>const pg=document.getElementById('pg');const set=v=>{document.body.className=v;pg.textContent=v==='th'?'@page{size:50mm 30mm;margin:0}':'@page{size:A4;margin:10mm 7mm}'};document.querySelectorAll('[name=fmt]').forEach(r=>r.onchange=()=>set(r.value));set('a4');
      const sk=document.getElementById('skip');sk.oninput=()=>{const n=Math.max(0,Math.min(80,parseInt(sk.value,10)||0));document.getElementById('skips').innerHTML='<div class="skip"></div>'.repeat(n)};<\/script></body></html>`);
    w.document.close();
    return true;
  }
  window.FPLabels = { print: (items, title, onMsg) => { if (onMsg) feedback = onMsg; return printLabelSheet(items, title); }, svg: barcodeSvg };
})();
