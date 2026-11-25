import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNfce } from '../src/nfce.js';
import { toAcbr, fromAcbr, testSale, fortalezaIso, acbr, resetAcbrToken, AcbrError } from '../src/acbr.js';

const tenant = { cnpj: '46383376000123', state_registration: '069999999', legal_name: 'GRK JOIAS E ACESSORIOS LTDA', unit_label: 'Grand Shopping', tax_regime: 1, nfce_series: 10, fiscal_env: 'homologacao', payment_terminal_id: 'PPC930-01' };
const address = { street: 'Av. Frei Cirilo', number: '3840', district: 'Messejana', city_code: '2304400', city: 'Fortaleza', cep: '60840-285' };

test('ACBr: JSON da NFC-e com os campos da IN 87 no grupo card', () => {
  const s = testSale(tenant, 'credit');
  const { doc, problems } = buildNfce({ tenant, sale: s.sale, items: s.items, products: s.products, number: 7 });
  assert.deepEqual(problems, []);
  const j = toAcbr({ ...doc, issued_at: '2026-11-25T13:30:00.000Z' }, { address, referencia: 'ref-1' });
  assert.equal(j.ambiente, 'homologacao'); assert.equal(j.referencia, 'ref-1');
  const { ide, emit, det, total, pag } = j.infNFe;
  assert.deepEqual([ide.cUF, ide.mod, ide.serie, ide.nNF, ide.tpAmb, ide.tpEmis, ide.tpImp, ide.cMunFG], [23, 65, 10, 7, 2, 1, 4, '2304400']);
  assert.equal(ide.dhEmi, '2026-11-25T10:30:00-03:00');
  assert.equal(emit.CNPJ, '46383376000123'); assert.equal(emit.CRT, 1); assert.equal(emit.enderEmit.CEP, '60840285'); assert.equal(emit.enderEmit.UF, 'CE');
  assert.match(det[0].prod.xProd, /HOMOLOGACAO - SEM VALOR FISCAL/);
  assert.deepEqual([det[0].prod.NCM, det[0].prod.CEST, det[0].prod.CFOP, det[0].prod.vProd], ['71171900', '2805800', '5102', 10]);
  assert.deepEqual(det[0].imposto.ICMS, { ICMSSN102: { orig: 0, CSOSN: '102' } });
  assert.deepEqual(det[0].imposto.PIS, { PISNT: { CST: '08' } });
  assert.equal(total.ICMSTot.vNF, 10);
  assert.deepEqual(pag.detPag[0], { indPag: 0, tPag: '03', vPag: 10, card: { tpIntegra: 1, CNPJ: '16501555000157', tBand: '02', cAut: '123456', CNPJReceb: '46383376000123', idTermPag: 'PPC930-01' } });
});

test('ACBr: Pix dinâmico (tPag 17, endToEndId em cAut) e dinheiro sem card', () => {
  const p = testSale(tenant, 'pix');
  const pix = toAcbr(buildNfce({ tenant, ...p, number: 1 }).doc, { address });
  assert.equal(pix.infNFe.pag.detPag[0].tPag, '17');
  assert.equal(pix.infNFe.pag.detPag[0].card.tpIntegra, 1);
  assert.match(pix.infNFe.pag.detPag[0].card.cAut, /^E16501555/);
  assert.equal(pix.infNFe.pag.detPag[0].card.tBand, undefined);
  const c = testSale(tenant, 'cash');
  const cash = toAcbr(buildNfce({ tenant, ...c, number: 2 }).doc, { address });
  assert.deepEqual(cash.infNFe.pag.detPag[0], { indPag: 0, tPag: '01', vPag: 10 });
});

test('ACBr: produção não leva textos de homologação', () => {
  const s = testSale(tenant, 'cash');
  const j = toAcbr(buildNfce({ tenant: { ...tenant, fiscal_env: 'producao' }, ...s, number: 1 }).doc, { address });
  assert.equal(j.ambiente, 'producao'); assert.equal(j.infNFe.ide.tpAmb, 1); assert.equal(j.infNFe.det[0].prod.xProd, 'Peça de teste');
});

test('ACBr: resposta → situação do documento', () => {
  assert.deepEqual(fromAcbr({ id: 'abc', status: 'autorizado', chave: '2'.repeat(44), autorizacao: { numero_protocolo: '123', codigo_status: 100, motivo_status: 'Autorizado o uso' } }),
    { status: 'authorized', provider_ref: 'abc', access_key: '2'.repeat(44), protocol: '123', error: null });
  assert.equal(fromAcbr({ id: 'x', status: 'rejeitado', autorizacao: { codigo_status: 225, motivo_status: 'Falha no Schema XML' } }).error, '225 - Falha no Schema XML');
  assert.equal(fromAcbr({ status: 'pendente' }).status, 'processing');
  assert.equal(fortalezaIso('2026-01-01T02:00:00Z'), '2025-12-31T23:00:00-03:00');
});

test('ACBr: token reaproveitado, erro da API e timeout', async () => {
  process.env.ACBR_CLIENT_ID = 'id'; process.env.ACBR_CLIENT_SECRET = 'sec'; delete process.env.ACBR_AMBIENTE; resetAcbrToken();
  const calls = [];
  const fetchFn = async (url, o) => {
    calls.push([url, o.method]);
    if (url.includes('/token')) { assert.match(o.body, /grant_type=client_credentials/); assert.match(o.body, /scope=empresa\+nfce/); return new Response(JSON.stringify({ access_token: 'tk', expires_in: 2592000 })); }
    assert.equal(o.headers.Authorization, 'Bearer tk');
    if (url.endsWith('/empresas/1')) return new Response(JSON.stringify({ error: { message: 'Empresa não encontrada' } }), { status: 404 });
    if (url.endsWith('/slow')) return new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
    return new Response(JSON.stringify({ ok: true }));
  };
  assert.deepEqual(await acbr('/cep/60840285', { fetchFn }), { ok: true });
  assert.equal(calls[1][0], 'https://hom.acbr.api.br/cep/60840285');
  await assert.rejects(acbr('/empresas/1', { fetchFn }), e => e instanceof AcbrError && e.status === 404 && /não encontrada/.test(e.message));
  await assert.rejects(acbr('/slow', { fetchFn, ms: 50 }), e => e.timeout === true);
  assert.equal(calls.filter(c => c[0].includes('/token')).length, 1, 'um token só');
  resetAcbrToken(); delete process.env.ACBR_CLIENT_ID;
  await assert.rejects(acbr('/x', { fetchFn }), /não configuradas/);
});
