// Emissor ACBr API (https://dev.acbr.api.br): token, cadastro da empresa e emissão de NFC-e.
// Credenciais só no ambiente do servidor: ACBR_CLIENT_ID, ACBR_CLIENT_SECRET e ACBR_AMBIENTE (sandbox | producao).
// Cupom de teste só na homologação (ACBR_AMBIENTE=sandbox). Com ACBR_AMBIENTE=producao a central pode configurar a
// NFC-e de cada unidade em produção; a emissão nas vendas do caixa ainda não está ligada.
// Sandbox e produção da ACBr têm endereços separados (hom./prod.); confirmar com o suporte se empresa e certificado
// passam sozinhos ou precisam ser cadastrados de novo em produção (a central mostra o que falta em cada unidade).
// Regras confirmadas com o suporte (25/11/2026): a ACBr assina com o certificado cadastrado nela; recebe só JSON;
// série e número vão no payload (nós controlamos); em timeout não reenviar, consultar depois.
import { z } from 'zod';
import { buildNfce } from './nfce.js';

const AUTH_URL = 'https://auth.acbr.api.br/realms/ACBrAPI/protocol/openid-connect/token';
const BASES = { sandbox: 'https://hom.acbr.api.br', producao: 'https://prod.acbr.api.br' };
const SCOPE = 'empresa nfce';
const UF_CODE = { CE: 23 };
const STATUS = { pendente: 'processing', autorizado: 'authorized', rejeitado: 'rejected', denegado: 'rejected', cancelado: 'canceled', encerrado: 'authorized', erro: 'error' };
// Textos obrigatórios da SEFAZ em homologação.
const HOM_ITEM = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
const HOM_DEST = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
// Municípios das unidades atuais (código IBGE).
export const CITIES = { 2304400: 'Fortaleza', 2307650: 'Maracanaú', 2301000: 'Aquiraz', 2303501: 'Cascavel', 2312908: 'Sobral' };

const digits = v => String(v ?? '').replace(/\D/g, '');
const money = c => Number((c / 100).toFixed(2));
// ACBR_API_URL / ACBR_AUTH_URL só para os testes apontarem para um servidor falso.
const apiBase = () => process.env.ACBR_API_URL || BASES[env()];
const authUrl = () => process.env.ACBR_AUTH_URL || AUTH_URL;
const env = () => (process.env.ACBR_AMBIENTE || 'sandbox').trim().toLowerCase() === 'producao' ? 'producao' : 'sandbox';
export const acbrConfigured = () => Boolean(process.env.ACBR_CLIENT_ID && process.env.ACBR_CLIENT_SECRET);

export class AcbrError extends Error {
  constructor(message, { status = 0, body = null, timeout = false } = {}) { super(message); this.status = status; this.body = body; this.timeout = timeout; }
}

// Token dura ~30 dias e o endpoint aceita só 4 pedidos por hora: guarda em memória e renova um dia antes.
let cached = null;
export function resetAcbrToken() { cached = null; }
async function token(fetchFn) {
  if (cached && cached.until > Date.now()) return cached.value;
  if (!acbrConfigured()) throw new AcbrError('Credenciais da ACBr API não configuradas no servidor (ACBR_CLIENT_ID e ACBR_CLIENT_SECRET)');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.ACBR_CLIENT_ID, client_secret: process.env.ACBR_CLIENT_SECRET, scope: SCOPE });
  const r = await timed(fetchFn, authUrl(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, 20000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new AcbrError('A ACBr recusou as credenciais' + (j.error_description ? ': ' + j.error_description : ''), { status: r.status });
  cached = { value: j.access_token, until: Date.now() + Math.max(60, (Number(j.expires_in) || 3600) - 86400) * 1000 };
  return cached.value;
}

async function timed(fetchFn, url, opts, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetchFn(url, { ...opts, signal: ctl.signal }); }
  catch (e) { throw new AcbrError(e.name === 'AbortError' ? 'A ACBr não respondeu a tempo' : 'Sem conexão com a ACBr', { timeout: true }); }
  finally { clearTimeout(t); }
}

