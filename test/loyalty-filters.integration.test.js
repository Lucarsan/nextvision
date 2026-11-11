import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const todayDow = () => WD[new Intl.DateTimeFormat('en-US', { timeZone: 'America/Fortaleza', weekday: 'short' }).format(new Date())];

// Alê Pet's: a cada 10 banhos, uma hidratação; banho em dia de promoção (quarta) não conta.
test('fidelidade: só os serviços escolhidos contam e o dia de promoção não soma', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, db } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const banho = await api('/store/sales/service-items', { method: 'POST', body: { name: 'Banho porte P', price_cents: 4000 } }, 201);
    const hidra = await api('/store/sales/service-items', { method: 'POST', body: { name: 'Hidratação', price_cents: 2000, addon: true } }, 201);
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Recebido', 'Pronto'] } }, 201);
    const cli = await api('/customers', { method: 'POST', body: { name: 'Afonso Filho', phone: '85997106788' } }, 201);
    const today = todayDow(), other = (today + 3) % 7;
    const checkins = async () => (await db.query('SELECT count(*)::int n FROM loyalty_checkins WHERE customer_id=$1', [cli.id])).rows[0].n;

    // Padrão: sem filtros (como antes).
    let cfg = await api('/store/loyalty');
    assert.deepEqual(cfg.loyalty_off_weekdays, []); assert.deepEqual(cfg.loyalty_service_ids, []);

    // Validações: serviço de outra loja / inexistente, todos os dias bloqueados, dia fora da faixa; operador não configura.
    const base = { loyalty_enabled: true, loyalty_target: 10, loyalty_reward: '1 hidratação' };
    assert.equal((await request('/store/loyalty', { method: 'PATCH', body: { ...base, loyalty_service_ids: [crypto.randomUUID()] } })).status, 400);
    assert.equal((await request('/store/loyalty', { method: 'PATCH', body: { ...base, loyalty_off_weekdays: [0, 1, 2, 3, 4, 5, 6] } })).status, 400);
    assert.equal((await request('/store/loyalty', { method: 'PATCH', body: { ...base, loyalty_off_weekdays: [7] } })).status, 400);
    const op = await f.addOperator(tenant);
    assert.equal((await request('/store/loyalty', { method: 'PATCH', token: op.token, body: base })).status, 403);

    cfg = await api('/store/loyalty', { method: 'PATCH', body: { ...base, loyalty_off_weekdays: [other, other], loyalty_service_ids: [banho.id] } });
    assert.deepEqual(cfg.loyalty_off_weekdays, [other]); assert.deepEqual(cfg.loyalty_service_ids, [banho.id]);
    // Salvar sem mandar os filtros não apaga os filtros.
    cfg = await api('/store/loyalty', { method: 'PATCH', body: base });
    assert.deepEqual(cfg.loyalty_service_ids, [banho.id]);

    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    // Venda só com hidratação: não conta. Com banho: conta.
    let s = await api('/store/sales', { method: 'POST', body: { customer_id: cli.id, payment_method: 'pix', items: [{ service: 'Hidratação', unit_price_cents: 2000, catalog_id: hidra.id }] } }, 201);
    assert.equal(s.loyalty_counted, false); assert.equal(s.sale.loyalty_skip, 'service');
    s = await api('/store/sales', { method: 'POST', body: { customer_id: cli.id, payment_method: 'pix', items: [{ service: 'Banho porte P', unit_price_cents: 4000, catalog_id: banho.id }, { service: 'Hidratação', unit_price_cents: 2000, catalog_id: hidra.id }] } }, 201);
    assert.equal(s.loyalty_counted, true); assert.equal(s.loyalty.checkins, 1);
    // Venda avulsa com o mesmo nome (sem cadastro) também conta; total sem itens, não.
    s = await api('/store/sales', { method: 'POST', body: { customer_id: cli.id, payment_method: 'cash', items: [{ name: 'banho  porte p', quantity: 1, unit_price_cents: 4000 }] } }, 201);
    assert.equal(s.loyalty_counted, true);
    s = await api('/store/sales', { method: 'POST', body: { customer_id: cli.id, payment_method: 'cash', total_cents: 4000 } }, 201);
    assert.equal(s.loyalty_counted, false);
    assert.equal(await checkins(), 2);

    // Pedido ao vivo com banho, pago "a receber": conta ao finalizar.
    const finish = async id => { await api('/orders/' + id + '/transition', { method: 'POST', body: { action: 'start' } }); await api('/orders/' + id + '/transition', { method: 'POST', body: { action: 'advance' } }); await api('/orders/' + id + '/transition', { method: 'POST', body: { action: 'complete' } }); };
    const p1 = await api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, items: [{ service: 'Banho porte P', unit_price_cents: 4000, catalog_id: banho.id }],
      live_order: { process_id: proc.id, details: { item_type: 'pet', pet_name: 'Dom' } } } }, 201);
    await finish(p1.order_id);
    assert.equal(await checkins(), 3);
    // Pedido só de hidratação: não conta.
    const p2 = await api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, items: [{ service: 'Hidratação', unit_price_cents: 2000, catalog_id: hidra.id }],
      live_order: { process_id: proc.id, details: { item_type: 'pet', pet_name: 'Dom' } } } }, 201);
    await finish(p2.order_id);
    assert.equal(await checkins(), 3);
    // Pedido aberto sem venda: vale o texto do serviço do pedido.
    const o3 = await api('/orders', { method: 'POST', body: { customer_id: cli.id, process_id: proc.id, details: { item_type: 'pet', pet_name: 'Dom', service: 'Banho porte P + hidratação' } } }, 201);
    await finish(o3.id);
    assert.equal(await checkins(), 4);
    // Pedido finalizado sem serviço conhecido e pago depois com banho: soma no pagamento.
    const o4 = await api('/orders', { method: 'POST', body: { customer_id: cli.id, process_id: proc.id, details: { item_type: 'pet', pet_name: 'Dom' } } }, 201);
    await finish(o4.id);
    assert.equal(await checkins(), 4);
    s = await api('/store/sales', { method: 'POST', body: { customer_id: cli.id, order_id: o4.id, payment_method: 'pix', items: [{ service: 'Banho porte P', unit_price_cents: 4000, catalog_id: banho.id }] } }, 201);
    assert.equal(s.loyalty_counted, true); assert.equal(await checkins(), 5);

    // Hoje vira dia de promoção: banho não soma (venda nem pedido).
    await api('/store/loyalty', { method: 'PATCH', body: { ...base, loyalty_off_weekdays: [today] } });
    s = await api('/store/sales', { method: 'POST', body: { customer_id: cli.id, payment_method: 'pix', items: [{ service: 'Banho porte P', unit_price_cents: 4000, catalog_id: banho.id }] } }, 201);
    assert.equal(s.loyalty_counted, false); assert.equal(s.sale.loyalty_skip, 'weekday');
    const p5 = await api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, items: [{ service: 'Banho porte P', unit_price_cents: 4000, catalog_id: banho.id }],
      live_order: { process_id: proc.id, details: { item_type: 'pet', pet_name: 'Dom' } } } }, 201);
    await finish(p5.order_id);
    assert.equal(await checkins(), 5);

    // Sem filtros de serviço: qualquer venda volta a contar (fora do dia bloqueado).
    await api('/store/loyalty', { method: 'PATCH', body: { ...base, loyalty_off_weekdays: [], loyalty_service_ids: [] } });
    s = await api('/store/sales', { method: 'POST', body: { customer_id: cli.id, payment_method: 'cash', total_cents: 1500 } }, 201);
    assert.equal(s.loyalty_counted, true); assert.equal(await checkins(), 6);
  } finally { await f.cleanup(); }
});
