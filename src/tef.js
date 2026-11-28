// TEF Stone pelo AutoTEF (cartão e Pix no pinpad do quiosque).
// Documentação conferida em 25/11/2026: https://autotef.readme.io (Slim: API REST local em http://localhost:8000).
//
// Fluxo (o navegador do caixa fala com o Slim; o servidor só registra):
//   1. caixa → POST /api/store/tef/transactions        guarda a cobrança como "pending" ANTES do pinpad;
//   2. caixa → Slim /api/Pay (ou /api/Pix/Pay + /api/Pix/Status);
//   3. caixa → POST /api/store/tef/transactions/:id/result com a resposta do Slim, como veio;
//   4. caixa → POST /api/store/sales com tef_transaction_ids (a venda só grava se a cobrança foi aprovada
//      e o valor bate). Se a venda não gravar, a cobrança aprovada vira "estorno pendente" no caixa.
// O servidor interpreta a resposta do Slim aqui (um lugar só, testado), para o caixa não decidir sozinho.
import { z } from 'zod';

// Stone Instituição de Pagamento S.A. (credenciadora): CNPJ que vai no grupo do cartão da NFC-e.
export const STONE_CNPJ = '16501555000157';
// Nome da aplicação (partnerName) que o caixa manda na ativação do pinpad: é o "Partner.name" da homologação.
export const PARTNER_NAME = 'FICOUPRONTO 1.0';
export const TEF_MODES = ['off', 'simulator', 'sandbox', 'production'];
const digits = v => String(v ?? '').replace(/\D/g, '');
const str = (v, max) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);

// Bandeira (tBand da NFC-e) a partir do nome que o AutoTEF devolve ("MASTER CREDITO ", "VISA DEBITO", "ELO"...).
// Códigos da tabela tBand (01 a 09 e 99 são estáveis; os demais conferir com o emissor na homologação).
const BRANDS = [
  [/\bVISA\b|\bELECTRON\b/, '01'], [/\bMASTER|\bMAESTRO\b/, '02'], [/\bAMEX\b|AMERICAN/, '03'], [/SOROCRED/, '04'],
  [/DINERS/, '05'], [/\bELO\b/, '06'], [/HIPERCARD/, '07'], [/\bAURA\b/, '08'], [/CABAL/, '09'],
  [/ALELO/, '10'], [/DISCOVER/, '14'], [/\bJCB\b/, '18'], [/SODEXO|PLUXEE/, '23'], [/\bVR\b/, '26'], [/TICKET/, '27'],
];
export function brandCode(...names) {
  const s = names.filter(Boolean).join(' ').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!s.trim()) return null;
  for (const [re, code] of BRANDS) if (re.test(s)) return code;
  return '99';
}

// Lê um campo aceitando a capitalização que o Slim usar (a documentação mistura ResponseCode/responseCode).
const pick = (o, ...keys) => {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) {
    if (o[k] !== undefined) return o[k];
    const hit = Object.keys(o).find(x => x.toLowerCase() === k.toLowerCase());
    if (hit) return o[hit];
  }
  return undefined;
};