// Chamada autenticada. Erro da API vira AcbrError com a mensagem dela.
export async function acbr(path, { method = 'GET', body, fetchFn = globalThis.fetch, ms = 45000 } = {}) {
  const tk = await token(fetchFn);
  const r = await timed(fetchFn, apiBase() + path, { method, headers: { Authorization: 'Bearer ' + tk, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }, ms);
  const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text.slice(0, 500) }; }
  if (r.status === 401) cached = null;
  if (!r.ok) {
    const e = j?.error || j || {};
    const detail = Array.isArray(e.errors) ? e.errors.map(x => x.message || x.description || JSON.stringify(x)).slice(0, 5).join('; ') : '';
    throw new AcbrError(`ACBr ${r.status}: ${e.message || e.title || e.raw || 'erro'}${detail ? ' (' + detail + ')' : ''}`, { status: r.status, body: j });
  }
  return j;
}

// "2026-11-25T10:30:00-03:00" (Fortaleza não tem horário de verão).
export function fortalezaIso(d) { return new Date(new Date(d).getTime() - 3 * 3600000).toISOString().slice(0, 19) + '-03:00'; }

// Documento neutro (buildNfce) → JSON da ACBr API (estrutura do layout 4.00 da NF-e, campos conferidos na
// Referência da API em 25/11/2026; tipos dos campos a confirmar na homologação).
export function toAcbr(doc, { address, referencia = null, uf = 'CE' }) {
  const hom = doc.env !== 'producao';
  const items = doc.items.map((d, i) => ({
    nItem: d.n,
    prod: {
      cProd: String(d.code).slice(0, 60), cEAN: 'SEM GTIN', xProd: hom && i === 0 ? HOM_ITEM : d.name, NCM: d.ncm, CEST: d.cest || undefined, CFOP: d.cfop,
      uCom: d.unit, qCom: d.quantity, vUnCom: money(d.unit_cents), vProd: money(d.gross_cents), cEANTrib: 'SEM GTIN', uTrib: d.unit, qTrib: d.quantity, vUnTrib: money(d.unit_cents),
      ...(d.discount_cents ? { vDesc: money(d.discount_cents) } : {}), indTot: 1,
    },
    imposto: {
      ICMS: { ICMSSN102: { orig: d.origin, CSOSN: d.csosn } },
      PIS: { PISNT: { CST: d.pis_cofins_cst } },
      COFINS: { COFINSNT: { CST: d.pis_cofins_cst } },
    },
  }));
  const detPag = doc.payments.map(p => ({
    indPag: 0, tPag: p.tpag, vPag: money(p.amount_cents),
    ...(p.integration ? { card: {
      tpIntegra: p.integration,
      ...(p.acquirer_cnpj ? { CNPJ: p.acquirer_cnpj } : {}), ...(p.brand ? { tBand: p.brand } : {}), ...(p.auth ? { cAut: p.auth } : {}),
      ...(p.cnpj_receb ? { CNPJReceb: p.cnpj_receb } : {}), ...(p.terminal_id ? { idTermPag: p.terminal_id } : {}),
    } } : {}),
  }));
  const t = doc.totals, zero = 0;
  const infRespTec = digits(process.env.RESP_TEC_CNPJ).length === 14 ? { CNPJ: digits(process.env.RESP_TEC_CNPJ), xContato: process.env.RESP_TEC_CONTATO || '', email: process.env.RESP_TEC_EMAIL || '', fone: digits(process.env.RESP_TEC_FONE) } : undefined;
  return {
    ambiente: hom ? 'homologacao' : 'producao',
    ...(referencia ? { referencia } : {}),
    infNFe: {
      versao: '4.00',
      ide: {
        cUF: UF_CODE[uf], natOp: doc.nature, mod: 65, serie: doc.series, nNF: doc.number, dhEmi: fortalezaIso(doc.issued_at),
        tpNF: 1, idDest: 1, cMunFG: address.city_code, tpImp: 4, tpEmis: 1, tpAmb: hom ? 2 : 1, finNFe: 1, indFinal: 1, indPres: doc.presence, indIntermed: 0, procEmi: 0, verProc: 'FicouPronto 1.0',
      },
      emit: {
        CNPJ: doc.issuer.cnpj, xNome: doc.issuer.legal_name, ...(doc.issuer.trade_name ? { xFant: String(doc.issuer.trade_name).slice(0, 60) } : {}),
        enderEmit: { xLgr: address.street, nro: address.number || 'S/N', ...(address.complement ? { xCpl: address.complement } : {}), xBairro: address.district, cMun: address.city_code, xMun: address.city, UF: uf, CEP: digits(address.cep), cPais: '1058', xPais: 'BRASIL' },
        IE: doc.issuer.ie, CRT: doc.issuer.tax_regime,
      },
      ...(doc.consumer ? { dest: { CPF: doc.consumer.cpf, ...(hom ? { xNome: HOM_DEST } : doc.consumer.name ? { xNome: doc.consumer.name.slice(0, 60) } : {}), indIEDest: 9 } } : {}),
      det: items,
      total: { ICMSTot: {
        vBC: zero, vICMS: zero, vICMSDeson: zero, vFCP: zero, vBCST: zero, vST: zero, vFCPST: zero, vFCPSTRet: zero,
        vProd: money(t.gross_cents), vFrete: zero, vSeg: zero, vDesc: money(t.discount_cents), vII: zero, vIPI: zero, vIPIDevol: zero, vPIS: zero, vCOFINS: zero, vOutro: zero, vNF: money(t.total_cents),
      } },
      transp: { modFrete: 9 },
      pag: { detPag, ...(doc.change_cents ? { vTroco: money(doc.change_cents) } : {}) },
      ...(infRespTec ? { infRespTec } : {}),
    },
  };
}

