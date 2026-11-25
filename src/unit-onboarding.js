// Implantação por unidade: o checklist "unidade pronta" (Audace, 24/11/2026) dentro do sistema.
// - Itens automáticos: o sistema confere nos dados reais (peças, PINs, NFC-e, TEF, caixa...).
// - Itens manuais: marcados por quem fez, com data e observação.
// - "Aguardando a rede": item nosso ou conjunto parado por falta de algo da rede (dados, equipamento,
//   internet, presença no treinamento). Não conta contra o nosso prazo nem impede a cobrança.
// - Nossa parte 100% (itens FicouPronto e conjuntos feitos, sem aplicação ou aguardando a rede) = pronta para cobrar.
// - Aceite: dono ou supervisor da unidade confirma com o login dele quando TODOS os itens estão feitos.
import { z } from 'zod';

export const ONBOARDING_SECTIONS = ['Dados e cadastro', 'Equipamentos e internet', 'Nota fiscal (NFC-e)', 'Pagamento (TEF Stone)', 'Treinamento', 'Venda real assistida'];

// who: fp = FicouPronto, rede = a rede (ex.: Audace), both = os dois.
export const ONBOARDING_ITEMS = [
  { key: 'products', sec: 0, who: 'fp', auto: true, title: 'Peças importadas da planilha, com código, preço, NCM e estoque' },
  { key: 'customers', sec: 0, who: 'fp', auto: true, title: 'Clientes importados da planilha' },
  { key: 'stock_count', sec: 0, who: 'rede', title: 'Contagem de estoque da unidade conferida, sem estoque negativo' },
  { key: 'people', sec: 0, who: 'fp', auto: true, title: 'Vendedoras com PIN; supervisor e dono com login próprio' },
  { key: 'kiosk_password', sec: 0, who: 'fp', auto: true, title: 'Senha do quiosque da unidade criada e entregue ao responsável' },
  { key: 'pc', sec: 1, who: 'both', auto: true, title: 'Computador do quiosque na internet, com o FicouPronto aberto e aparecendo na central' },
  { key: 'reader', sec: 1, who: 'fp', title: 'Leitor de código de barras lendo as etiquetas da unidade de primeira' },
  { key: 'printer', sec: 1, who: 'rede', title: 'Impressora do cupom imprimindo' },
  { key: 'pinpad', sec: 1, who: 'rede', title: 'Pinpad da Stone conectado ao computador' },
  { key: 'certificate', sec: 2, who: 'fp', auto: true, title: 'Certificado A1 da unidade configurado (QR Code v3, sem CSC)' },
  { key: 'nfce_series', sec: 2, who: 'rede', title: 'Série e último número da NFC-e informados' },
  { key: 'nfce_test', sec: 2, who: 'both', auto: true, title: 'NFC-e de teste autorizada pela SEFAZ e cupom impresso' },
  { key: 'nfce_cancel', sec: 2, who: 'both', auto: true, title: 'Cancelamento de NFC-e de teste feito' },
  { key: 'tef_key', sec: 3, who: 'fp', auto: true, title: 'Chave TEF (Stone Code) da unidade configurada' },
  { key: 'tef_payments', sec: 3, who: 'both', auto: true, title: 'Venda no débito, no crédito e no Pix pelo pinpad, com o valor indo sozinho do caixa' },
  { key: 'tef_on_nfce', sec: 3, who: 'fp', auto: true, title: 'Dados do pagamento saindo na NFC-e (bandeira, autorização, terminal)' },
  { key: 'tef_offline', sec: 3, who: 'both', title: 'Teste do modo "pinpad fora do ar": venda na maquininha avulsa e pendência registrada' },
  { key: 'train_sale', sec: 4, who: 'both', title: 'Vendedoras: abrir o caixa, bipar, escolher a cliente, usar cashback, cobrar, confirmar com PIN' },
  { key: 'train_close', sec: 4, who: 'both', title: 'Vendedoras: sangria, fechamento e "Meu dia"' },
  { key: 'train_supervisor', sec: 4, who: 'both', title: 'Supervisor: cancelar venda, conferir o caixa, ver o painel da loja' },
  { key: 'train_owner', sec: 4, who: 'both', title: 'Dono: painel da rede e relatórios' },
  { key: 'real_sale', sec: 5, who: 'both', auto: true, title: 'Uma venda real completa, do bipe ao cupom e à mensagem de WhatsApp da cliente' },
  { key: 'first_close', sec: 5, who: 'both', auto: true, title: 'Fechamento do caixa do primeiro dia conferido com o supervisor' },
];
const BY_KEY = new Map(ONBOARDING_ITEMS.map(i => [i.key, i]));
const n = v => Number(v || 0);
const plural = (k, one, many) => k + ' ' + (k === 1 ? one : many);