// Resposta do Slim → campos da cobrança. kind: 'card' (POST /api/Pay), 'pix_created' (POST /api/Pix/Pay),
// 'pix_status' (POST /api/Pix/Status) ou 'lost' (o caixa não recebeu resposta: queda, tempo esgotado).
// http: status HTTP da resposta (200 = aprovado/criado; 400 = recusa ou erro, com responseCode).
export function interpretSlim(kind, http, body) {
  const code = str(pick(body, 'responseCode'), 20);
  const reason = str(pick(body, 'responseReason'), 300);
  const display = str(pick(body, 'messageDisplay'), 300);
  if (kind === 'lost') return { status: 'unknown', message: 'Sem resposta do pinpad. Confira no app/extrato da Stone antes de cobrar de novo.' };
  if (kind === 'card') {
    // O Slim real (produção, 27/11/2026) devolve os dados dentro de "receipt" e "card"; a documentação mostra tudo no topo.
    // Lê o "receipt" primeiro e cai para o topo.
    const rc = pick(body, 'receipt'), cd = pick(body, 'card');
    const get = (...k) => { const x = pick(rc, ...k); return x !== undefined && x !== null && x !== '' ? x : pick(body, ...k); };
    const atk = get('acquirerTransactionKey');
    if (http === 200 && atk) {
      const brand = str(get('brandName'), 60) || str(pick(cd, 'brandName'), 60);
      return {
        status: 'approved', provider_tx: str(atk, 80), auth_code: str(get('authorisationCode', 'authorizationCode'), 80),
        brand_name: brand, brand_code: brandCode(brand, get('productBrandCard')),
        // O estorno confere o cartão pela máscara: guarda a mais completa (com os 6 primeiros dígitos) quando vier.
        card_mask: str(pick(cd, 'maskedPan', 'maskedPrimaryAccountNumber'), 30) || str(get('maskedPrimaryAccountNumber'), 30),
        merchant_document: digits(get('merchantDocument')).slice(0, 20) || null, stone_code: str(get('stoneCode'), 20),
        client_receipt: str(get('clientVia'), 8000), merchant_receipt: str(get('merchantVia'), 8000),
        message: str(get('messageDisplay'), 300) || display || 'Aprovado',
      };
    }
    // DECL = recusada pelo emissor/Stone. Demais (TECH, N404 pinpad, N401 vencido, G002 sem ativação) = erro.
    if (code === 'N404' || code === 'G999') return { status: 'error', error_code: code, message: 'pinpad desconectado ou em outra entrada USB (' + code + '). Clique em Finalizar de novo: o caixa procura o pinpad sozinho' };
    return { status: code === 'DECL' ? 'declined' : 'error', error_code: code, message: display || reason || (http === 200 ? 'Resposta sem identificador da transação' : 'Erro no pinpad') };
  }
  if (kind === 'pix_created') {
    const id = str(pick(body, 'transactionId'), 80);
    if (http === 200 && id && pick(body, 'wasSuccessfull', 'wasSuccessful') !== false) return { status: 'pending', provider_tx: id, message: 'QR Code do Pix gerado' };
    return { status: 'error', error_code: code, message: display || reason || 'Não foi possível gerar o Pix' };
  }
  if (kind === 'pix_status') {
    const receipt = pick(body, 'receipt') || {};
    const e2e = pick(body, 'endTwoEndIdentification', 'endToEndIdentification', 'endToEndId');
    if (http === 200 && code === '0000' && pick(body, 'wasSuccessfull', 'wasSuccessful') !== false) {
      return {
        status: 'approved', e2e_id: str(Array.isArray(e2e) ? e2e[0] : e2e, 60), auth_code: str(Array.isArray(e2e) ? e2e[0] : e2e, 80),
        merchant_document: digits(pick(receipt, 'merchantDocument')).slice(0, 20) || null, stone_code: str(pick(receipt, 'stoneCode'), 20),
        client_receipt: str(pick(receipt, 'clientVia'), 8000), merchant_receipt: str(pick(receipt, 'merchantVia'), 8000), message: 'Pix recebido',
      };
    }
    if (code === 'C207' || pick(body, 'isExpired') === true) return { status: 'expired', error_code: code, message: 'O Pix expirou sem pagamento' };
    return { status: 'error', error_code: code, message: display || reason || 'Pix não confirmado' };
  }
  throw new Error('Tipo de resposta desconhecido');
}

// Dados da cobrança aprovada para a NFC-e (grupo card / IN 87/2025), no formato de sales.tef.
export const tefForSale = t => ({
  method: t.method, amount_cents: t.amount_cents, acquirer_cnpj: STONE_CNPJ, brand: t.method === 'pix' ? null : t.brand_code,
  auth: t.method === 'pix' ? t.e2e_id || t.auth_code : t.auth_code, terminal_id: t.terminal_serial || t.stone_code || null,
  nsu: t.provider_tx, tef_transaction_id: t.id, ...(t.mode === 'simulator' ? { simulated: true } : {}),
});

