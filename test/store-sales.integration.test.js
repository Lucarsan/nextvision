import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('caixa, vendas, fidelidade e mensagens do dia', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignToken, masterToken, db } = f;

    // Desligado por padrão: o painel recebe enabled:false e as rotas recusam.
    assert.deepEqual(await api('/store/sales/config'), { enabled: false });
    assert.equal((await request('/store/cash')).status, 403);

    // A central liga só para esta loja.
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    const cfg = await api('/store/sales/config');
    assert.equal(cfg.enabled, true);
    assert.equal((await request('/store/cash', { token: foreignToken })).status, 403, 'outra loja continua sem o recurso');

    await api('/store/loyalty', { method: 'PATCH', body: { loyalty_enabled: true, loyalty_target: 3, loyalty_reward: 'Película grátis' } });
    await api('/store/sales/config', { method: 'PATCH', body: { google_review_url: 'https://g.page/r/abc/review', loyalty_rules: 'Válido por 90 dias.', loyalty_min_sale_cents: 1000 } });

    // Importação de contatos do WhatsApp: deduplica por telefone (com e sem +55 e nono dígito).
    await api('/customers', { method: 'POST', body: { name: 'Já Cadastrada', phone: '(85) 99999-0001' } }, 201);
    const imp = await api('/store/customers/import-contacts', { method: 'POST', body: { contacts: [
      { name: 'Maria Souza', phone: '+55 85 98888-1234' },
      { name: 'Maria S.', phone: '85988881234' },           // repetida no arquivo
      { name: 'Antiga', phone: '5585 9999 0001' },          // já existe
      { name: 'Sem nono', phone: '85 8888-1234' },          // mesma chave da Maria (sem o 9)
      { name: '', phone: '85 97777-4321' },                 // sem nome
      { name: 'Inválido', phone: '123' }
    ] } }, 201);
    assert.deepEqual(imp, { created: 2, skipped_existing: 1, invalid: 1, repeated_in_file: 2, total: 6 });
    const all = await api('/customers');
    assert.ok(all.some(c => c.name === 'Contato 4321' && c.phone === '85977774321'));

    // Caixa: venda sem caixa aberto é recusada.
    const maria = (await api('/store/sales/customers?q=maria'))[0];
    assert.equal(maria.name, 'Maria Souza');
    assert.equal((await request('/store/sales', { method: 'POST', body: { customer_id: maria.id, total_cents: 5000, payment_method: 'pix' } })).status, 409);

    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 10000 } }, 201);
    assert.equal((await request('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } })).status, 409, 'um caixa aberto por vez');

    const s1 = await api('/store/sales', { method: 'POST', body: { customer_id: maria.id, total_cents: 5000, payment_method: 'cash', description: 'Carregador' } }, 201);
    assert.equal(s1.sale.sale_number, 1); assert.equal(s1.loyalty_counted, true); assert.equal(s1.loyalty.checkins, 1); assert.equal(s1.loyalty.remaining, 2);
    const small = await api('/store/sales', { method: 'POST', body: { customer_id: maria.id, total_cents: 500, payment_method: 'pix' } }, 201);
    assert.equal(small.loyalty_counted, false, 'abaixo do valor mínimo não conta');
    const s3 = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'João Novo', phone: '85 91234-5678' }, total_cents: 2000, payment_method: 'debit' } }, 201);
    assert.equal(s3.customer_created, true); assert.equal(s3.loyalty.checkins, 1);
    const again = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Joao', phone: '+5585912345678' }, total_cents: 2000, payment_method: 'credit' } }, 201);
    assert.equal(again.customer_created, false, 'mesmo telefone reaproveita o cliente'); assert.equal(again.customer.id, s3.customer.id);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 1500, payment_method: 'cash' } }, 201);
    assert.equal((await request('/store/sales', { method: 'POST', body: { total_cents: 1500, payment_method: 'cash' } })).status, 400, 'cliente obrigatório ou venda marcada sem cliente');

    // Movimentos e cancelamento.
    await api('/store/cash/movements', { method: 'POST', body: { kind: 'withdrawal', amount_cents: 3000, note: 'Pagamento entregador' } }, 201);
    const canceled = await api(`/store/sales/${again.sale.id}/cancel`, { method: 'POST', body: { reason: 'Lançada em dobro' } });
    assert.equal(canceled.loyalty_removed, true);

    // Fidelidade: chega na meta e resgata no balcão.
    await api('/store/sales', { method: 'POST', body: { customer_id: maria.id, total_cents: 3000, payment_method: 'pix' } }, 201);
    const s5 = await api('/store/sales', { method: 'POST', body: { customer_id: maria.id, total_cents: 3000, payment_method: 'pix' } }, 201);
    assert.equal(s5.loyalty.complete, true);
    const red = await api(`/store/sales/customers/${maria.id}/redeem`, { method: 'POST' }, 201);
    assert.equal(red.reward, 'Película grátis'); assert.equal(red.loyalty.checkins, 0);
    assert.equal((await request(`/store/sales/customers/${maria.id}/redeem`, { method: 'POST' })).status, 409);

    // Mensagens do dia: Maria e João compraram hoje; enviar marca como enviado.
    let day = await api('/store/messages/status');
    assert.equal(day.customers.length, 2);
    const mRow = day.customers.find(c => c.id === maria.id);
    assert.equal(mRow.sent, false); assert.equal(mRow.purchases.length, 4);
    await api('/store/messages/sent', { method: 'POST', body: { customer_id: maria.id, kind: 'status' } }, 201);
    day = await api('/store/messages/status');
    assert.equal(day.customers.find(c => c.id === maria.id).sent, true);

    // Ofertas: quem pediu para sair não aparece.
    await api(`/store/sales/customers/${s3.customer.id}/offers`, { method: 'PATCH', body: { opt_out: true } });
    let offers = await api('/store/messages/offers?campaign=promo1');
    assert.ok(!offers.some(c => c.id === s3.customer.id));
    assert.ok(offers.some(c => c.id === maria.id && !c.sent));
    await api('/store/messages/sent', { method: 'POST', body: { customer_id: maria.id, kind: 'offer', campaign: 'promo1' } }, 201);
    offers = await api('/store/messages/offers?campaign=promo1&days=30');
    assert.deepEqual(offers.map(c => [c.id, c.sent]), [[maria.id, true]], 'filtro de 30 dias deixa só quem comprou');

    // Fechamento: esperado = 100 (troco) + 50 + 15 (dinheiro) - 30 (sangria) = 135,00
    const cash = await api('/store/cash');
    assert.equal(cash.summary.expected_cash_cents, 13500);
    assert.equal(cash.summary.sales_count, 6);
    const closed = await api('/store/cash/close', { method: 'POST', body: { counted_cash_cents: 13000, note: 'Faltou troco' } });
    assert.equal(closed.difference_cents, -500);
    assert.equal((await request(`/store/sales/${s1.sale.id}/cancel`, { method: 'POST', body: { reason: 'tarde demais' } })).status, 409);
    const hist = await api('/store/cash/sessions');
    assert.equal(hist[0].status, 'closed'); assert.equal(hist[0].sales_count, 6); assert.equal(hist[0].linked_count, 5);

    // Outra loja não vê clientes desta.
    await api('/master/tenants/' + f.foreignTenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    assert.equal((await request(`/store/sales/customers/${maria.id}`, { token: foreignToken })).status, 404);
    assert.equal((await request('/store/messages/sent', { method: 'POST', token: foreignToken, body: { customer_id: maria.id, kind: 'status' } })).status, 404);

    // Pedido concluído continua contando no mesmo cartão (check-in antigo por pedido).
    const r = await db.query('SELECT count(*)::int n FROM loyalty_checkins WHERE sale_id IS NOT NULL');
    assert.ok(r.rows[0].n >= 4);
  } finally { await f.cleanup(); }
});
