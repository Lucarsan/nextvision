import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('cashback: ganhar, usar com limite, estornar, vencer e avisar', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignToken, masterToken, db } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api('/master/tenants/' + f.foreignTenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });

    // Desligado por padrão: venda não gera cashback e não aceita uso.
    let cfg = await api('/store/sales/config');
    assert.equal(cfg.cashback_enabled, false); assert.equal(cfg.cashback_percent, 5); assert.equal(cfg.cashback_max_use_percent, 30); assert.equal(cfg.cashback_valid_days, 90);
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const off = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Maria Souza', phone: '85 98888-1234' }, total_cents: 10000, payment_method: 'pix' } }, 201);
    const maria = off.customer.id;
    assert.equal(off.sale.cashback_earned_cents, 0); assert.equal(off.cashback.balance_cents, 0);
    assert.equal((await request('/store/sales', { method: 'POST', body: { customer_id: maria, total_cents: 1000, payment_method: 'pix', cashback_use_cents: 100 } })).status, 409);

    // Só o dono configura; valores fora da faixa são recusados.
    const op = await f.addOperator(tenant);
    assert.equal((await request('/store/sales/cashback', { method: 'PATCH', token: op.token, body: { cashback_enabled: true } })).status, 403);
    assert.equal((await request('/store/sales/cashback', { method: 'PATCH', body: { cashback_percent: 80 } })).status, 400);
    assert.equal((await request('/store/sales/cashback', { method: 'PATCH', body: { cashback_valid_days: 3 } })).status, 400);
    cfg = await api('/store/sales/cashback', { method: 'PATCH', body: { cashback_enabled: true, cashback_percent: 5, cashback_max_use_percent: 30, cashback_valid_days: 90, cashback_rules: 'Não vale para aparelhos.' } });
    assert.equal(cfg.cashback_enabled, true); assert.equal(cfg.cashback_rules, 'Não vale para aparelhos.');

    // Ganha 5% do valor pago, com validade de 90 dias.
    const today = (await db.query(`SELECT to_char((now() AT TIME ZONE 'America/Fortaleza')::date,'YYYY-MM-DD') d, to_char((now() AT TIME ZONE 'America/Fortaleza')::date+90,'YYYY-MM-DD') e`)).rows[0];
    const s1 = await api('/store/sales', { method: 'POST', body: { customer_id: maria, total_cents: 10000, payment_method: 'cash' } }, 201);
    assert.equal(s1.sale.cashback_earned_cents, 500);
    assert.deepEqual(s1.cashback, { balance_cents: 500, next_expires_on: today.e, next_expiring_cents: 500, used_cents: 0, earned_cents: 500 });
    assert.equal((await api(`/store/sales/customers/${maria}`)).cashback.balance_cents, 500);
    assert.equal((await api('/store/sales/customers?q=maria'))[0].cashback.balance_cents, 500);

    // Uso: no máximo 30% da compra (R$ 3,00 de R$ 10,00), mesmo com saldo maior.
    const over = await request('/store/sales', { method: 'POST', body: { customer_id: maria, total_cents: 1000, payment_method: 'cash', cashback_use_cents: 400 } });
    assert.equal(over.status, 400); assert.match(over.data.error, /R\$ 3,00/);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 1000, payment_method: 'cash', cashback_use_cents: 100 } })).status, 400, 'sem cliente não usa');
    const s2 = await api('/store/sales', { method: 'POST', body: { customer_id: maria, total_cents: 1000, payment_method: 'cash', cashback_use_cents: 300 } }, 201);
    assert.equal(s2.sale.total_cents, 700, 'paga só a diferença'); assert.equal(s2.sale.cashback_used_cents, 300);
    assert.equal(s2.sale.cashback_earned_cents, 35, 'novo cashback sobre o valor pago');
    assert.equal(s2.cashback.balance_cents, 500 - 300 + 35);

    // Com itens: o abatimento entra nos itens (a soma dos itens bate com o total pago).
    const s3 = await api('/store/sales', { method: 'POST', body: { customer_id: maria, payment_method: 'pix', cashback_use_cents: 200,
      items: [{ name: 'Capa', quantity: 2, unit_price_cents: 1500 }, { name: 'Película', quantity: 1, unit_price_cents: 1000 }] } }, 201);
    assert.equal(s3.sale.total_cents, 3800);
    const rc = await api(`/store/sales/${s3.sale.id}/receipt`);
    assert.equal(rc.items.reduce((a, i) => a + i.total_cents, 0), 3800); assert.equal(rc.cashback_used_cents, 200); assert.equal(rc.cashback_earned_cents, 190);
    assert.equal(rc.cashback.balance_cents, 235 - 200 + 190);

    // Caixa: entradas são o que foi pago; o resumo mostra cashback usado e gerado.
    let cash = await api('/store/cash');
    assert.equal(cash.summary.by_method.cash.total_cents, 10000 + 700);
    assert.equal(cash.summary.cashback_used_cents, 500); assert.equal(cash.summary.cashback_earned_cents, 500 + 35 + 190);

    // Cancelamento: devolve o que a venda usou e tira o que ela gerou.
    const c2 = await api(`/store/sales/${s2.sale.id}/cancel`, { method: 'POST', body: { reason: 'Lançada errada' } });
    assert.equal(c2.cashback_returned_cents, 300); assert.equal(c2.cashback_removed_cents, 35); assert.equal(c2.cashback_already_spent_cents, 0);
    assert.equal((await api(`/store/sales/customers/${maria}`)).cashback.balance_cents, 500 - 200 + 190);
    // O cashback da venda 1 já foi gasto em parte (na venda 3): cancelar a venda 1 avisa quanto já tinha sido usado.
    const c1 = await api(`/store/sales/${s1.sale.id}/cancel`, { method: 'POST', body: { reason: 'Teste' } });
    assert.equal(c1.cashback_removed_cents, 500); assert.equal(c1.cashback_already_spent_cents, 200);
    assert.equal((await api(`/store/sales/customers/${maria}`)).cashback.balance_cents, 190);
    cash = await api('/store/cash');
    assert.equal(cash.summary.cashback_used_cents, 200); assert.equal(cash.summary.cashback_earned_cents, 190);

    // Mensagem do dia traz saldo e cashback ganho no dia.
    const day = await api('/store/messages/status');
    const row = day.customers.find(c => c.id === maria);
    assert.equal(row.cashback.balance_cents, 190); assert.equal(row.cashback.earned_cents, 190);

    // Avisos de vencimento: aparece a partir de 15 dias, uma vez por etapa (15, 10, 5, 1).
    let list = await api('/store/messages/cashback');
    assert.equal(list.customers.length, 0, 'saldo novo não está perto de vencer');
    list = await api('/store/messages/cashback?all=1');
    assert.equal(list.customers.length, 1); assert.equal(list.total_balance_cents, 190); assert.equal(list.customers_with_balance, 1);
    await db.query(`UPDATE cashback_lots SET expires_on=(now() AT TIME ZONE 'America/Fortaleza')::date+4 WHERE sale_id=$1`, [s3.sale.id]);
    list = await api('/store/messages/cashback');
    let r = list.customers[0];
    assert.equal(r.days_left, 4); assert.equal(r.stage, 5); assert.equal(r.expiring_cents, 190); assert.equal(r.sent, false);
    await api('/store/messages/sent', { method: 'POST', body: { customer_id: maria, kind: 'cashback', campaign: r.campaign } }, 201);
    assert.equal((await request('/store/messages/sent', { method: 'POST', body: { customer_id: maria, kind: 'cashback' } })).status, 400);
    r = (await api('/store/messages/cashback')).customers[0];
    assert.equal(r.sent, true);
    await db.query(`UPDATE cashback_lots SET expires_on=(now() AT TIME ZONE 'America/Fortaleza')::date WHERE sale_id=$1`, [s3.sale.id]);
    r = (await api('/store/messages/cashback')).customers[0];
    assert.equal(r.days_left, 0); assert.equal(r.stage, 1); assert.equal(r.sent, false, 'nova etapa, novo aviso');

    // Vencido não conta e não pode ser usado.
    await db.query(`UPDATE cashback_lots SET expires_on=(now() AT TIME ZONE 'America/Fortaleza')::date-1 WHERE sale_id=$1`, [s3.sale.id]);
    assert.equal((await api(`/store/sales/customers/${maria}`)).cashback.balance_cents, 0);
    assert.equal((await request('/store/sales', { method: 'POST', body: { customer_id: maria, total_cents: 1000, payment_method: 'cash', cashback_use_cents: 100 } })).status, 400);
    assert.equal((await api('/store/messages/cashback?all=1')).customers.length, 0);

    // Valor mínimo e outra loja.
    await api('/store/sales/cashback', { method: 'PATCH', body: { cashback_min_sale_cents: 5000 } });
    const small = await api('/store/sales', { method: 'POST', body: { customer_id: maria, total_cents: 1000, payment_method: 'cash' } }, 201);
    assert.equal(small.sale.cashback_earned_cents, 0);
    assert.equal((await api('/store/messages/cashback?all=1', { token: foreignToken })).customers.length, 0);
    assert.equal((await request(`/store/sales/customers/${maria}`, { token: foreignToken })).status, 404);
  } finally { await f.cleanup(); }
});
