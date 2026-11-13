import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const todayDow = () => WD[new Intl.DateTimeFormat('en-US', { timeZone: 'America/Fortaleza', weekday: 'short' }).format(new Date())];
const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date()).slice(0, 7);
const nextMonth = m => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };

test('pet shop: dia sem cashback, serviços com variáveis, comissão, metas e gravação desligada', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, db } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);

    // ---- Cashback: hoje bloqueado não gera; usar o saldo continua valendo. ----
    const today = todayDow(), other = (today + 1) % 7;
    let cfg = await api('/store/sales/cashback', { method: 'PATCH', body: { cashback_enabled: true, cashback_off_weekdays: [today, today] } });
    assert.deepEqual(cfg.cashback_off_weekdays, [today], 'sem repetição');
    assert.equal((await request('/store/sales/cashback', { method: 'PATCH', body: { cashback_off_weekdays: [7] } })).status, 400);
    assert.equal((await api('/store/sales/config')).today_weekday, today);
    const blocked = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Afonso Filho', phone: '85 99710-6788' }, total_cents: 10000, payment_method: 'pix' } }, 201);
    const afonso = blocked.customer.id;
    assert.equal(blocked.sale.cashback_earned_cents, 0); assert.equal(blocked.sale.cashback_off_today, true);
    await api('/store/sales/cashback', { method: 'PATCH', body: { cashback_off_weekdays: [other] } });
    const earns = await api('/store/sales', { method: 'POST', body: { customer_id: afonso, total_cents: 10000, payment_method: 'pix' } }, 201);
    assert.equal(earns.sale.cashback_earned_cents, 500); assert.equal(earns.sale.cashback_off_today, undefined);
    await api('/store/sales/cashback', { method: 'PATCH', body: { cashback_off_weekdays: [today] } });
    const uses = await api('/store/sales', { method: 'POST', body: { customer_id: afonso, total_cents: 1000, payment_method: 'pix', cashback_use_cents: 300 } }, 201);
    assert.equal(uses.sale.cashback_used_cents, 300, 'saldo continua usável no dia bloqueado'); assert.equal(uses.sale.cashback_earned_cents, 0);
    await api('/store/sales/cashback', { method: 'PATCH', body: { cashback_off_weekdays: [] } });

    // ---- Serviços com variáveis e adicional ----
    const banho = await api('/store/sales/service-items', { method: 'POST', body: { name: 'Banho de cheiro', price_cents: 4300,
      price_rules: { size: [{ name: 'Médio', cents: 700 }, { name: 'Grande', cents: 1500 }, { name: 'grande', cents: 1600 }], breed: [{ name: 'Golden  Retriever', cents: 8000 }] } } }, 201);
    assert.equal(banho.addon, false);
    assert.deepEqual(banho.price_rules, { size: [{ name: 'Médio', cents: 700 }, { name: 'grande', cents: 1600 }], breed: [{ name: 'Golden Retriever', cents: 8000 }] }, 'repetido fica com o último; espaços normalizados');
    const hidra = await api('/store/sales/service-items', { method: 'POST', body: { name: 'Hidratação simples', price_cents: 1800, addon: true, price_rules: { size: [{ name: 'Médio', cents: 300 }] } } }, 201);
    assert.equal(hidra.addon, true);
    const patched = await api('/store/sales/service-items/' + banho.id, { method: 'PATCH', body: { price_rules: { size: [{ name: 'Médio', cents: 700 }, { name: 'Grande', cents: 1500 }], breed: [{ name: 'Golden Retriever', cents: 8000 }], coat: [{ name: 'Longo', cents: 1000 }] } } });
    assert.equal(patched.price_rules.size[1].cents, 1500); assert.equal(patched.price_rules.coat[0].name, 'Longo');
    assert.equal((await api('/store/sales/service-items/' + banho.id, { method: 'PATCH', body: { price_cents: 4500 } })).price_rules.breed.length, 1, 'mudar o preço mantém as variáveis');
    assert.equal((await request('/store/sales/service-items', { method: 'POST', body: { name: 'X serviço', price_rules: { porte: [] } } })).status, 400);
    const list = await api('/store/sales/service-items');
    assert.equal(list.find(i => i.id === hidra.id).addon, true);

    // Venda com serviço principal + adicional, vendida pela atendente (operadora).
    const taina = await f.addOperator(tenant, 'full', 'Tainá');
    const sale = await api('/store/sales', { method: 'POST', token: taina.token, body: { customer_id: afonso, payment_method: 'pix',
      items: [{ service: 'Banho de cheiro', unit_price_cents: 12300, device_model: 'Dom', catalog_id: banho.id }, { service: 'Hidratação simples', unit_price_cents: 2100, device_model: 'Dom', catalog_id: hidra.id }] } }, 201);
    assert.equal(sale.sale.total_cents, 14400);
    const rows = (await db.query('SELECT name,addon,catalog_id FROM sale_items WHERE sale_id=$1 ORDER BY position', [sale.sale.id])).rows;
    assert.deepEqual(rows.map(r => [r.name, r.addon]), [['Banho de cheiro', false], ['Hidratação simples', true]]);
    assert.equal(rows[0].catalog_id, banho.id);
    // "Adicional" fica gravado como estava: mudar o cadastro depois não muda a venda.
    await api('/store/sales/service-items/' + hidra.id, { method: 'PATCH', body: { addon: false } });
    assert.equal((await db.query('SELECT addon FROM sale_items WHERE sale_id=$1 AND name=$2', [sale.sale.id, 'Hidratação simples'])).rows[0].addon, true);
    await api('/store/sales/service-items/' + hidra.id, { method: 'PATCH', body: { addon: true } });
    const foreignSvc = (await db.query("INSERT INTO service_catalog(tenant_id,name) VALUES($1,'De outra loja') RETURNING id", [f.foreignTenant])).rows[0].id;
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ service: 'Banho', unit_price_cents: 100, catalog_id: foreignSvc }] } })).status, 400);
    // Venda cancelada não conta.
    const canceled = await api('/store/sales', { method: 'POST', token: taina.token, body: { anonymous: true, payment_method: 'cash', items: [{ service: 'Banho de cheiro', unit_price_cents: 4300, catalog_id: banho.id }] } }, 201);
    await api(`/store/sales/${canceled.sale.id}/cancel`, { method: 'POST', body: { reason: 'Lançado errado' } });

    // ---- Comissão e metas ----
    // A página mostra o faturamento: sem a senha do admin, ninguém vê nem muda (nem o dono).
    assert.equal((await request('/store/sales/performance')).status, 401);
    assert.equal((await request('/store/sales/performance')).data.admin_required, true);
    assert.equal((await request('/store/sales/performance', { token: taina.token })).status, 401);
    assert.equal((await request('/store/sales/goals', { method: 'PUT', body: { month: thisMonth(), target_cents: 1 } })).status, 401);
    assert.equal((await request('/store/sales/commission/' + taina.id, { method: 'PATCH', body: { commission_percent: 1, commission_base: 'addons' } })).status, 401);
    assert.equal((await request('/store/sales/commission/' + taina.id, { admin: true, method: 'PATCH', token: taina.token, body: { commission_percent: 2, commission_base: 'addons' } })).status, 403);
    const comm = await api('/store/sales/commission/' + taina.id, { admin: true, method: 'PATCH', body: { commission_percent: 2, commission_base: 'addons' } });
    assert.equal(comm.commission_percent, 2);
    const month = thisMonth();
    await api('/store/sales/goals', { admin: true, method: 'PUT', body: { month, target_cents: 3000000 } });
    await api('/store/sales/goals', { admin: true, method: 'PUT', body: { month, user_id: taina.id, target_cents: 1000000 } });
    let perf = await api('/store/sales/performance', { admin: true });
    assert.equal(perf.month, month); assert.equal(perf.is_owner, true);
    assert.equal(perf.store.goal_cents, 3000000);
    assert.equal(perf.store.services_cents, 14400); assert.equal(perf.store.baths, 1); assert.equal(perf.store.addons, 1); assert.equal(perf.store.addons_cents, 2100);
    const t = perf.people.find(p => p.user_id === taina.id);
    assert.equal(t.commission_cents, 42, '2% de R$ 21,00 de adicionais'); assert.equal(t.goal_cents, 1000000); assert.equal(t.baths, 1); assert.equal(t.sales, 1);
    // Base "serviços": 2% de R$ 144,00.
    await api('/store/sales/commission/' + taina.id, { admin: true, method: 'PATCH', body: { commission_percent: 2, commission_base: 'services' } });
    assert.equal((await api('/store/sales/performance', { admin: true })).people.find(p => p.user_id === taina.id).commission_cents, 288);
    await api('/store/sales/commission/' + taina.id, { admin: true, method: 'PATCH', body: { commission_percent: 2, commission_base: 'addons' } });
    // A operadora vê a meta da loja e só a própria linha.
    perf = await api('/store/sales/performance', { admin: true, token: taina.token });
    assert.equal(perf.is_owner, false); assert.deepEqual(perf.people.map(p => p.user_id), [taina.id]); assert.equal(perf.store.goal_cents, 3000000);
    assert.equal((await request('/store/sales/goals', { admin: true, method: 'PUT', token: taina.token, body: { month, target_cents: 1 } })).status, 403);
    // A meta continua no mês seguinte; tirar a meta (null) vale dali em diante.
    const next = nextMonth(month);
    assert.equal((await api('/store/sales/performance?month=' + next, { admin: true })).store.goal_cents, 3000000);
    assert.equal((await api('/store/sales/performance?month=' + next, { admin: true })).store.services_cents, 0);
    await api('/store/sales/goals', { admin: true, method: 'PUT', body: { month: next, target_cents: null } });
    assert.equal((await api('/store/sales/performance?month=' + next, { admin: true })).store.goal_cents, null);
    assert.equal((await api('/store/sales/performance?month=' + month, { admin: true })).store.goal_cents, 3000000);
    assert.equal((await request('/store/sales/performance?month=2026-13', { admin: true })).status, 400);

    // ---- Gravação desligada ----
    assert.equal((await api('/store/settings')).recordings_enabled, true);
    assert.equal((await request('/store/recordings', { method: 'PATCH', token: taina.token, body: { enabled: false } })).status, 403);
    assert.equal((await api('/store/recordings', { method: 'PATCH', body: { enabled: false } })).recordings_enabled, false);
    assert.equal((await api('/store/settings')).recordings_enabled, false);
  } finally { await f.cleanup(); }
});