// Fatos de cada unidade, numa consulta só.
async function facts(q, ids) {
  if (!ids.length) return new Map();
  const rows = (await q(`SELECT t.id, t.nfce_series, t.nfce_next_number, t.tef_mode, t.tef_stone_code IS NOT NULL has_stone_code,
      (SELECT count(*) FROM products p WHERE p.tenant_id=t.id AND p.active) products,
      (SELECT count(*) FROM products p WHERE p.tenant_id=t.id AND p.active AND p.barcode IS NOT NULL AND p.ncm IS NOT NULL AND p.price_cents > 0) products_full,
      (SELECT count(*) FROM products p WHERE p.tenant_id=t.id AND p.active AND p.stock_qty < 0) negative_stock,
      (SELECT count(*) FROM customers c WHERE c.tenant_id=t.id AND c.deleted_at IS NULL) customers,
      (SELECT count(*) FROM users u WHERE u.tenant_id=t.id AND u.active AND u.login_kind='pin') sellers,
      (SELECT count(*) FROM users u WHERE u.role='network' AND u.active AND u.network_id=t.network_id AND u.network_access='supervisor' AND t.id = ANY(u.network_unit_ids)) supervisors,
      (SELECT count(*) FROM users u WHERE u.role='network' AND u.active AND u.network_id=t.network_id AND coalesce(u.network_access,'owner')='owner') owners,
      EXISTS (SELECT 1 FROM users u WHERE u.tenant_id=t.id AND u.active AND u.login_kind='kiosk' AND u.password_hash IS NOT NULL) kiosk_password,
      (SELECT max(a.created_at) FROM audit_events a WHERE a.tenant_id=t.id AND a.action='kiosk_open') kiosk_open_at,
      (SELECT max(a.created_at) FROM audit_events a WHERE a.tenant_id=t.id AND a.action='acbr_certificate') certificate_at,
      (SELECT count(*) FROM fiscal_documents f WHERE f.tenant_id=t.id AND f.status='authorized') nfce_authorized,
      (SELECT count(*) FROM fiscal_documents f WHERE f.tenant_id=t.id AND f.status='canceled') nfce_canceled,
      (SELECT coalesce(array_agg(DISTINCT x.method), '{}') FROM tef_transactions x WHERE x.tenant_id=t.id AND x.status='approved' AND x.mode IN ('sandbox','production')) tef_methods,
      EXISTS (SELECT 1 FROM fiscal_documents f JOIN sales s ON s.id=f.sale_id WHERE f.tenant_id=t.id AND f.status IN ('authorized','canceled') AND s.tef IS NOT NULL) tef_on_nfce,
      (SELECT min(f.created_at) FROM fiscal_documents f WHERE f.tenant_id=t.id AND f.env='producao' AND f.status='authorized' AND NOT f.is_test) real_sale_at,
      (SELECT min(c.reviewed_at) FROM cash_sessions c WHERE c.tenant_id=t.id AND c.status='closed' AND c.reviewed_at IS NOT NULL) first_close_at
    FROM tenants t WHERE t.id = ANY($1::uuid[])`, [ids])).rows;
  return new Map(rows.map(r => [r.id, r]));
}