// Resposta da ACBr (DFe) → colunas do fiscal_documents.
export function fromAcbr(r) {
  const a = r?.autorizacao || {};
  const status = STATUS[r?.status] || 'error';
  const reason = [a.codigo_status, a.motivo_status || a.mensagem].filter(Boolean).join(' - ');
  return { status, provider_ref: r?.id || null, access_key: /^\d{44}$/.test(r?.chave || '') ? r.chave : null, protocol: a.numero_protocolo || null, error: status === 'authorized' ? null : reason || null };
}

function addressProblems(a) {
  const p = [];
  if (!a) return ['Unidade sem endereço fiscal'];
  if (!a.street) p.push('Endereço sem logradouro');
  if (!a.district) p.push('Endereço sem bairro');
  if (!/^\d{7}$/.test(a.city_code || '')) p.push('Endereço sem código IBGE do município');
  if (!a.city) p.push('Endereço sem cidade');
  if (!/^\d{8}$/.test(digits(a.cep))) p.push('Endereço sem CEP');
  return p;
}

// Venda fictícia de R$ 10,00 com dados de TEF de teste, para provar campos e assinatura na homologação.
export function testSale(tenant, method) {
  const tef = method === 'credit' ? [{ method: 'credit', amount_cents: 1000, acquirer_cnpj: '16501555000157', brand: '02', auth: '123456', terminal_id: tenant.payment_terminal_id || 'TESTE01' }]
    : method === 'pix' ? [{ method: 'pix', amount_cents: 1000, acquirer_cnpj: '16501555000157', auth: 'E16501555202611251030TESTE000001', terminal_id: tenant.payment_terminal_id || 'TESTE01' }] : null;
  return {
    sale: { id: null, sale_number: 0, total_cents: 1000, payment_method: method, payments: null, tef, created_at: new Date().toISOString() },
    items: [{ product_id: 'teste', name: 'Peça de teste', quantity: 1, unit_price_cents: 1000, total_cents: 1000 }],
    products: new Map([['teste', { id: 'teste', code: 'TESTE', ncm: '71171900' }]]),
  };
}

function companyBody(t, email) {
  const a = t.fiscal_address || {};
  return {
    cpf_cnpj: t.cnpj, nome_razao_social: t.legal_name, ...(t.unit_label || t.name ? { nome_fantasia: t.unit_label || t.name } : {}),
    ...(t.state_registration ? { inscricao_estadual: t.state_registration } : {}), email,
    endereco: { logradouro: a.street, numero: a.number || 'S/N', ...(a.complement ? { complemento: a.complement } : {}), bairro: a.district, codigo_municipio: a.city_code, cidade: a.city, uf: 'CE', codigo_pais: '1058', pais: 'Brasil', cep: digits(a.cep) },
  };
}

