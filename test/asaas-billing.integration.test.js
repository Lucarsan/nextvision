import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';
const WEBHOOK_TOKEN = 'teste-webhook-token-com-mais-de-32-caracteres-xyz';
const iso = (offset = 0) => new Date(Date.now() - 3 * 3600000 + offset * 86400000).toISOString().slice(0, 10);

// Asaas de mentira: guarda clientes, cobranças, assinaturas e webhooks em memória.
async function fakeAsaas() {
  const s = { customers: new Map(), payments: new Map(), subs: new Map(), webhooks: [], failGet: false, calls: [] };
  let n = 0; const id = p => p + '_' + (++n);
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c; const data = body ? JSON.parse(body) : {};
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.access_token !== '$aact_hmlg_teste') return send(401, { errors: [{ description: 'chave' }] });
    const u = new URL(req.url, 'http://x'), path = u.pathname.replace(/^\/v3/, ''); s.calls.push(req.method + ' ' + path);
    let m;
    if (req.method === 'POST' && path === '/customers') { if (!/^\d{11}$|^\d{14}$/.test(data.cpfCnpj || '')) return send(400, { errors: [{ description: 'CPF/CNPJ inválido' }] }); const c = { id: id('cus'), ...data }; s.customers.set(c.id, c); return send(200, c); }
    if (req.method === 'PUT' && (m = /^\/customers\/(.+)$/.exec(path))) { Object.assign(s.customers.get(m[1]), data); return send(200, s.customers.get(m[1])); }
    if (req.method === 'POST' && path === '/payments') { const p = { id: id('pay'), customer: data.customer, value: data.value, dueDate: data.dueDate, description: data.description, billingType: data.billingType, status: 'PENDING', deleted: false, invoiceUrl: 'https://www.asaas.com/i/' + n }; s.payments.set(p.id, p); return send(200, p); }
    if (req.method === 'GET' && path === '/payments') { const list = [...s.payments.values()].filter(p => p.customer === u.searchParams.get('customer') && !p.deleted); return send(200, { data: list, hasMore: false }); }
    if (req.method === 'GET' && (m = /^\/payments\/(.+)$/.exec(path))) { if (s.failGet) return send(500, { errors: [{ description: 'fora do ar' }] }); const p = s.payments.get(m[1]); return p ? send(200, p) : send(404, {}); }
    if (req.method === 'DELETE' && (m = /^\/payments\/(.+)$/.exec(path))) { s.payments.get(m[1]).deleted = true; return send(200, { deleted: true }); }
    if (req.method === 'POST' && (m = /^\/payments\/(.+)\/receiveInCash$/.exec(path))) { const p = s.payments.get(m[1]); Object.assign(p, { status: 'RECEIVED_IN_CASH', paymentDate: data.paymentDate }); return send(200, p); }
    if (req.method === 'POST' && path === '/subscriptions') {
      const sub = { id: id('sub'), ...data }; s.subs.set(sub.id, sub);
      const p = { id: id('pay'), customer: data.customer, subscription: sub.id, value: data.value, dueDate: data.nextDueDate, description: data.description, status: 'PENDING', invoiceUrl: 'https://www.asaas.com/i/' + n }; s.payments.set(p.id, p);
      return send(200, sub);
    }
    if (req.method === 'PUT' && (m = /^\/subscriptions\/(.+)$/.exec(path))) {
      const sub = s.subs.get(m[1]); if (!sub) return send(404, {}); Object.assign(sub, { value: data.value, description: data.description });
      if (data.updatePendingPayments) for (const p of s.payments.values()) if (p.subscription === m[1] && p.status === 'PENDING' && !p.deleted) Object.assign(p, { value: data.value, description: data.description });
      return send(200, sub);
    }
    if (req.method === 'DELETE' && (m = /^\/subscriptions\/(.+)$/.exec(path))) { for (const p of s.payments.values()) if (p.subscription === m[1] && p.status === 'PENDING') p.deleted = true; return send(200, { deleted: true }); }
    if (req.method === 'GET' && path === '/webhooks') return send(200, { data: s.webhooks });
    if (req.method === 'POST' && path === '/webhooks') { const w = { id: id('wh'), ...data }; s.webhooks.push(w); return send(200, w); }
    if (req.method === 'PUT' && (m = /^\/webhooks\/(.+)$/.exec(path))) { Object.assign(s.webhooks.find(w => w.id === m[1]), data); return send(200, {}); }
    send(404, { errors: [{ description: 'rota ' + path }] });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  s.url = 'http://127.0.0.1:' + server.address().port + '/v3'; s.close = () => new Promise(r => server.close(r));
  return s;
}