const day = d => d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' }) : '';

// Item automático: { ok, detail }
function autoCheck(key, f) {
  switch (key) {
    case 'products': return { ok: n(f.products_full) > 0, detail: plural(n(f.products), 'peça', 'peças') + (n(f.products) > n(f.products_full) ? ' · ' + (n(f.products) - n(f.products_full)) + ' sem código, NCM ou preço' : '') };
    case 'customers': return { ok: n(f.customers) > 0, detail: plural(n(f.customers), 'cliente', 'clientes') };
    case 'people': return { ok: n(f.sellers) > 0 && n(f.supervisors) > 0 && n(f.owners) > 0, detail: plural(n(f.sellers), 'vendedora com PIN', 'vendedoras com PIN') + ' · ' + plural(n(f.supervisors), 'supervisor', 'supervisores') + ' · ' + plural(n(f.owners), 'dono', 'donos') };
    case 'kiosk_password': return { ok: !!f.kiosk_password, detail: f.kiosk_password ? 'Senha criada' : 'Sem senha do quiosque' };
    case 'pc': return { ok: !!f.kiosk_open_at, detail: f.kiosk_open_at ? 'Quiosque aberto pela última vez em ' + day(f.kiosk_open_at) : 'O quiosque ainda não foi aberto' };
    case 'certificate': return { ok: !!f.certificate_at, detail: f.certificate_at ? 'Enviado em ' + day(f.certificate_at) : 'Certificado não enviado' };
    case 'nfce_test': return { ok: n(f.nfce_authorized) > 0, detail: plural(n(f.nfce_authorized), 'nota autorizada', 'notas autorizadas') };
    case 'nfce_cancel': return { ok: n(f.nfce_canceled) > 0, detail: plural(n(f.nfce_canceled), 'nota cancelada', 'notas canceladas') };
    case 'tef_key': return { ok: f.has_stone_code && ['sandbox', 'production'].includes(f.tef_mode), detail: f.has_stone_code ? 'Modo ' + ({ off: 'desligado', simulator: 'simulador', sandbox: 'teste Stone', production: 'produção' }[f.tef_mode] || f.tef_mode) : 'Sem Stone Code' };
    case 'tef_payments': { const m = f.tef_methods || []; const lab = { debit: 'débito', credit: 'crédito', pix: 'Pix' }; const miss = ['debit', 'credit', 'pix'].filter(x => !m.includes(x));
      return { ok: !miss.length, detail: miss.length ? 'Falta: ' + miss.map(x => lab[x]).join(', ') : 'Débito, crédito e Pix aprovados' }; }
    case 'tef_on_nfce': return { ok: !!f.tef_on_nfce, detail: f.tef_on_nfce ? 'NFC-e com pagamento do pinpad emitida' : 'Nenhuma NFC-e com pagamento do pinpad ainda' };
    case 'real_sale': return { ok: !!f.real_sale_at, detail: f.real_sale_at ? 'Primeira NFC-e real em ' + day(f.real_sale_at) : 'Nenhuma NFC-e real (produção) ainda' };
    case 'first_close': return { ok: !!f.first_close_at, detail: f.first_close_at ? 'Conferido em ' + day(f.first_close_at) : 'Nenhum fechamento conferido ainda' };
  }
  return { ok: false, detail: '' };
}
// Dica para itens manuais.
function hint(key, f) {
  if (key === 'stock_count') return n(f.negative_stock) ? plural(n(f.negative_stock), 'peça com estoque negativo', 'peças com estoque negativo') : 'Nenhuma peça com estoque negativo';
  if (key === 'nfce_series') return 'No sistema: série ' + f.nfce_series + ', próxima nota nº ' + f.nfce_next_number;
  return '';
}