const PUBLIC = 'id,sale_id,mode,method,amount_cents,installments,status,provider_tx,auth_code,brand_name,card_mask,e2e_id,error_code,message,created_at,finished_at,reversed_at,resolved_note';

// Resposta do estorno (POST /api/Cancel/) → ATK, data/hora e via do estorno (lê "receipt" primeiro, como no pagamento).
export function reversalOf(body) {
  if (!body || typeof body !== 'object') return { atk: null, datetime: null, auth_code: null, receipt: null };
  const rc = pick(body, 'receipt');
  const get = (...k) => { const x = pick(rc, ...k); return x !== undefined && x !== null && x !== '' ? x : pick(body, ...k); };
  return { atk: str(get('acquirerTransactionKey'), 80), datetime: str(get('transactionDateTime', 'cancellationDateTime'), 40),
    auth_code: str(get('authorisationCode', 'authorizationCode'), 80), receipt: str(get('clientVia'), 8000) || str(get('merchantVia'), 8000) };
}

// Comprovante a partir da cobrança gravada (a resposta do Slim fica em response; os dados vêm dentro de "receipt"/"card").
const READING = { EMVProximityReader: 'Aproximação (NFC)', EMVChip: 'Chip', EMV: 'Chip', MagneticStripe: 'Tarja magnética' };
export function receiptOf(t) {
  const body = t.response || {}, rc = pick(body, 'receipt') || {}, cd = pick(body, 'card') || {};
  const get = (...k) => { const x = pick(rc, ...k); return x !== undefined && x !== null && x !== '' ? x : pick(body, ...k); };
  const reading = str(get('cardReadingType'), 40);
  return {
    id: t.id, mode: t.mode, method: t.method, status: t.status, amount_cents: t.amount_cents, installments: t.installments,
    sale_number: t.sale_number ?? null, merchant_name: t.merchant_name || null, merchant_document: t.merchant_document || t.unit_cnpj || null,
    merchant_address: str(get('merchantAddress'), 200), stone_code: t.stone_code || str(get('stoneCode'), 20),
    brand_name: t.brand_name || str(get('brandName'), 60), card_mask: t.card_mask || str(pick(cd, 'maskedPan'), 30),
    reading: reading ? (READING[reading] || (/proxim|nfc|contactless/i.test(reading) ? 'Aproximação (NFC)' : /chip|emv/i.test(reading) ? 'Chip' : reading)) : null,
    transaction_datetime: str(get('transactionDateTime'), 40), auth_code: t.auth_code, atk: t.provider_tx, itk: str(get('initiatorTransactionKey'), 80),
    e2e_id: t.e2e_id, terminal_serial: t.terminal_serial, message: t.message, error_code: t.error_code,
    client_receipt: t.client_receipt, created_at: t.created_at, finished_at: t.finished_at, reversed_at: t.reversed_at,
    reversal: t.reversed_at ? { ...reversalOf(t.reversal_response), receipt: t.reversal_receipt || null } : null,
  };
}