test('cobrança Asaas: cadastro, implantação parcelada, mensalidade, bloqueio na carência e liberação ao pagar', { skip }, async () => {
  const asaas = await fakeAsaas();
  const f = await createStoreFixture({ env: { ASAAS_API_KEY: '$aact_hmlg_teste', ASAAS_API_URL: asaas.url, ASAAS_WEBHOOK_TOKEN: WEBHOOK_TOKEN, BILLING_SYNC: 'off', PUBLIC_BASE_URL: 'https://app.test' } });
  try {
    const { api, request, tenant, foreignTenant, masterToken, ownerToken, foreignToken, base, db } = f;
    const hook = (body, token = WEBHOOK_TOKEN) => fetch(base + '/api/internal/asaas/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'asaas-access-token': token }, body: JSON.stringify(body) });
    const wait = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; assert.ok(Date.now() < end, 'tempo esgotado'); await new Promise(r => setTimeout(r, 100)); } };
    const statusOf = async id => (await db.query('SELECT status FROM tenants WHERE id=$1', [id])).rows[0].status;

    // Só a central mexe; CPF obrigatório para cobrar.
    assert.equal((await request('/master/billing', { token: ownerToken })).status, 403);
    const overview = await api('/master/billing', { token: masterToken });
    assert.equal(overview.configured, true); assert.equal(overview.environment, 'sandbox');
    assert.equal(overview.webhook_url, 'https://app.test/api/internal/asaas/webhook');
    assert.equal((await request('/master/billing/accounts', { method: 'PUT', token: masterToken, body: { tenant_id: tenant, name: 'Loja de teste', mode: 'charge' } })).status, 400);

    const saved = await api('/master/billing/accounts', { method: 'PUT', token: masterToken, body: { tenant_id: tenant, name: 'Loja de teste LTDA', cpf_cnpj: '529.982.247-25', email: 'dono@example.test', phone: '(85) 99999-0000', mode: 'charge', grace_days: 3 } });
    assert.equal(saved.warning, null); assert.match(saved.account.asaas_customer_id, /^cus_/);
    assert.equal(asaas.customers.get(saved.account.asaas_customer_id).cpfCnpj, '52998224725');
    const acc = saved.account.id;

    // Loja isenta (como a ELITECH): não gera cobrança nem é bloqueada.
    const exempt = await api('/master/billing/accounts', { method: 'PUT', token: masterToken, body: { tenant_id: foreignTenant, name: 'Outra loja', mode: 'exempt' } });
    assert.equal(exempt.account.asaas_customer_id, null);
    assert.equal((await request(`/master/billing/accounts/${exempt.account.id}/charges`, { method: 'POST', token: masterToken, body: { description: 'Avulsa', installments: [{ value_cents: 1000, due_date: iso(1) }] } })).status, 409);

    // Implantação em 3x com valores e datas próprios.
    const created = await api(`/master/billing/accounts/${acc}/charges`, { method: 'POST', token: masterToken, body: { kind: 'setup', description: 'Implantação', installments: [{ value_cents: 83334, due_date: iso(0) }, { value_cents: 83333, due_date: iso(26) }, { value_cents: 83333, due_date: iso(57) }] } }, 201);
    assert.deepEqual(created.map(c => c.description), ['Implantação — parcela 1/3', 'Implantação — parcela 2/3', 'Implantação — parcela 3/3']);
    assert.deepEqual(created.map(c => c.value_cents), [83334, 83333, 83333]);
    assert.equal(created[0].kind, 'setup'); assert.equal([...asaas.payments.values()][0].value, 833.34);
    assert.equal((await request(`/master/billing/accounts/${acc}/charges`, { method: 'POST', token: masterToken, body: { description: 'Velha', installments: [{ value_cents: 1000, due_date: iso(-1) }] } })).status, 400);

    // Mensalidade: assinatura mensal; uma só ativa.
    const sub = await api(`/master/billing/accounts/${acc}/subscriptions`, { method: 'POST', token: masterToken, body: { description: 'Mensalidade', value_cents: 175000, first_due_date: iso(26) } }, 201);
    assert.match(sub.asaas_subscription_id, /^sub_/);
    assert.equal((await request(`/master/billing/accounts/${acc}/subscriptions`, { method: 'POST', token: masterToken, body: { description: 'Outra', value_cents: 1000, first_due_date: iso(30) } })).status, 409);
    let detail = await api(`/master/billing/accounts/${acc}`, { token: masterToken });
    assert.equal(detail.charges.filter(c => c.kind === 'monthly').length, 1, 'a 1ª mensalidade veio pela conferência');

    // Aviso ao dono: parcela de hoje aparece com "pague até".
    const mine = await api('/store/billing');
    assert.equal(mine.charges[0].pay_until, iso(3)); assert.equal(mine.charges[0].invoice_url.startsWith('https://'), true);
    assert.equal((await request('/store/billing', { token: foreignToken })).data.charges.length, 0);

    // Vencida há 5 dias, carência de 3 → bloqueia na conferência.
    const p1 = asaas.payments.get(created[0].asaas_payment_id); Object.assign(p1, { dueDate: iso(-5), status: 'OVERDUE' });
    // Se o Asaas não responde na hora de conferir, não bloqueia.
    await db.query('UPDATE billing_charges SET due_date=$2,status=$3 WHERE id=$1', [created[0].id, iso(-5), 'OVERDUE']);
    asaas.failGet = true;
    await api(`/master/billing/accounts`, { method: 'PUT', token: masterToken, body: { tenant_id: tenant, name: 'Loja de teste LTDA', cpf_cnpj: '52998224725', mode: 'charge', grace_days: 3 } });
    assert.equal(await statusOf(tenant), 'active');
    assert.match((await db.query('SELECT last_error FROM billing_accounts WHERE id=$1', [acc])).rows[0].last_error, /Não bloqueado/);
    asaas.failGet = false;

    const sync = await api('/master/billing/sync', { method: 'POST', token: masterToken });
    assert.deepEqual(sync.changes, [{ id: acc, action: 'blocked' }]);
    assert.equal(await statusOf(tenant), 'suspended');
    assert.equal(await statusOf(foreignTenant), 'active');
    const blocked = await request('/store/settings');
    assert.equal(blocked.status, 403); assert.equal(blocked.data.code, 'billing_blocked'); assert.equal(blocked.data.pay_url, p1.invoiceUrl);
    assert.equal((await api('/master/stats', { token: masterToken })).delinquent_tenants, 1);

    // Webhook: token errado é recusado; pagamento libera sozinho; aviso repetido não reprocessa.
    assert.equal((await hook({ id: 'evt_1', event: 'PAYMENT_RECEIVED', payment: { id: p1.id } }, 'errado-errado-errado-errado-errado-1')).status, 401);
    Object.assign(p1, { status: 'RECEIVED', paymentDate: iso(0) });
    assert.equal((await hook({ id: 'evt_1', event: 'PAYMENT_RECEIVED', payment: { id: p1.id, status: 'RECEIVED' } })).status, 200);
    await wait(async () => await statusOf(tenant) === 'active');
    assert.equal((await request('/store/settings')).status, 200);
    // Aviso antigo fora de ordem (OVERDUE) chega depois: a situação vem da API, continua paga.
    assert.equal((await hook({ id: 'evt_0', event: 'PAYMENT_OVERDUE', payment: { id: p1.id, status: 'OVERDUE' } })).status, 200);
    assert.equal((await hook({ id: 'evt_1', event: 'PAYMENT_RECEIVED', payment: { id: p1.id } })).status, 200);
    await wait(async () => (await db.query('SELECT count(*)::int n FROM billing_events WHERE processed_at IS NOT NULL')).rows[0].n === 2);
    assert.equal((await db.query('SELECT status FROM billing_charges WHERE id=$1', [created[0].id])).rows[0].status, 'RECEIVED');

    // Suspensão manual da central não é desfeita pela cobrança.
    await api(`/master/tenants/${tenant}`, { method: 'PATCH', token: masterToken, body: { status: 'suspended' } });
    await api('/master/billing/sync', { method: 'POST', token: masterToken });
    assert.equal(await statusOf(tenant), 'suspended');
    await api(`/master/tenants/${tenant}`, { method: 'PATCH', token: masterToken, body: { status: 'active' } });

    // "Liberar até": vencida, mas a central segurou o bloqueio.
    const p2 = asaas.payments.get(created[1].asaas_payment_id); Object.assign(p2, { dueDate: iso(-10), status: 'OVERDUE' });
    await api('/master/billing/accounts', { method: 'PUT', token: masterToken, body: { tenant_id: tenant, name: 'Loja de teste LTDA', cpf_cnpj: '52998224725', mode: 'charge', grace_days: 3, block_override_until: iso(2) } });
    await api('/master/billing/sync', { method: 'POST', token: masterToken });
    assert.equal(await statusOf(tenant), 'active');
    // Recebido por fora: baixa no Asaas.
    const paid = await api(`/master/billing/charges/${created[1].id}/receive`, { method: 'POST', token: masterToken, body: { paid_at: iso(0), value_cents: 83333 } });
    assert.equal(paid.status, 'RECEIVED_IN_CASH');

    // Cancelar parcela e mensalidade.
    await api(`/master/billing/charges/${created[2].id}`, { method: 'DELETE', token: masterToken });
    assert.equal(asaas.payments.get(created[2].asaas_payment_id).deleted, true);
    await api(`/master/billing/subscriptions/${sub.id}`, { method: 'DELETE', token: masterToken });
    detail = await api(`/master/billing/accounts/${acc}`, { token: masterToken });
    assert.equal(detail.subscriptions[0].status, 'canceled');
    assert.equal(detail.charges.filter(c => !c.deleted && ['PENDING', 'OVERDUE'].includes(c.status)).length, 0);

    // Rede (como a Audace): uma conta só; atraso bloqueia a rede e as unidades juntas.
    const netw = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Rede Teste', slug: 'rede-teste-' + Date.now().toString(36) } }, 201);
    const unit = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Unidade 1', slug: 'unidade-' + Date.now().toString(36) } }, 201);
    await api(`/master/tenants/${unit.id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: netw.id } });
    assert.equal((await request('/master/billing/accounts', { method: 'PUT', token: masterToken, body: { tenant_id: unit.id, name: 'Unidade', cpf_cnpj: '52998224725' } })).status, 400);
    const na = await api('/master/billing/accounts', { method: 'PUT', token: masterToken, body: { network_id: netw.id, name: 'Rede Teste SA', cpf_cnpj: '11.222.333/0001-81', grace_days: 0 } });
    const [np] = await api(`/master/billing/accounts/${na.account.id}/charges`, { method: 'POST', token: masterToken, body: { kind: 'setup', description: 'Implantação', installments: [{ value_cents: 50000, due_date: iso(0) }] } }, 201);
    Object.assign(asaas.payments.get(np.asaas_payment_id), { dueDate: iso(-1), status: 'OVERDUE' });
    await api('/master/billing/sync', { method: 'POST', token: masterToken });
    assert.equal(await statusOf(unit.id), 'suspended');
    assert.equal((await db.query('SELECT status,billing_blocked FROM store_networks WHERE id=$1', [netw.id])).rows[0].billing_blocked, true);
    // Virou isenta → libera.
    await api('/master/billing/accounts', { method: 'PUT', token: masterToken, body: { network_id: netw.id, name: 'Rede Teste SA', mode: 'exempt' } });
    assert.equal(await statusOf(unit.id), 'trial');
    assert.equal((await db.query('SELECT status FROM store_networks WHERE id=$1', [netw.id])).rows[0].status, 'active');

    // Webhook configurado pela central com o token do servidor.
    await api('/master/billing/webhook', { method: 'POST', token: masterToken });
    assert.equal(asaas.webhooks[0].authToken, WEBHOOK_TOKEN); assert.equal(asaas.webhooks[0].url, 'https://app.test/api/internal/asaas/webhook');
    assert.equal((await api('/master/billing/webhook', { token: masterToken })).enabled, true);
    const list = await api('/master/billing', { token: masterToken });
    assert.ok(list.accounts.some(a => a.network_id === netw.id && a.mode === 'exempt'));
    assert.ok(!list.accounts.some(a => a.tenant_id === unit.id), 'unidade de rede não aparece sozinha');
  } finally { await f.cleanup(); await asaas.close(); }
});

test('cobrança por unidade: liberar unidade cobra o mês cheio na próxima cobrança; parar tira; sem unidade cancela', { skip }, async () => {
  const asaas = await fakeAsaas();
  const f = await createStoreFixture({ env: { ASAAS_API_KEY: '$aact_hmlg_teste', ASAAS_API_URL: asaas.url, ASAAS_WEBHOOK_TOKEN: WEBHOOK_TOKEN, BILLING_SYNC: 'off', PUBLIC_BASE_URL: 'https://app.test' } });
  try {
    const { api, request, tenant, foreignTenant, masterToken, db } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Rede Teste', slug: 'rede-cobra', hostname: 'rede-cobra.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Messejana' } });
    await api(`/master/tenants/${foreignTenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Benfica' } });
    assert.equal((await request('/master/billing/accounts', { method: 'PUT', token: masterToken, body: { tenant_id: tenant, name: 'X', mode: 'exempt', unit_price_cents: 25000 } })).status, 400);
    // Sem valor por unidade não libera.
    let acc = (await api('/master/billing/accounts', { method: 'PUT', token: masterToken, body: { network_id: net.id, name: 'GRK Joias', cpf_cnpj: '46.383.376/0001-23', mode: 'charge' } })).account;
    assert.equal((await request(`/master/billing/accounts/${acc.id}/units/${tenant}`, { method: 'POST', token: masterToken, body: { active: true } })).status, 409);
    const saved = await api('/master/billing/accounts', { method: 'PUT', token: masterToken, body: { network_id: net.id, name: 'GRK Joias', cpf_cnpj: '46.383.376/0001-23', mode: 'charge', unit_price_cents: 25000, due_day: 20 } });
    acc = saved.account; assert.equal(acc.unit_price_cents, 25000); assert.equal(acc.due_day, 20); assert.equal(saved.warning, null);
    assert.equal(asaas.subs.size, 0, 'nenhuma unidade liberada: sem assinatura');
    // Mensalidade fixa fica proibida nesta rede.
    assert.equal((await request(`/master/billing/accounts/${acc.id}/subscriptions`, { method: 'POST', token: masterToken, body: { description: 'Fixa', value_cents: 175000, first_due_date: iso(10) } })).status, 409);
    // Unidade de outra rede não.
    assert.equal((await request(`/master/billing/accounts/${acc.id}/units/${acc.id}`, { method: 'POST', token: masterToken, body: { active: true } })).status, 404);

    // Libera Messejana: cria assinatura de R$ 250 no dia 20.
    let r = await api(`/master/billing/accounts/${acc.id}/units/${tenant}`, { method: 'POST', token: masterToken, body: { active: true } });
    assert.equal(r.action, 'created'); assert.equal(r.value_cents, 25000);
    const sub = [...asaas.subs.values()][0];
    assert.equal(sub.value, 250); assert.equal(sub.cycle, 'MONTHLY'); assert.match(sub.nextDueDate, /-20$/); assert.match(sub.description, /1 unidade: Messejana/);
    // Libera Benfica: mês cheio na cobrança em aberto (R$ 500).
    r = await api(`/master/billing/accounts/${acc.id}/units/${foreignTenant}`, { method: 'POST', token: masterToken, body: { active: true } });
    assert.equal(r.action, 'updated'); assert.equal(r.value_cents, 50000);
    const pending = [...asaas.payments.values()].filter(p => p.subscription === sub.id && !p.deleted);
    assert.equal(pending.length, 1); assert.equal(pending[0].value, 500);
    let detail = await api(`/master/billing/accounts/${acc.id}`, { token: masterToken });
    assert.equal(detail.subscriptions.filter(s => s.status === 'active').length, 1);
    assert.equal(detail.subscriptions[0].per_unit, true); assert.equal(detail.subscriptions[0].units, 2);
    assert.equal(detail.charges.find(c => !c.deleted).value_cents, 50000);
    assert.equal(detail.units.filter(u => u.billing_since).length, 2);
    // Repetir não chama o Asaas de novo.
    const calls = asaas.calls.length;
    assert.equal((await api(`/master/billing/accounts/${acc.id}/units/${foreignTenant}`, { method: 'POST', token: masterToken, body: { active: true } })).action, undefined);
    assert.equal(asaas.calls.filter(c => c.startsWith('PUT /subscriptions')).length, asaas.calls.slice(0, calls).filter(c => c.startsWith('PUT /subscriptions')).length);
    // Para Benfica: volta a R$ 250; para Messejana: cancela a assinatura.
    r = await api(`/master/billing/accounts/${acc.id}/units/${foreignTenant}`, { method: 'POST', token: masterToken, body: { active: false } });
    assert.equal(r.value_cents, 25000); assert.equal(pending[0].value, 250);
    r = await api(`/master/billing/accounts/${acc.id}/units/${tenant}`, { method: 'POST', token: masterToken, body: { active: false } });
    assert.equal(r.action, 'canceled'); assert.equal(pending[0].deleted, true);
    detail = await api(`/master/billing/accounts/${acc.id}`, { token: masterToken });
    assert.equal(detail.subscriptions.filter(s => s.status === 'active').length, 0);
    assert.equal((await db.query('SELECT count(*)::int n FROM tenants WHERE network_id=$1 AND billing_since IS NOT NULL', [net.id])).rows[0].n, 0);
  } finally { await f.cleanup(); await asaas.close(); }
});