// Situação de uma unidade.
export function unitStatus(unit, f, marks) {
  const items = ONBOARDING_ITEMS.map(it => {
    const m = marks.get(it.key);
    const a = it.auto ? autoCheck(it.key, f) : null;
    let state = 'pending', source = null;
    if (a?.ok) { state = 'done'; source = 'auto'; }
    else if (m) { state = m.state; source = 'manual'; }
    return { key: it.key, section: it.sec, who: it.who, auto: !!it.auto, title: it.title, state, source,
      detail: a ? a.detail : hint(it.key, f), note: m?.note || null, marked_by: m?.marked_by_name || null, marked_at: m?.marked_at || null };
  });
  const ours = items.filter(i => i.who !== 'rede');
  const oursOk = ours.filter(i => ['done', 'na', 'waiting'].includes(i.state)).length;
  const missing = items.filter(i => !['done', 'na'].includes(i.state));
  return {
    id: unit.id, name: unit.label, billing_since: unit.billing_since,
    accepted_at: unit.onboarding_accepted_at, accepted_by: unit.onboarding_accepted_name,
    ours_total: ours.length, ours_ok: oursOk, ours_percent: Math.round(oursOk * 100 / ours.length),
    ready_to_bill: oursOk === ours.length, complete: !missing.length,
    missing_ours: missing.filter(i => i.who !== 'rede' && i.state !== 'waiting').map(i => i.title),
    missing_network: missing.filter(i => i.who === 'rede' || i.state === 'waiting').map(i => i.title),
    items,
  };
}

