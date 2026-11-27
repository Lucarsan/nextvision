import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';
const hostRequest = (base, path, host, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers: { Host: host, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(b || '{}') }));
  });
  r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
});

test('quiosque: senha da unidade abre o caixa, vendedora confirma com PIN e dono entra direto no painel', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, base } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace', hostname: 'audace.example.test' } }, 201);
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    const solares = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Solares', slug: 'audace-solares' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Maracanaú' } });
    await api(`/master/tenants/${solares.id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Solares' } });
    const people = `/master/networks/${net.id}/people`;

    // Senha do quiosque: só para loja de rede; mostrada uma vez.
    assert.equal((await request(`/master/tenants/${f.foreignTenant}/kiosk-password`, { method: 'POST', token: masterToken, body: {} })).status, 400);
    const kp = await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: {} });
    assert.equal(kp.unit, 'Maracanaú'); assert.ok(kp.password.length >= 8);
    await api(`/master/tenants/${solares.id}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-solares' } });

    // Vendedoras sem e-mail, com PIN (gerado e mostrado uma vez, ou definido).
    const ana = await api(people, { method: 'POST', token: masterToken, body: { name: 'Ana Paula', function: 'vendedora', unit_id: tenant, pin: '1234' } }, 201);
    assert.equal(ana.email, null); assert.equal(ana.function, 'vendedora'); assert.equal(ana.temporary_pin, undefined); assert.equal(ana.has_pin, true);
    const julia = await api(people, { method: 'POST', token: masterToken, body: { name: 'Júlia Lima', function: 'vendedora', unit_id: tenant } }, 201);
    assert.match(julia.temporary_pin, /^\d{4}$/);
    assert.equal((await request(people, { method: 'POST', token: masterToken, body: { name: 'Sem Email', function: 'supervisor', unit_ids: [] } })).status, 400);
    const dono = await api(people, { method: 'POST', token: masterToken, body: { name: 'Gabriel Mota', email: 'gabriel@audace.test', function: 'dono', password: 'senha-do-gabriel-1', pin: '9999' } }, 201);
    await api(people, { method: 'POST', token: masterToken, body: { name: 'Sup Solares', email: 'sup@audace.test', function: 'supervisor', unit_ids: [solares.id], password: 'senha-do-supervisor', pin: '5555' } }, 201);
    // Vendedora nunca entra pelo e-mail, e a lista de pessoas não mostra o acesso do quiosque.
    assert.ok(!(await api(people, { token: masterToken })).some(p => /quiosque/i.test(p.name)));

    // Tela "Entrar na unidade": unidades e vendedoras pelo endereço da rede; fora dele, nada.
    const units = await hostRequest(base, '/api/public/units', 'audace.example.test');
    assert.deepEqual(units.data.units.map(u => u.label), ['Maracanaú', 'Solares']);
    assert.deepEqual(units.data.units[0].sellers, ['Ana', 'Júlia']);
    assert.deepEqual((await hostRequest(base, '/api/public/units', 'app.ficoupronto.com')).data, { network: false, units: [] });

    // Senha errada, senha de outra unidade, unidade fora da rede do endereço: recusado.
    const unit = body => hostRequest(base, '/api/auth/unit', 'audace.example.test', { method: 'POST', body });
    assert.equal((await unit({ unit_id: tenant, password: 'errada' })).status, 401);
    assert.equal((await unit({ unit_id: tenant, password: 'senha-solares' })).status, 401);
    assert.equal((await unit({ unit_id: f.foreignTenant, password: kp.password })).status, 401);
    // Senha do quiosque → caixa.
    const k = await unit({ unit_id: tenant, password: kp.password });
    assert.equal(k.status, 200); assert.equal(k.data.panel, '/caixa'); assert.equal(k.data.user.kiosk, true);
    const kt = k.data.token;
    // Senha do dono em qualquer unidade → painel da rede.
    const g = await unit({ unit_id: solares.id, password: 'senha-do-gabriel-1' });
    assert.equal(g.data.panel, '/rede.html'); assert.equal(g.data.user.id, dono.id);
    assert.equal((await api('/network/me', { token: g.data.token })).network.name, 'Audace Joias');
    // Supervisor só pelas unidades que acompanha.
    assert.equal((await unit({ unit_id: solares.id, password: 'senha-do-supervisor' })).data.panel, '/rede.html');
    assert.equal((await unit({ unit_id: tenant, password: 'senha-do-supervisor' })).status, 401);
    // Login por e-mail continua para dono; vendedora e quiosque não entram por e-mail.
    assert.equal((await request('/auth/login', { method: 'POST', token: null, body: { email: 'gabriel@audace.test', password: 'senha-do-gabriel-1' } })).status, 200);
    assert.equal((await request('/auth/login', { method: 'POST', token: null, body: { email: `quiosque+${tenant}@kiosk.invalid`, password: kp.password } })).status, 401);

    // Caixa do quiosque: vendedoras da unidade e conferência do PIN.
    const sellers = await api('/store/kiosk/sellers', { token: kt });
    assert.deepEqual(sellers.sellers.map(s => s.name), ['Ana Paula', 'Júlia Lima']); assert.equal(sellers.kiosk, true); assert.equal(sellers.unit.label, 'Maracanaú');
    assert.equal((await request('/store/kiosk/check-pin', { method: 'POST', token: kt, body: { seller_id: ana.id, pin: '0000' } })).status, 401);
    assert.equal((await api('/store/kiosk/check-pin', { method: 'POST', token: kt, body: { seller_id: ana.id, pin: '1234' } })).name, 'Ana Paula');

    // Venda no quiosque: sem vendedora/PIN ou com PIN errado não grava.
    assert.equal((await request('/store/cash/open', { method: 'POST', token: kt, body: { opening_cents: 0 } })).status, 401);
    assert.equal((await request('/store/cash/open', { method: 'POST', token: kt, body: { opening_cents: 0, seller_id: ana.id, seller_pin: '0000' } })).status, 401);
    const op = await api('/store/cash/open', { method: 'POST', token: kt, body: { opening_cents: 0, seller_id: ana.id, seller_pin: '1234' } }, 201);
    assert.equal(op.opened_by, ana.id);
    const prod = (await f.db.query("INSERT INTO products(tenant_id, name, barcode, price_cents, stock_qty) VALUES($1, 'Corrente Aço Elo P', '003622', 4900, 5) RETURNING id", [tenant])).rows[0].id;
    const item = { items: [{ product_id: prod, quantity: 1 }] };
    assert.equal((await request('/store/sales', { method: 'POST', token: kt, body: { ...item, anonymous: true, payment_method: 'credit' } })).status, 400);
    assert.equal((await request('/store/sales', { method: 'POST', token: kt, body: { ...item, anonymous: true, payment_method: 'credit', seller_id: ana.id, seller_pin: '1111' } })).status, 401);
    const sale = await api('/store/sales', { method: 'POST', token: kt, body: { ...item, anonymous: true, payment_method: 'credit', seller_id: ana.id, seller_pin: '1234' } }, 201);
    assert.equal(sale.sale.seller_id, ana.id);
    // Desconto: até 50% da venda em qualquer forma de pagamento.
    assert.equal((await request('/store/sales', { method: 'POST', token: kt, body: { ...item, anonymous: true, payment_method: 'credit', discount_cents: 2451, seller_id: ana.id, seller_pin: '1234' } })).status, 403);
    const cash = await api('/store/sales', { method: 'POST', token: kt, body: { ...item, anonymous: true, payment_method: 'cash', discount_cents: 490, seller_id: ana.id, seller_pin: '1234' } }, 201);
    assert.equal(cash.sale.total_cents, 4410);
    // Cancelar no quiosque: só o PIN de quem vendeu; sem ela, o PIN de supervisor/dono da unidade.
    const cancel = (id, body) => request(`/store/sales/${id}/cancel`, { method: 'POST', token: kt, body: { reason: 'Cobrança repetida', ...body } });
    assert.equal((await cancel(sale.sale.id, {})).status, 401);
    assert.equal((await cancel(sale.sale.id, { seller_pin: '1111' })).status, 401);
    assert.equal((await cancel(sale.sale.id, { supervisor_pin: '5555' })).status, 401, 'supervisor de outra unidade não autoriza');
    assert.equal((await cancel(sale.sale.id, { seller_pin: '1234' })).status, 200);
    assert.equal((await f.db.query('SELECT canceled_by FROM sales WHERE id=$1', [sale.sale.id])).rows[0].canceled_by, ana.id);
    const half = await api('/store/sales', { method: 'POST', token: kt, body: { ...item, anonymous: true, payment_method: 'credit', discount_cents: 2450, seller_id: ana.id, seller_pin: '1234' } }, 201);
    assert.equal(half.sale.total_cents, 2450);
    assert.equal((await cancel(half.sale.id, { supervisor_pin: '9999' })).status, 200);
    const day = await api('/store/cash', { token: kt });
    assert.match(JSON.stringify(day), /autorizado por Gabriel Mota/);

    // Meu dia: só com o PIN; sem custo nem comissão das colegas.
    assert.equal((await request('/store/kiosk/my-day', { method: 'POST', token: kt, body: { seller_id: ana.id, pin: '0000' } })).status, 401);
    const md = await api('/store/kiosk/my-day', { method: 'POST', token: kt, body: { seller_id: ana.id, pin: '1234' } });
    assert.equal(md.today.count, 1); assert.equal(md.today.total_cents, 4410); assert.equal(md.store_today.count, 1);
    assert.equal(JSON.stringify(md).includes('cost'), false);

    // Pinpad fora do ar: venda na maquininha avulsa fica pendente de conciliação no painel da rede.
    const off = await api('/store/sales', { method: 'POST', token: kt, body: { ...item, anonymous: true, payment_method: 'debit', offline_payment: true, offline_auth: 'AUT123', seller_id: ana.id, seller_pin: '1234' } }, 201);
    assert.equal(off.sale.offline_payment, true);
    const offCash = await api('/store/sales', { method: 'POST', token: kt, body: { ...item, anonymous: true, payment_method: 'cash', offline_payment: true, seller_id: ana.id, seller_pin: '1234' } }, 201);
    assert.notEqual(offCash.sale.offline_payment, true, 'dinheiro não fica pendente');
    const ov = await api('/network/overview', { token: g.data.token });
    assert.ok(ov.alerts.discounted.some(d => d.pct === 10 && d.seller === 'Ana Paula' && d.discount_cents === 490), 'desconto aparece para a supervisão');
    assert.ok(ov.alerts.canceled.some(c => c.canceled_by === 'Ana Paula' && c.seller === 'Ana Paula'), 'quem cancelou é a vendedora do PIN');
    assert.deepEqual(ov.alerts.econf_pending.map(e => [e.sale_number, e.offline_auth]), [[off.sale.sale_number, 'AUT123']]);
    await api(`/network/sales/${off.sale.id}/econf-done`, { method: 'POST', token: g.data.token });
    assert.equal((await api('/network/overview', { token: g.data.token })).alerts.econf_pending.length, 0);
    // Vendas do caixa no quiosque: sem custo; sangria e fechamento com PIN.
    const today = await api('/store/kiosk/cash-today', { token: kt });
    assert.equal(today.sales.length, 5); assert.equal(JSON.stringify(today).includes('cost'), false);
    assert.equal(today.sales.find(x => x.id === off.sale.id).offline_payment, true);
    assert.equal((await request('/store/cash/movements', { method: 'POST', token: kt, body: { kind: 'withdrawal', amount_cents: 1000, seller_id: ana.id, seller_pin: '0000' } })).status, 401);
    const sg = await api('/store/cash/movements', { method: 'POST', token: kt, body: { kind: 'withdrawal', amount_cents: 1000, note: 'Banco', seller_id: ana.id, seller_pin: '1234' } }, 201);
    assert.equal(sg.note, 'Banco · por Ana Paula');
    assert.equal((await request('/store/cash/close', { method: 'POST', token: kt, body: { counted_cash_cents: 0 } })).status, 401);
    const cl = await api('/store/cash/close', { method: 'POST', token: kt, body: { counted_cash_cents: 8000, seller_id: ana.id, seller_pin: '1234' } });
    assert.equal(cl.difference_cents, 8000 - (4410 + 4900 - 1000)); assert.match(cl.session.close_note, /fechado por Ana Paula/);

    // Garantia digital: comprovante público pelo código, consulta em outra unidade da rede e atendimento com prazo.
    assert.match(off.sale.receipt_code, /^[A-Za-z0-9]{8}$/);
    const pub = await request(`/public/receipt/${off.sale.receipt_code}`, { token: null });
    assert.equal(pub.status, 200); assert.deepEqual(pub.data.warranties.map(w => [w.label, w.days]), [['Defeito de fabricação', 30], ['Cor do banho', 365]]);
    assert.deepEqual(pub.data.units, ['Maracanaú', 'Solares']); assert.equal(JSON.stringify(pub.data).includes('phone'), false);
    assert.equal((await request('/public/receipt/zzzzzzzz', { token: null })).status, 404);
    const ks = (await unit({ unit_id: solares.id, password: 'senha-solares' })).data.token;
    const wv = await api(`/store/warranty/${off.sale.receipt_code}`, { token: ks });
    assert.equal(wv.unit, 'Maracanaú'); assert.equal(wv.claims.length, 0);
    assert.equal((await request(`/store/warranty/${off.sale.receipt_code}`, { token: f.foreignToken })).status, 404);
    assert.equal((await request(`/store/warranty/${off.sale.receipt_code}/claims`, { method: 'POST', token: kt, body: { kind: 'troca', seller_id: ana.id, seller_pin: '0000' } })).status, 401);
    await api(`/store/warranty/${off.sale.receipt_code}/claims`, { method: 'POST', token: kt, body: { kind: 'troca', note: 'Banho escureceu', seller_id: ana.id, seller_pin: '1234' } }, 201);
    const wo = (await api('/network/overview', { token: g.data.token })).alerts.warranty_open;
    assert.equal(wo.length, 1); assert.equal(wo[0].note, 'Banho escureceu');
    await api(`/network/warranty-claims/${wo[0].id}/close`, { method: 'POST', token: g.data.token, body: {} });
    assert.equal((await api('/network/overview', { token: g.data.token })).alerts.warranty_open.length, 0);

    // Comissão por faixa da rede: Meu dia e painel da rede mostram a faixa alcançada e quanto falta para a próxima.
    assert.equal((await request(`/master/networks/${net.id}/commission-tiers`, { method: 'PUT', token: masterToken, body: { tiers: [{ min_cents: 0, percent: 2 }, { min_cents: 0, percent: 3 }] } })).status, 400);
    await api(`/master/networks/${net.id}/commission-tiers`, { method: 'PUT', token: masterToken, body: { tiers: [{ min_cents: 50000, percent: 4 }, { min_cents: 0, percent: 2 }, { min_cents: 10000, percent: 3 }] } });
    const md2 = await api('/store/kiosk/my-day', { method: 'POST', token: kt, body: { seller_id: ana.id, pin: '1234' } });
    assert.equal(md2.month.total_cents, 14210); assert.equal(md2.commission.percent, 3); assert.equal(md2.commission.estimated_cents, 426);
    assert.deepEqual(md2.commission.next, { percent: 4, min_cents: 50000, missing_cents: 50000 - 14210 });
    const comm = await api('/network/commissions', { token: g.data.token });
    const anaC = comm.sellers.find(x => x.name === 'Ana Paula');
    assert.equal(anaC.commission_cents, 426); assert.equal(anaC.percent, 3); assert.equal(comm.tiers.length, 3);

    // Trocar a vendedora para supervisora pede e-mail; trocar a senha do quiosque derruba a sessão antiga.
    assert.equal((await request(`/master/network-people/${julia.id}`, { method: 'PATCH', token: masterToken, body: { function: 'supervisor', unit_ids: [tenant] } })).status, 400);
    await new Promise(r => setTimeout(r, 1100));
    await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'nova-senha-quiosque' } });
    assert.equal((await request('/store/kiosk/sellers', { token: kt })).status, 401);
  } finally { await f.cleanup(); }
});