export function registerTef(app, { q, auth, roles, route, bad, valid, audit, uuid }) {
  const tid = req => req.user.tenant_id;
  const salesOn = route(async (req, res, next) => {
    const r = await q('SELECT sales_enabled FROM tenants WHERE id=$1', [tid(req)]);
    if (!r.rows[0]?.sales_enabled) return bad(res, 403, 'Caixa não está habilitado para esta loja');
    next();
  });
  const staff = [auth, roles('owner', 'operator'), salesOn];
  const master = [auth, roles('master')];
  const unitTef = async req => (await q(`SELECT sales_enabled,tef_mode,tef_stone_code,tef_pinpad_port,tef_local_url,cnpj,coalesce(unit_label,name) label
    FROM tenants WHERE id=$1`, [tid(req)])).rows[0];
  const id = (req, res) => uuid.safeParse(req.params.id).success || (bad(res, 400, 'Cobrança inválida'), false);

  // Configuração do TEF para o caixa (nunca devolve segredo: o Stone Code não é senha, só identifica a conta).
  app.get('/api/store/tef/config', ...staff, route(async (req, res) => {
    const t = await unitTef(req);
    res.set('Cache-Control', 'no-store').json({
      mode: t?.sales_enabled ? t.tef_mode : 'off', stone_code: t?.tef_stone_code || null, pinpad_port: t?.tef_pinpad_port || null,
      local_url: t?.tef_local_url || 'http://127.0.0.1:8000', partner_name: PARTNER_NAME, cnpj: t?.cnpj || null,
    });
  }));

  // 1. Registra a cobrança antes de ir ao pinpad.
  app.post('/api/store/tef/transactions', ...staff, route(async (req, res) => {
    const v = valid(z.object({ method: z.enum(['credit', 'debit', 'pix']), amount_cents: z.number().int().min(1).max(100000000),
      installments: z.number().int().min(1).max(24).default(1) }).strict(), req, res); if (!v) return;
    const t = await unitTef(req);
    if (!t?.sales_enabled || !t.tef_mode || t.tef_mode === 'off') return bad(res, 409, 'O TEF não está ligado nesta unidade');
    if (t.tef_mode !== 'simulator' && !t.tef_stone_code) return bad(res, 409, 'Unidade sem Stone Code cadastrado na central');
    if (v.method !== 'credit' && v.installments !== 1) return bad(res, 400, 'Parcelamento só no crédito');
    // Uma cobrança por vez: outra ainda sem resposta há menos de 3 minutos bloqueia (evita cobrar duas vezes).
    const busy = await q(`SELECT id FROM tef_transactions WHERE tenant_id=$1 AND status='pending' AND created_at > now() - interval '3 minutes' AND method<>'pix'`, [tid(req)]);
    if (busy.rowCount && v.method !== 'pix') return bad(res, 409, 'Há uma cobrança em andamento no pinpad. Aguarde a resposta ou resolva em "Pendências do pinpad".');
    const r = await q(`INSERT INTO tef_transactions(tenant_id,mode,method,amount_cents,installments,created_by,stone_code) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${PUBLIC}`,
      [tid(req), t.tef_mode, v.method, v.amount_cents, v.installments, req.user.id, t.tef_stone_code]);
    res.status(201).json(r.rows[0]);
  }));

  // 3. Resultado do pinpad. kind/http/body = o que o Slim respondeu (o servidor interpreta).
  // terminal_serial: número de série do pinpad (vem da ativação /api/Activate), para a identificação do terminal na NFC-e.
  app.post('/api/store/tef/transactions/:id/result', ...staff, route(async (req, res) => {
    if (!id(req, res)) return;
    const v = valid(z.object({ kind: z.enum(['card', 'pix_created', 'pix_status', 'lost']), http: z.number().int().min(0).max(599).default(0),
      body: z.record(z.any()).nullable().default(null), terminal_serial: z.string().trim().max(40).optional() }).strict(), req, res); if (!v) return;
    const cur = (await q('SELECT * FROM tef_transactions WHERE id=$1 AND tenant_id=$2', [req.params.id, tid(req)])).rows[0];
    if (!cur) return bad(res, 404, 'Cobrança não encontrada');
    if (!['pending', 'unknown'].includes(cur.status)) return bad(res, 409, 'Esta cobrança já foi finalizada');
    if ((v.kind === 'card') !== (cur.method !== 'pix') && v.kind !== 'lost') return bad(res, 400, 'Resposta não combina com a forma de pagamento');
    if (v.kind === 'pix_status' && !cur.provider_tx) return bad(res, 400, 'Pix ainda sem QR Code');
    const out = interpretSlim(v.kind, v.http, v.body);
    // Pix já aprovado não volta para "sem resposta"; e "lost" num Pix com QR gerado fica pendente (ainda pode ser pago).
    if (v.kind === 'lost' && cur.method === 'pix' && cur.provider_tx) out.status = 'pending';
    const warn = [];
    if (out.status === 'approved' && out.merchant_document && cur.mode !== 'simulator') {
      const unit = await unitTef(req);
      if (unit?.cnpj && out.merchant_document !== unit.cnpj) warn.push('O CNPJ do comprovante não é o desta unidade: confira o Stone Code configurado.');
    }
    // Guarda a resposta sem os comprovantes (que já vão em colunas próprias).
    const raw = v.body ? JSON.parse(JSON.stringify(v.body, (k, x) => (/^(clientVia|merchantVia|qrCodeImage)$/i.test(k) ? undefined : x))) : null;
    const fields = { ...out, terminal_serial: str(v.terminal_serial, 40) || cur.terminal_serial };
    const cols = ['status', 'provider_tx', 'auth_code', 'brand_name', 'brand_code', 'card_mask', 'e2e_id', 'merchant_document', 'stone_code', 'terminal_serial', 'error_code', 'message', 'client_receipt', 'merchant_receipt'];
    const set = cols.map((c, i) => `${c}=coalesce($${i + 3},${c})`).join(',');
    const r = await q(`UPDATE tef_transactions SET ${set},response=coalesce($${cols.length + 3}::jsonb,response),
        finished_at=CASE WHEN $3 IN ('pending','unknown') THEN finished_at ELSE now() END
      WHERE id=$1 AND tenant_id=$2 AND status IN ('pending','unknown') RETURNING ${PUBLIC}`,
      [req.params.id, tid(req), ...cols.map(c => fields[c] ?? null), raw ? JSON.stringify(raw) : null]);
    if (!r.rowCount) return bad(res, 409, 'Esta cobrança já foi finalizada');
    res.json({ ...r.rows[0], warnings: warn });
  }));

  // Pendências do pinpad: aprovadas sem venda (ou de venda cancelada) e cobranças sem resposta.
  app.get('/api/store/tef/pending', ...staff, route(async (req, res) => {
    const r = await q(`SELECT ${PUBLIC.split(',').map(c => 't.' + c).join(',')},s.sale_number,s.canceled_at sale_canceled_at,u.name created_by_name,
        CASE WHEN t.status IN ('pending','unknown') THEN 'no_answer' WHEN s.id IS NULL THEN 'no_sale' ELSE 'sale_canceled' END reason
      FROM tef_transactions t LEFT JOIN sales s ON s.id=t.sale_id LEFT JOIN users u ON u.id=t.created_by
      WHERE t.tenant_id=$1 AND t.resolved_note IS NULL AND (
        (t.status IN ('pending','unknown') AND t.created_at < now() - interval '2 minutes')
        OR (t.status='approved' AND (t.sale_id IS NULL AND t.created_at < now() - interval '1 minute' OR s.canceled_at IS NOT NULL)))
      ORDER BY t.created_at DESC LIMIT 50`, [tid(req)]);
    res.set('Cache-Control', 'no-store').json({ items: r.rows });
  }));

  // Estorno feito no pinpad (POST /api/Cancel/ do Slim respondeu 200): marca a cobrança como estornada.
  // Dados que o caixa precisa para pedir o estorno ao Slim (ATK, valor, tipo e cartão mascarado).
  app.get('/api/store/tef/transactions/:id/cancel-data', ...staff, route(async (req, res) => {
    if (!id(req, res)) return;
    const t = (await q(`SELECT id,mode,method,amount_cents,provider_tx,card_mask,status FROM tef_transactions WHERE id=$1 AND tenant_id=$2`, [req.params.id, tid(req)])).rows[0];
    if (!t) return bad(res, 404, 'Cobrança não encontrada');
    if (t.status !== 'approved') return bad(res, 409, 'Só cobrança aprovada pode ser estornada');
    if (t.method === 'pix') return bad(res, 409, 'Devolução de Pix é feita pelo app da Stone (o AutoTEF não documenta estorno de Pix pelo pinpad)');
    res.set('Cache-Control', 'no-store').json({ id: t.id, mode: t.mode, request: { acquirerTransactionKey: t.provider_tx, amount: t.amount_cents / 100, transactionType: t.method, panMask: t.card_mask } });
  }));
  app.post('/api/store/tef/transactions/:id/reversed', ...staff, route(async (req, res) => {
    if (!id(req, res)) return;
    if (req.user.access_level === 'basic' && !req.user.kiosk) return bad(res, 403, 'Seu acesso (operador novato) não permite estornar');
    // body: resposta do /api/Cancel/ do Slim, como veio (ATK, data e via do estorno para o comprovante).
    const v = valid(z.object({ body: z.record(z.any()).nullable().default(null) }).strict(), req, res); if (!v) return;
    const rv = reversalOf(v.body);
    const raw = v.body ? JSON.stringify(JSON.parse(JSON.stringify(v.body, (k, x) => (/^(clientVia|merchantVia)$/i.test(k) ? undefined : x)))) : null;
    const r = await q(`UPDATE tef_transactions t SET status='reversed',reversed_at=now(),reversed_by=$3,reversal_response=$4::jsonb,reversal_receipt=$5
      WHERE t.id=$1 AND t.tenant_id=$2 AND t.status='approved' AND t.method<>'pix'
        AND (t.sale_id IS NULL OR EXISTS(SELECT 1 FROM sales s WHERE s.id=t.sale_id AND s.canceled_at IS NOT NULL)) RETURNING ${PUBLIC}`, [req.params.id, tid(req), req.user.id, raw, rv.receipt]);
    if (!r.rowCount) return bad(res, 409, 'Só dá para estornar cobrança aprovada sem venda ou de venda cancelada');
    await audit(req, 'tef_reversed', 'tef_transaction', req.params.id); res.json(r.rows[0]);
  }));
  // Resolver à mão (ex.: conferido no app da Stone que a cobrança sem resposta não passou, ou Pix devolvido pelo app).
  app.post('/api/store/tef/transactions/:id/resolve', ...staff, route(async (req, res) => {
    if (!id(req, res)) return;
    if (req.user.access_level === 'basic' && !req.user.kiosk) return bad(res, 403, 'Seu acesso (operador novato) não permite esta ação');
    const v = valid(z.object({ note: z.string().trim().min(3).max(300) }).strict(), req, res); if (!v) return;
    const r = await q(`UPDATE tef_transactions SET resolved_note=$3,status=CASE WHEN status IN ('pending','unknown') THEN 'unknown' ELSE status END
      WHERE id=$1 AND tenant_id=$2 AND resolved_note IS NULL AND (status IN ('pending','unknown') OR (status='approved' AND
        (sale_id IS NULL OR EXISTS(SELECT 1 FROM sales s WHERE s.id=sale_id AND s.canceled_at IS NOT NULL)))) RETURNING ${PUBLIC}`, [req.params.id, tid(req), v.note]);
    if (!r.rowCount) return bad(res, 409, 'Esta cobrança não tem pendência');
    await audit(req, 'tef_resolved', 'tef_transaction', req.params.id); res.json(r.rows[0]);
  }));

  // Cobranças no pinpad de hoje (hora de Fortaleza), para conferir e abrir o comprovante.
  app.get('/api/store/tef/today', ...staff, route(async (req, res) => {
    const r = await q(`SELECT ${PUBLIC.split(',').map(c => 't.' + c).join(',')},s.sale_number FROM tef_transactions t LEFT JOIN sales s ON s.id=t.sale_id
      WHERE t.tenant_id=$1 AND t.created_at >= date_trunc('day', now() AT TIME ZONE 'America/Fortaleza') AT TIME ZONE 'America/Fortaleza'
      ORDER BY t.created_at DESC LIMIT 200`, [tid(req)]);
    res.set('Cache-Control', 'no-store').json({ items: r.rows });
  }));

  // Comprovante da cobrança no pinpad (cartão ou Pix), montado com os dados que a Stone devolveu.
  app.get('/api/store/tef/transactions/:id/receipt', ...staff, route(async (req, res) => {
    if (!id(req, res)) return;
    const t = (await q(`SELECT t.*,s.sale_number,coalesce(tn.legal_name,tn.name) merchant_name,tn.cnpj unit_cnpj FROM tef_transactions t
      LEFT JOIN sales s ON s.id=t.sale_id JOIN tenants tn ON tn.id=t.tenant_id WHERE t.id=$1 AND t.tenant_id=$2`, [req.params.id, tid(req)])).rows[0];
    if (!t) return bad(res, 404, 'Cobrança não encontrada');
    res.set('Cache-Control', 'no-store').json(receiptOf(t));
  }));

  // Central: TEF por unidade.
  app.get('/api/master/tenants/:id/tef', ...master, route(async (req, res) => {
    if (!id(req, res)) return;
    const t = (await q('SELECT tef_mode mode,tef_stone_code stone_code,tef_pinpad_port pinpad_port,tef_local_url local_url FROM tenants WHERE id=$1', [req.params.id])).rows[0];
    if (!t) return bad(res, 404, 'Loja não encontrada');
    const last = (await q(`SELECT mode,method,status,amount_cents,created_at FROM tef_transactions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 5`, [req.params.id])).rows;
    res.json({ ...t, partner_name: PARTNER_NAME, last });
  }));
  app.patch('/api/master/tenants/:id/tef', ...master, route(async (req, res) => {
    if (!id(req, res)) return;
    const v = valid(z.object({
      mode: z.enum(TEF_MODES).optional(),
      stone_code: z.preprocess(x => (x === '' ? null : x == null ? x : digits(x)), z.string().regex(/^\d{6,15}$/, 'Stone Code com 6 a 15 números').nullable()).optional(),
      pinpad_port: z.preprocess(x => (x === '' ? null : x == null ? x : String(x).trim().toUpperCase()), z.string().regex(/^COM\d{1,3}$/, 'Porta no formato COM4').nullable()).optional(),
      local_url: z.preprocess(x => (x === '' ? null : x), z.string().regex(/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/, 'Use http://127.0.0.1:porta').nullable()).optional(),
    }).strict(), req, res); if (!v) return;
    const map = { mode: 'tef_mode', stone_code: 'tef_stone_code', pinpad_port: 'tef_pinpad_port', local_url: 'tef_local_url' };
    const keys = Object.keys(v); if (!keys.length) return bad(res, 400, 'Nada para alterar');
    const cur = (await q('SELECT tef_mode,tef_stone_code FROM tenants WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return bad(res, 404, 'Loja não encontrada');
    const mode = v.mode ?? cur.tef_mode, code = 'stone_code' in v ? v.stone_code : cur.tef_stone_code;
    if (['sandbox', 'production'].includes(mode) && !code) return bad(res, 400, 'Cadastre o Stone Code antes de ligar o TEF');
    const r = await q(`UPDATE tenants SET ${keys.map((k, i) => map[k] + '=$' + (i + 2)).join(',')} WHERE id=$1
      RETURNING tef_mode mode,tef_stone_code stone_code,tef_pinpad_port pinpad_port,tef_local_url local_url`, [req.params.id, ...keys.map(k => v[k] ?? null)]);
    await audit(req, 'update_tef', 'tenant', req.params.id, req.params.id);
    res.json(r.rows[0]);
  }));
}