export function registerAcbr(app, { q, db, auth, roles, route, bad, valid, audit, uuid, fetchFn = (...a) => globalThis.fetch(...a) }) {
  const master = [auth, roles('master')];
  const loadTenant = async id => (await q('SELECT * FROM tenants WHERE id=$1', [id])).rows[0];
  const fail = (res, e) => bad(res, e instanceof AcbrError ? (e.status === 404 ? 404 : 502) : 500, e.message);
  const call = (path, o = {}) => acbr(path, { ...o, fetchFn });

  // Dados do emitente + situação na ACBr (empresa, certificado, configuração da NFC-e).
  app.get('/api/master/tenants/:id/acbr', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const t = await loadTenant(req.params.id); if (!t) return bad(res, 404, 'Loja não encontrada');
    const out = { configured: acbrConfigured(), environment: env(), cities: CITIES,
      fiscal: { cnpj: t.cnpj, legal_name: t.legal_name, state_registration: t.state_registration, tax_regime: t.tax_regime, nfce_series: t.nfce_series, nfce_hom_next_number: t.nfce_hom_next_number, fiscal_env: t.fiscal_env, payment_terminal_id: t.payment_terminal_id, fiscal_address: t.fiscal_address, fiscal_email: t.fiscal_email },
      problems: [...(t.cnpj ? [] : ['Unidade sem CNPJ']), ...(t.legal_name ? [] : ['Unidade sem razão social']), ...(t.state_registration ? [] : ['Unidade sem inscrição estadual (IE)']), ...addressProblems(t.fiscal_address)],
      company: null, certificate: null, nfce: null, error: null };
    out.tests = (await q("SELECT id,number,status,access_key,error,created_at,payload->'infNFe'->'pag'->'detPag'->0->>'tPag' tpag FROM fiscal_documents WHERE tenant_id=$1 AND is_test ORDER BY created_at DESC LIMIT 10", [t.id])).rows;
    if (out.configured && t.cnpj) {
      try {
        out.company = await call('/empresas/' + t.cnpj).catch(e => { if (e.status === 404) return null; throw e; });
        if (out.company) {
          out.certificate = await call(`/empresas/${t.cnpj}/certificado`).catch(e => (e.status === 404 ? null : { error: e.message }));
          out.nfce = await call(`/empresas/${t.cnpj}/nfce`).catch(e => (e.status === 404 ? null : { error: e.message }));
          if (out.nfce?.sefaz) out.nfce = { ...out.nfce, sefaz: { id_csc: out.nfce.sefaz.id_csc, csc: out.nfce.sefaz.csc ? '(informado)' : '' } };
        }
      } catch (e) { out.error = e.message; }
    }
    res.set('Cache-Control', 'no-store').json(out);
  }));

  // Endereço e e-mail do emitente (o resto dos dados fiscais vai pelo PATCH /fiscal do nfce.js).
  app.patch('/api/master/tenants/:id/fiscal-address', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({
      fiscal_address: z.object({
        street: z.string().trim().min(2).max(60), number: z.string().trim().min(1).max(60), complement: z.string().trim().max(60).nullable().optional(),
        district: z.string().trim().min(2).max(60), city_code: z.string().regex(/^\d{7}$/, 'Código IBGE com 7 dígitos'), city: z.string().trim().min(2).max(60),
        cep: z.preprocess(digits, z.string().regex(/^\d{8}$/, 'CEP com 8 dígitos')),
      }).optional(),
      fiscal_email: z.string().trim().email().max(120).nullable().optional(),
    }).strict(), req, res); if (!v) return;
    const keys = Object.keys(v); if (!keys.length) return bad(res, 400, 'Nada para alterar');
    const r = await q(`UPDATE tenants SET ${keys.map((k, i) => k + '=$' + (i + 2)).join(',')} WHERE id=$1 RETURNING id,fiscal_address,fiscal_email`, [req.params.id, ...keys.map(k => v[k] ?? null)]);
    if (!r.rowCount) return bad(res, 404, 'Loja não encontrada');
    await audit(req, 'update_fiscal_address', 'tenant', req.params.id, req.params.id);
    res.json(r.rows[0]);
  }));

  // Cadastra (ou atualiza) a unidade como empresa na ACBr.
  app.post('/api/master/tenants/:id/acbr/company', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const t = await loadTenant(req.params.id); if (!t) return bad(res, 404, 'Loja não encontrada');
    const missing = [...(t.cnpj ? [] : ['CNPJ']), ...(t.legal_name ? [] : ['razão social']), ...(t.fiscal_email ? [] : ['e-mail fiscal']), ...addressProblems(t.fiscal_address)];
    if (missing.length) return bad(res, 400, 'Falta: ' + missing.join(', '));
    try {
      const exists = await call('/empresas/' + t.cnpj).then(() => true, e => { if (e.status === 404) return false; throw e; });
      const body = companyBody(t, t.fiscal_email);
      const r = exists ? await call('/empresas/' + t.cnpj, { method: 'PUT', body }) : await call('/empresas', { method: 'POST', body });
      await audit(req, exists ? 'acbr_company_update' : 'acbr_company_create', 'tenant', t.id, t.id);
      res.json({ ok: true, created: !exists, company: r });
    } catch (e) { fail(res, e); }
  }));

  // Repassa o certificado A1 à ACBr. Nada é gravado aqui (nem arquivo, nem senha, nem log).
  app.put('/api/master/tenants/:id/acbr/certificate', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ certificado: z.string().min(100).max(300000).regex(/^[A-Za-z0-9+/=\s]+$/, 'Arquivo inválido'), password: z.string().min(1).max(200) }).strict(), req, res); if (!v) return;
    const t = await loadTenant(req.params.id); if (!t?.cnpj) return bad(res, 400, 'Unidade sem CNPJ');
    try {
      const r = await call(`/empresas/${t.cnpj}/certificado`, { method: 'PUT', body: { certificado: v.certificado.replace(/\s/g, ''), password: v.password } });
      await audit(req, 'acbr_certificate', 'tenant', t.id, t.id);
      res.json({ ok: true, certificate: r ? { serial_number: r.serial_number, issuer_name: r.issuer_name, not_valid_after: r.not_valid_after, subject_name: r.subject_name } : null });
    } catch (e) { fail(res, e); }
  }));

  // Configuração da NFC-e na ACBr. QR Code v3 (NT 2025.001) dispensa CSC: id_csc 0 e csc vazio.
  // Ambiente: homologação (padrão) ou produção. Produção só com ACBR_AMBIENTE=producao no servidor, e grava
  // tenants.fiscal_env junto, para o cupom montado (tpAmb) seguir o mesmo ambiente configurado na ACBr.
  // Isto só configura: nenhuma venda emite cupom por aqui.
  app.put('/api/master/tenants/:id/acbr/nfce-config', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ id_csc: z.number().int().min(0).max(999999).default(0), csc: z.string().trim().max(60).default(''), ambiente: z.enum(['homologacao', 'producao']).default('homologacao') }).strict(), req, res); if (!v) return;
    if (v.id_csc > 0 && !v.csc) return bad(res, 400, 'Informe o CSC junto com o ID do CSC');
    if (v.ambiente === 'producao' && env() !== 'producao') return bad(res, 409, 'Produção só depois de trocar ACBR_AMBIENTE para producao no Render');
    const t = await loadTenant(req.params.id); if (!t?.cnpj) return bad(res, 400, 'Unidade sem CNPJ');
    try {
      await call(`/empresas/${t.cnpj}/nfce`, { method: 'PUT', body: { CRT: t.tax_regime ?? 1, ambiente: v.ambiente, sefaz: { id_csc: v.id_csc, csc: v.csc } } });
      await q('UPDATE tenants SET fiscal_env=$2 WHERE id=$1', [t.id, v.ambiente]);
      await audit(req, v.ambiente === 'producao' ? 'acbr_nfce_config_producao' : 'acbr_nfce_config', 'tenant', t.id, t.id);
      res.json({ ok: true, ambiente: v.ambiente, qrcode: v.id_csc === 0 ? 'v3 (sem CSC)' : 'v2 (com CSC)' });
    } catch (e) { fail(res, e); }
  }));

  // Cupom de teste na homologação (sem venda, sem valor fiscal, não gasta crédito).
  app.post('/api/master/tenants/:id/acbr/test-nfce', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ method: z.enum(['cash', 'credit', 'debit', 'pix']).default('credit') }).strict(), req, res); if (!v) return;
    if (env() !== 'sandbox') return bad(res, 409, 'O teste só roda com ACBR_AMBIENTE=sandbox');
    const t = await loadTenant(req.params.id); if (!t) return bad(res, 404, 'Loja não encontrada');
    const ap = addressProblems(t.fiscal_address); if (ap.length) return bad(res, 400, ap.join('; '));
    const s = testSale(t, v.method === 'debit' ? 'credit' : v.method);
    if (v.method === 'debit') { s.sale.payment_method = 'debit'; s.sale.tef[0].method = 'debit'; }
    // Reserva o número da homologação e grava o documento antes de transmitir (se cair no meio, dá para consultar).
    const client = await db.connect(); let docRow, payload;
    try {
      await client.query('BEGIN');
      const n = (await client.query('UPDATE tenants SET nfce_hom_next_number = nfce_hom_next_number + 1 WHERE id=$1 RETURNING nfce_series, nfce_hom_next_number - 1 AS number', [t.id])).rows[0];
      const { doc, problems } = buildNfce({ tenant: { ...t, fiscal_env: 'homologacao' }, sale: s.sale, items: s.items, products: s.products, number: n.number });
      if (problems.length) { await client.query('ROLLBACK'); return bad(res, 400, problems.join('; ')); }
      const id = (await client.query('SELECT gen_random_uuid() id')).rows[0].id;
      payload = toAcbr(doc, { address: t.fiscal_address, referencia: id });
      docRow = (await client.query(`INSERT INTO fiscal_documents(id,tenant_id,sale_id,model,env,series,number,status,provider,payload,is_test)
        VALUES($1,$2,NULL,65,'homologacao',$3,$4,'processing','acbr',$5,true) RETURNING id`, [id, t.id, doc.series, doc.number, payload])).rows[0];
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    let out;
    try {
      const r = await call('/nfce', { method: 'POST', body: payload, ms: 60000 });
      out = fromAcbr(r);
      await q('UPDATE fiscal_documents SET status=$2,provider_ref=$3,access_key=$4,protocol=$5,error=$6,response=$7,updated_at=now() WHERE id=$1', [docRow.id, out.status, out.provider_ref, out.access_key, out.protocol, out.error, r]);
    } catch (e) {
      // Timeout: fica "processing" e se consulta depois. Erro de validação (4xx): a ACBr não transmitiu.
      const st = e.timeout ? 'processing' : 'error';
      await q('UPDATE fiscal_documents SET status=$2,error=$3,response=$4,updated_at=now() WHERE id=$1', [docRow.id, st, e.message, e.body || null]);
      out = { status: st, error: e.message, provider_ref: null };
    }
    await audit(req, 'acbr_test_nfce', 'tenant', t.id, t.id);
    res.json({ id: docRow.id, number: payload.infNFe.ide.nNF, series: payload.infNFe.ide.serie, method: v.method, ...out });
  }));

  // Consulta o documento na ACBr (depois de timeout ou para atualizar a situação).
  app.post('/api/master/fiscal-documents/:id/sync', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const d = (await q("SELECT f.*, t.cnpj FROM fiscal_documents f JOIN tenants t ON t.id=f.tenant_id WHERE f.id=$1 AND f.provider='acbr'", [req.params.id])).rows[0];
    if (!d) return bad(res, 404, 'Documento não encontrado');
    try {
      let r = d.provider_ref ? await call('/nfce/' + d.provider_ref) : null;
      if (!r) {
        const list = await call(`/nfce?cpf_cnpj=${d.cnpj}&ambiente=${d.env}&referencia=${encodeURIComponent(d.id)}&$top=1`);
        r = (Array.isArray(list) ? list : list?.data || [])[0] || null;
      }
      if (!r) return res.json({ id: d.id, status: d.status, found: false, error: 'A ACBr não tem este documento: ele não chegou a ser transmitido' });
      const out = fromAcbr(r);
      await q('UPDATE fiscal_documents SET status=$2,provider_ref=$3,access_key=$4,protocol=$5,error=$6,response=$7,updated_at=now() WHERE id=$1', [d.id, out.status, out.provider_ref, out.access_key, out.protocol, out.error, r]);
      res.json({ id: d.id, found: true, ...out });
    } catch (e) { fail(res, e); }
  }));
}
