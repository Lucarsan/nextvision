// Código bipado x código salvo: só números comparam sem os zeros à esquerda.
// A etiqueta pode trazer "000573" e o cadastro "573" (ou o contrário) — é a mesma peça.
// Códigos com letras ou EAN continuam comparando o texto exato.
export const codeEq = (col, param) =>
  `(${col} = ${param} OR (${param} ~ '^0*[1-9][0-9]*$' AND ${col} ~ '^0*[1-9][0-9]*$' AND ltrim(${col}, '0') = ltrim(${param}, '0')))`;
export const sameCode = (a, b) => {
  a = String(a ?? '').trim(); b = String(b ?? '').trim();
  if (!a || !b) return false; if (a === b) return true;
  const n = /^0*[1-9]\d*$/; return n.test(a) && n.test(b) && a.replace(/^0+/, '') === b.replace(/^0+/, '');
};
