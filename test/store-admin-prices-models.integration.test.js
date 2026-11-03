import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture, FIXTURE_ADMIN } from './helpers/store-fixture.js';
import { reportData, reportHtml } from '../src/reports.js';
import { newPrice, inWindow } from '../src/store-admin.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('preço novo e período do mês', () => {
  assert.equal(newPrice(2000, 10), 2200);
  assert.equal(newPrice(2190, 7, '0.50'), 2350); // 23,43 → 23,50
  assert.equal(newPrice(2190, 7, '1.00'), 2300);
  assert.equal(newPrice(3000, -10, '0.10'), 2700);
  assert.ok(inWindow(5, 30, 1, 10)); assert.ok(!inWindow(11, 30, 1, 10));
  assert.ok(inWindow(27, 30, 25, 5)); assert.ok(inWindow(3, 30, 25, 5)); assert.ok(!inWindow(10, 30, 25, 5));
  assert.ok(inWindow(28, 28, 31, 31), 'dia 31 = último dia em fevereiro');
});

test('senha do admin, capas no total com modelo, brinde, custos, preços em lote e por época, histórico do cliente', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    const op = await f.addOperator(tenant, 'full', 'Ana');

    // ---------- Senha do admin ----------
    const cabo = await api('/store/products', { method: 'POST', body: { name: 'Cabo USB', price_cents: 1500, cost_cents: 500, stock_qty: 10 } }, 201);
    const noAdmin = await request('/store/products/' + cabo.id, { method: 'PATCH', body: { price_cents: 1700 } });
    assert.equal(noAdmin.status, 401); assert.equal(noAdmin.data.admin_required, true);
    assert.equal((await request('/store/products/' + cabo.id, { method: 'DELETE' })).status, 401);
    assert.equal((await request('/store/admin/unlock', { method: 'POST', body: { login: FIXTURE_ADMIN.login, password: 'errada' } })).status, 401);
    // Pôr código num produto que não tinha: sem senha. Trocar código: com senha.
    assert.equal((await api('/store/products/' + cabo.id, { method: 'PATCH', body: { barcode: 'CABO-1' } })).barcode, 'CABO-1');
    assert.equal((await request('/store/products/' + cabo.id, { method: 'PATCH', body: { barcode: 'CABO-2' } })).status, 401);
    // Liberação é do usuário: a do dono não vale para o operador.
    const unlock = await api('/store/admin/unlock', { method: 'POST', body: FIXTURE_ADMIN });
    const asOp = await fetch(f.base + '/api/store/products/' + cabo.id, { method: 'PATCH', headers: { Authorization: 'Bearer ' + op.token, 'Content-Type': 'application/json', 'X-Admin-Token': unlock.admin_token }, body: JSON.stringify({ price_cents: 1700 }) });
    assert.equal(asOp.status, 401);
    assert.equal((await api('/store/products/' + cabo.id, { method: 'PATCH', body: { price_cents: 1600 }, admin: true })).price_cents, 1600);
    assert.equal((await api('/store/products/' + cabo.id, { method: 'PATCH', body: { price_cents: 1500 }, token: op.token, admin: true })).price_cents, 1500);

    // ---------- Capas contadas no total, venda pergunta o modelo ----------
    const capa = await api('/store/products', { method: 'POST', body: { name: 'CAPA MODELOS COMUNS', barcode: 'CAPA', price_cents: 2000, cost_cents: 600, ask_variant: true, variant_stock: 'total', stock_qty: 349 } }, 201);
    assert.equal(capa.stock_qty, 349); assert.equal(capa.variant_stock, 'total');
    // Produto que já existia (contado no total) passa a perguntar o modelo sem perder o estoque.
    const pel = await api('/store/products', { method: 'POST', body: { name: 'Película 3D', barcode: 'PEL3D', price_cents: 2000, cost_cents: 100, stock_qty: 504 } }, 201);
    const pel2 = await api('/store/products/' + pel.id, { method: 'PATCH', body: { ask_variant: true, variant_stock: 'total' }, admin: true });
    assert.equal(pel2.stock_qty, 504); assert.equal(pel2.ask_variant, true);

    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ product_id: capa.id, quantity: 1 }] } })).status, 400, 'pede o modelo');
    const s1 = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ product_id: capa.id, quantity: 2, variant_name: 'Galaxy A12' }, { product_id: capa.id, quantity: 1, variant_name: 'iPhone 11' }] } }, 201);
    let p = (await api('/store/products?q=CAPA'))[0];
    assert.equal(p.stock_qty, 346, 'baixa no total');
    let vars = await api(`/store/products/${capa.id}/variants`);
    const a12 = vars.find(v => v.name === 'Galaxy A12');
    assert.equal(a12.restock_pending, 2); assert.equal(a12.stock_qty, null); assert.equal(a12.sold_count, 2);
    let restock = await api('/store/stock/restock');
    assert.deepEqual(restock.filter(r => r.product_id === capa.id).map(r => [r.variant, r.pending, r.stock_qty]).sort(), [['Galaxy A12', 2, 346], ['iPhone 11', 1, 346]]);
    // Log: a venda grava o saldo do produto.
    const log = (await api('/store/stock/log?product_id=' + capa.id)).rows || (await api('/store/stock/log?product_id=' + capa.id));
    const saleMove = (Array.isArray(log) ? log : log.rows).find(m => m.kind === 'sale' && m.variant === 'Galaxy A12');
    assert.equal(saleMove.stock_before, 349); assert.equal(saleMove.stock_after, 347);
    // Cancelar devolve ao total e tira da reposição.
    await api(`/store/sales/${s1.sale.id}/cancel`, { method: 'POST', body: { reason: 'teste de cancelamento' } });
    p = (await api('/store/products?q=CAPA'))[0]; assert.equal(p.stock_qty, 349);
    assert.equal((await api(`/store/products/${capa.id}/variants`)).every(v => v.restock_pending === 0), true);
    // Vende de novo e repõe vários modelos de uma vez: soma ao total e abate a reposição de cada um.
    await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'cash', items: [{ product_id: capa.id, quantity: 3, variant_name: 'galaxy a12' }] } }, 201);
    const many = await api(`/store/products/${capa.id}/stock/models`, { method: 'POST', body: { items: [{ variant_name: 'Galaxy A12', add: 2 }, { variant_name: 'Moto G8', add: 5 }] } });
    assert.equal(many.stock_qty, 346 + 7); assert.equal(many.added, 7);
    vars = await api(`/store/products/${capa.id}/variants`);
    assert.equal(vars.find(v => v.name === 'Galaxy A12').restock_pending, 1);
    assert.equal((await api(`/store/products/${capa.id}/restocked`, { method: 'POST', body: {} })).cleared, 1);
    // Entrada sem modelo também vale (só soma ao total).
    assert.equal((await api(`/store/products/${capa.id}/stock`, { method: 'POST', body: { add: 1 } })).stock_qty, 354);

    // ---------- Brinde junto com serviço ----------
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ product_id: pel.id, quantity: 1, variant_name: 'A12', gift: true }] } })).status, 400, 'brinde só com serviço');
    const cli = await api('/customers', { method: 'POST', body: { name: 'Maria Souza', phone: '85999990000' } }, 201).catch(async () => (await api('/customers'))[0]);
    const svc = await api('/store/sales', { method: 'POST', body: { customer_id: cli.id, payment_method: 'credit', items: [
      { service: 'Troca de tela', unit_price_cents: 25000, cost_cents: 9000, device_model: 'Galaxy A12', warranty_days: 90 },
      { product_id: pel.id, quantity: 1, variant_name: 'Galaxy A12', gift: true }] } }, 201);
    assert.equal(svc.sale.total_cents, 25000);
    const gift = svc.sale.items.find(i => i.gift); assert.equal(gift.total_cents, 0);
    assert.equal((await api('/store/products?q=PEL3D'))[0].stock_qty, 503);
    const receipt = await api(`/store/sales/${svc.sale.id}/receipt`);
    assert.equal(receipt.items.find(i => i.gift).gift, true);

    // ---------- Custos e saldo líquido ----------
    // Vendas válidas: 3 capas (custo 600) + serviço (custo 9000) + brinde (custo 100).
    await api('/store/cash/movements', { method: 'POST', body: { kind: 'expense', amount_cents: 1000, category: 'Outros', note: 'lanche' } }, 201);
    const cash = await api('/store/cash');
    assert.equal(cash.summary.costs_cents, 3 * 600 + 9000 + 100);
    assert.equal(cash.summary.net_cents, undefined, 'saldo líquido só no e-mail');
    assert.equal((await fetch(f.base + '/api/store/cash/costs', { headers: { Authorization: 'Bearer ' + f.ownerToken } })).status, 404, 'detalhe de custos só no e-mail');
    const day = (await f.db.query("SELECT to_char(now() AT TIME ZONE 'America/Fortaleza','YYYY-MM-DD') d")).rows[0].d;
    const rep = await reportData((sql, params) => f.db.query(sql, params), tenant, 'daily', day);
    assert.equal(rep.costs_total, 3 * 600 + 9000 + 100); assert.equal(rep.net, rep.sales_total - rep.costs_total - 1000);
    assert.match(reportHtml(rep), /Saldo líquido/);
    assert.ok(rep.restock.some(r => r.name === 'Película 3D' && r.variant === 'Galaxy A12'), 'brinde entra na reposição');

    // ---------- Reajuste em lote ----------
    assert.equal((await request('/store/products/reprice', { method: 'POST', body: { percent: 10, scope: 'all' } })).status, 401);
    const prev = await api('/store/products/reprice', { method: 'POST', body: { percent: 10, rounding: '0.50', scope: 'all', preview: true }, admin: true });
    assert.equal(prev.preview, true); assert.equal((await api('/store/products?q=Cabo'))[0].price_cents, 1500, 'prévia não muda');
    const done = await api('/store/products/reprice', { method: 'POST', body: { percent: 10, rounding: '0.50', scope: 'selected', product_ids: [cabo.id, capa.id] }, admin: true }, 201);
    assert.equal(done.count, 2);
    assert.equal((await api('/store/products?q=Cabo'))[0].price_cents, 1650);
    assert.equal((await api('/store/products?q=CAPA'))[0].price_cents, 2200);
    assert.equal((await api('/store/products?q=PEL3D'))[0].price_cents, 2000, 'não escolhido fica igual');
    // Mudou um preço depois: o desfazer deixa esse como está.
    await api('/store/products/' + cabo.id, { method: 'PATCH', body: { price_cents: 1990 }, admin: true });
    const undo = await api(`/store/price-batches/${done.batch.id}/undo`, { method: 'POST', body: {}, admin: true });
    assert.equal(undo.restored, 1);
    assert.equal((await api('/store/products?q=Cabo'))[0].price_cents, 1990);
    assert.equal((await api('/store/products?q=CAPA'))[0].price_cents, 2000);
    assert.equal((await request(`/store/price-batches/${done.batch.id}/undo`, { method: 'POST', body: {}, admin: true })).status, 409);

    // ---------- Preço por época do mês ----------
    const today = Number(day.slice(8, 10));
    const rule = await api('/store/price-rules', { method: 'POST', admin: true, body: { name: 'Películas meio do mês', percent: 20, rounding: 'none', day_from: today, day_to: today, product_ids: [pel.id] } }, 201);
    assert.equal((await api('/store/products?q=PEL3D'))[0].price_cents, 2400);
    assert.equal((await api('/store/products?q=PEL3D'))[0].seasonal_base_cents, 2000);
    const other = today === 1 ? 2 : 1; // fora do período hoje: não mexe
    await api('/store/price-rules', { method: 'POST', admin: true, body: { name: 'Fora', percent: 50, day_from: other, day_to: other, product_ids: [cabo.id] } }, 201);
    assert.equal((await api('/store/products?q=Cabo'))[0].price_cents, 1990);
    const rules = await api('/store/price-rules');
    assert.equal(rules.rules.find(r => r.id === rule.id).in_window, true);
    // A venda usa o preço de época.
    const s3 = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ product_id: pel.id, quantity: 1, variant_name: 'A32' }] } }, 201);
    assert.equal(s3.sale.total_cents, 2400);
    // Editar o preço no meio da época: o digitado é o normal.
    const ed = await api('/store/products/' + pel.id, { method: 'PATCH', body: { price_cents: 2500 }, admin: true });
    assert.equal(ed.price_cents, 3000); assert.equal(ed.seasonal_base_cents, 2500);
    // Desligar a regra: volta ao normal.
    await api('/store/price-rules/' + rule.id, { method: 'PATCH', body: { active: false }, admin: true });
    assert.equal((await api('/store/products?q=PEL3D'))[0].price_cents, 2500);
    assert.equal((await api('/store/products?q=PEL3D'))[0].seasonal_base_cents, null);
    await api('/store/price-rules/' + rule.id, { method: 'DELETE', admin: true });
    assert.equal((await request('/store/price-rules', { method: 'POST', body: { name: 'x', percent: 5, day_from: 1, day_to: 2, product_ids: [pel.id] } })).status, 401);

    // ---------- Histórico do cliente ----------
    const h = await api(`/store/customers/${cli.id}/history`, { token: op.token });
    assert.equal(h.customer.name, 'Maria Souza');
    assert.equal(h.totals.spent_cents, 25000); assert.equal(h.totals.services, 1);
    assert.equal(h.totals.by_method.credit.total_cents, 25000);
    assert.equal(h.warranties.length, 1); assert.equal(h.warranties[0].device_model, 'Galaxy A12');
    const it = h.sales[0].items.find(i => i.service);
    assert.equal(it.unit_cost_cents, null, 'operador não vê custo');
    assert.equal((await api(`/store/customers/${cli.id}/history`)).sales[0].items.find(i => i.service).unit_cost_cents, 9000, 'dono vê custo');
    assert.equal((await request(`/store/customers/${cli.id}/history`, { token: f.foreignToken })).status, 404);
  } finally { await f.cleanup(); }
});