export function registerUnitOnboarding(app, { q, auth, roles, route, bad, valid, audit, uuid }) {
  const network = [auth, roles('network')], master = [auth, roles('master')];
  const scope = req => req.user.network_access === 'supervisor' ? (req.user.network_unit_ids || []) : null;

  async function load(networkId, unitIds) {
    const units = (await q(`SELECT id, coalesce(unit_label,name) label, billing_since, onboarding_accepted_at, onboarding_accepted_name
      FROM tenants WHERE network_id=$1 AND NOT depot AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY lower(coalesce(unit_label,name))`, [networkId, unitIds])).rows;
    const ids = units.map(u => u.id);
    const [fx, mk] = await Promise.all([facts(q, ids),
      ids.length ? q('SELECT * FROM unit_onboarding_marks WHERE tenant_id = ANY($1::uuid[])', [ids]) : { rows: [] }]);
    const marks = new Map(ids.map(id => [id, new Map()]));
    for (const m of mk.rows) marks.get(m.tenant_id).set(m.item, m);
    return units.map(u => unitStatus(u, fx.get(u.id), marks.get(u.id)));
  }
  const sections = ONBOARDING_SECTIONS;

  // ---- Painel da rede (dono vê todas; supervisor, as unidades dele) ----
  app.get('/api/network/onboarding', ...network, route(async (req, res) => {
    const units = await load(req.user.network_id, scope(req));
    res.set('Cache-Control', 'no-store').json({ sections, units, can_mark: ['rede'], can_accept: true });
  }));

  const markBody = z.object({ state: z.enum(['done', 'waiting', 'na']).nullable(), note: z.string().trim().max(300).optional() }).strict();
  async function mark(req, res, tenantId, item, allowed) {
    const v = valid(markBody, req, res); if (!v) return;
    const it = BY_KEY.get(item); if (!it) return bad(res, 404, 'Item não existe');
    const err = allowed(it, v.state); if (err) return bad(res, 403, err);
    if (v.state === null) await q('DELETE FROM unit_onboarding_marks WHERE tenant_id=$1 AND item=$2', [tenantId, item]);
    else await q(`INSERT INTO unit_onboarding_marks(tenant_id,item,state,note,marked_by,marked_by_name) VALUES($1,$2,$3,$4,$5,(SELECT name FROM users WHERE id=$5))
      ON CONFLICT (tenant_id,item) DO UPDATE SET state=EXCLUDED.state, note=EXCLUDED.note, marked_by=EXCLUDED.marked_by, marked_by_name=EXCLUDED.marked_by_name, marked_at=now()`,
      [tenantId, item, v.state, v.note || null, req.user.id]);
    await audit(req, 'onboarding_mark', 'tenant', tenantId + ':' + item + ':' + (v.state || 'clear'), tenantId);
    res.json({ ok: true });
  }

  const unitOfNetwork = async (req, id) => {
    if (!uuid.safeParse(id).success) return null;
    const sc = scope(req);
    return (await q('SELECT id FROM tenants WHERE id=$1 AND network_id=$2 AND ($3::uuid[] IS NULL OR id = ANY($3))', [id, req.user.network_id, sc])).rows[0] || null;
  };

  // A rede marca os itens dela (feito ou desfazer).
  app.put('/api/network/onboarding/:tenantId/items/:item', ...network, route(async (req, res) => {
    const u = await unitOfNetwork(req, req.params.tenantId); if (!u) return bad(res, 404, 'Unidade fora do seu alcance');
    await mark(req, res, u.id, req.params.item, (it, state) => it.who !== 'rede' ? 'Este item é marcado pela FicouPronto' : (state && state !== 'done') ? 'Marque como feito ou desfaça' : null);
  }));

  // Aceite da unidade: só com todos os itens feitos.
  app.post('/api/network/onboarding/:tenantId/accept', ...network, route(async (req, res) => {
    const v = valid(z.object({ confirm: z.literal(true) }).strict(), req, res); if (!v) return;
    const u = await unitOfNetwork(req, req.params.tenantId); if (!u) return bad(res, 404, 'Unidade fora do seu alcance');
    const [st] = await load(req.user.network_id, [u.id]);
    if (st.accepted_at) return bad(res, 409, 'Esta unidade já tem aceite');
    if (!st.complete) return bad(res, 409, 'Ainda faltam itens: ' + [...st.missing_ours, ...st.missing_network].slice(0, 3).join('; '));
    await q(`UPDATE tenants SET onboarding_accepted_at=now(), onboarding_accepted_by=$2, onboarding_accepted_name=(SELECT name FROM users WHERE id=$2) WHERE id=$1`, [u.id, req.user.id]);
    await audit(req, 'onboarding_accept', 'tenant', u.id, u.id);
    res.json({ ok: true });
  }));

  // ---- Central (master) ----
  app.get('/api/master/networks/:id/onboarding', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const units = await load(req.params.id, null);
    const acc = (await q('SELECT id, unit_price_cents FROM billing_accounts WHERE network_id=$1', [req.params.id])).rows[0];
    res.set('Cache-Control', 'no-store').json({ sections, units, can_mark: ['fp', 'both', 'rede'], can_accept: false,
      billing_account_id: acc?.id || null, unit_price_cents: acc?.unit_price_cents || null });
  }));
  app.put('/api/master/onboarding/:tenantId/items/:item', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.tenantId).success) return bad(res, 400, 'ID inválido');
    const t = (await q('SELECT id FROM tenants WHERE id=$1 AND network_id IS NOT NULL', [req.params.tenantId])).rows[0];
    if (!t) return bad(res, 404, 'Unidade não encontrada');
    await mark(req, res, t.id, req.params.item, (it, state) => state === 'waiting' && it.who === 'rede' ? 'Item da rede não fica "aguardando a rede": deixe pendente' : null);
  }));
  // Desfazer um aceite dado por engano.
  app.delete('/api/master/onboarding/:tenantId/accept', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.tenantId).success) return bad(res, 400, 'ID inválido');
    await q('UPDATE tenants SET onboarding_accepted_at=NULL, onboarding_accepted_by=NULL, onboarding_accepted_name=NULL WHERE id=$1', [req.params.tenantId]);
    await audit(req, 'onboarding_accept_undo', 'tenant', req.params.tenantId, req.params.tenantId);
    res.json({ ok: true });
  }));
}
