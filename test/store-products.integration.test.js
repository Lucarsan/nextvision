import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('produtos com código de barras e venda pelo leitor', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignToken, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api('/store/loyalty', { method: 'PATCH', body: { loyalty_enabled: true, loyalty_target: 5, loyalty_reward: 'Película grátis' } });
    await api('/store/sales/config', { method: 'PATCH', body: { loyalty_min_sale_cents: 2000 } });

    // Cadastro: código único por loja; outra loja pode usar o mesmo código.
    const pel = await api('/store/products', { method: 'POST', body: { name: 'Película 3D', barcode: '7891234567895', price_cents: 1500 } }, 201);
    const cab = await api('/store/products', { method: 'POST', body: { name: 'Cabo USB-C', barcode: 'CAB-01', price_cents: 2500 } }, 201);
    const semCodigo = await api('/store/products', { method: 'POST', body: { name: 'Capinha avulsa', price_cents: 3000 } }, 201);
    assert.equal(semCodigo.barcode, null);
    assert.equal((await request('/store/products', { method: 'POST', body: { name: 'Outra', barcode: '7891234567895', price_cents: 100 } })).status, 409);
    assert.equal((await request('/store/products', { method: 'POST', body: { name: 'Espaço', barcode: '789 123', price_cents: 100 } })).status, 400);
    await api('/store/products', { method: 'POST', token: foreignToken, body: { name: 'Da outra loja', barcode: '7891234567895', price_cents: 999 } }, 403); // outra loja sem caixa ligado

    // Leitura do código: acha o produto; desconhecido devolve 404; outra loja não vê.
    assert.equal((await api('/store/products/barcode/7891234567895')).id, pel.id);
    assert.equal((await request('/store/products/barcode/0000000000000')).status, 404);
    assert.equal((await request('/store/products/barcode/7891234567895', { token: foreignToken })).status, 403);
    assert.equal((await api('/store/products?q=pelicula'))[0].id, pel.id, 'busca sem acento');
    assert.equal((await api('/store/products?q=CAB-01'))[0].id, cab.id, 'busca pelo código');

    // Venda com itens: total e descrição calculados no servidor; o mesmo produto bipado 2x soma.
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const maria = (await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Maria', phone: '85 98888-1234' }, total_cents: 100, payment_method: 'pix' } }, 201)).customer;
    const sale = await api('/store/sales', { method: 'POST', body: { customer_id: maria.id, payment_method: 'cash', items: [
      { product_id: pel.id, quantity: 1 }, { product_id: cab.id, quantity: 1 }, { product_id: pel.id, quantity: 1 }
    ] } }, 201);
    assert.equal(sale.sale.total_cents, 1500 * 2 + 2500);
    assert.equal(sale.sale.description, '2x Película 3D, Cabo USB-C');
    assert.deepEqual(sale.sale.items.map(i => [i.name, i.quantity, i.total_cents]), [['Película 3D', 2, 3000], ['Cabo USB-C', 1, 2500]]);
    assert.equal(sale.loyalty_counted, true, 'total calculado vale para o mínimo da fidelidade');

    // Itens aparecem no caixa (tela e relatório) com o preço do momento da venda.
    await api('/store/products/' + pel.id, { method: 'PATCH', body: { price_cents: 1800 } });
    const cash = await api('/store/cash');
    const row = cash.sales.find(x => x.id === sale.sale.id);
    assert.deepEqual(row.items.map(i => [i.name, i.quantity, i.unit_price_cents]), [['Película 3D', 2, 1500], ['Cabo USB-C', 1, 2500]]);
    assert.equal(cash.summary.by_method.cash.total_cents, 5500);
    const again = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'debit', items: [{ product_id: pel.id, quantity: 3 }] } }, 201);
    assert.equal(again.sale.total_cents, 5400, 'novo preço vale para vendas novas');

    // Regras: não mistura total digitado com itens; produto excluído não vende; produto de outra loja não entra.
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', total_cents: 100, items: [{ product_id: cab.id, quantity: 1 }] } })).status, 400);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix' } })).status, 400);
    await api('/store/products/' + cab.id, { method: 'DELETE' });
    assert.equal((await request('/store/products/barcode/CAB-01')).status, 404);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ product_id: cab.id, quantity: 1 }] } })).status, 400);
    const reused = await api('/store/products', { method: 'POST', body: { name: 'Cabo novo', barcode: 'CAB-01', price_cents: 2000 } }, 201);
    assert.equal((await api('/store/products/barcode/CAB-01')).id, reused.id, 'código liberado pelo produto excluído');
    assert.equal((await request('/store/products/' + reused.id, { method: 'PATCH', body: { barcode: '7891234567895' } })).status, 409);

    // Comprovante: loja, itens com preço do momento, cliente e cartão fidelidade; outra loja não acessa.
    const rec = await api(`/store/sales/${sale.sale.id}/receipt`);
    assert.equal(rec.sale_number, sale.sale.sale_number); assert.equal(rec.store_name, 'Loja de teste'); assert.equal(rec.customer_name, 'Maria');
    assert.deepEqual(rec.items.map(i => [i.name, i.quantity, i.unit_price_cents, i.total_cents]), [['Película 3D', 2, 1500, 3000], ['Cabo USB-C', 1, 2500, 2500]]);
    assert.equal(rec.loyalty.target, 5);
    assert.equal((await request(`/store/sales/${sale.sale.id}/receipt`, { token: foreignToken })).status, 403);

    // Cancelar a venda mantém os itens no histórico, fora do total.
    await api(`/store/sales/${sale.sale.id}/cancel`, { method: 'POST', body: { reason: 'Teste de cancelamento' } });
    const after = await api('/store/cash');
    assert.equal(after.sales.find(x => x.id === sale.sale.id).items.length, 2);
    assert.equal(after.summary.by_method.cash, undefined);
  } finally { await f.cleanup(); }
});

test('custo, estoque, desconto e código gerado pelo sistema', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);

    // Custo e estoque no cadastro e na edição; sem estoque informado = não controla.
    const capa = await api('/store/products', { method: 'POST', body: { name: 'Capa', barcode: 'CAPA-1', price_cents: 3500, cost_cents: 1200, stock_qty: 10 } }, 201);
    assert.deepEqual([capa.cost_cents, capa.stock_qty, capa.generated_barcode], [1200, 10, false]);
    const livre = await api('/store/products', { method: 'POST', body: { name: 'Serviço avulso', price_cents: 1000 } }, 201);
    assert.equal(livre.stock_qty, null);
    const ed = await api('/store/products/' + capa.id, { method: 'PATCH', body: { cost_cents: 1300 } });
    assert.deepEqual([ed.cost_cents, ed.stock_qty, ed.price_cents], [1300, 10, 3500], 'edição parcial não apaga o resto');
    assert.equal((await api('/store/products/' + capa.id, { method: 'PATCH', body: { cost_cents: null } })).cost_cents, null);
    await api('/store/products/' + capa.id, { method: 'PATCH', body: { cost_cents: 1300 } });

    // Gerar código: EAN-13 interno começando com 2, estoque = quantidade de etiquetas.
    const gen = await api('/store/products/generate', { method: 'POST', body: { name: 'Chaveiro', price_cents: 1500, cost_cents: 500, quantity: 5 } }, 201);
    assert.match(gen.barcode, /^2\d{12}$/);
    const d = gen.barcode.split('').map(Number); const sum = d.slice(0, 12).reduce((a, n, i) => a + n * (i % 2 ? 3 : 1), 0);
    assert.equal(d[12], (10 - (sum % 10)) % 10, 'dígito verificador EAN-13');
    assert.deepEqual([gen.stock_qty, gen.generated_barcode, gen.cost_cents], [5, true, 500]);
    const gen2 = await api('/store/products/generate', { method: 'POST', body: { name: 'Chaveiro 2', price_cents: 1500, quantity: 1 } }, 201);
    assert.notEqual(gen2.barcode, gen.barcode);
    assert.equal((await api('/store/products/barcode/' + gen.barcode)).id, gen.id, 'o leitor reconhece o código gerado');
    assert.equal((await request('/store/products/generate', { method: 'POST', body: { name: 'X', price_cents: 100, quantity: 1 } })).status, 400);

    // Venda com desconto: baixa no estoque, guarda o custo do momento.
    const r = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ product_id: capa.id, quantity: 2 }, { product_id: gen.id, quantity: 3 }, { product_id: livre.id, quantity: 1 }], discount_cents: 500 } }, 201);
    assert.equal(r.sale.total_cents, 7000 + 4500 + 1000 - 500);
    assert.equal(r.sale.discount_cents, 500);
    const stock = async id => (await api('/store/products?q=' + encodeURIComponent((await f.db.query('SELECT name FROM products WHERE id=$1', [id])).rows[0].name))).find(p => p.id === id).stock_qty;
    assert.equal(await stock(capa.id), 8); assert.equal(await stock(gen.id), 2); assert.equal(await stock(livre.id), null);
    const costs = (await f.db.query('SELECT name,unit_cost_cents FROM sale_items WHERE sale_id=$1 ORDER BY position', [r.sale.id])).rows;
    assert.deepEqual(costs.map(x => x.unit_cost_cents), [1300, 500, null]);
    assert.equal((await api('/store/sales/' + r.sale.id + '/receipt')).discount_cents, 500);

    // Desconto inválido: maior ou igual aos itens, ou sem produtos.
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ product_id: capa.id, quantity: 1 }], discount_cents: 3500 } })).status, 400);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', total_cents: 1000, discount_cents: 100 } })).status, 400);

    // Cancelar devolve ao estoque.
    await api('/store/sales/' + r.sale.id + '/cancel', { method: 'POST', body: { reason: 'teste de estoque' } });
    assert.equal(await stock(capa.id), 10); assert.equal(await stock(gen.id), 5);

    // Entrada de estoque: soma; produto sem controle passa a controlar.
    assert.equal((await api('/store/products/' + gen.id + '/stock', { method: 'POST', body: { add: 10 } })).stock_qty, 15);
    assert.equal((await api('/store/products/' + livre.id + '/stock', { method: 'POST', body: { add: 3 } })).stock_qty, 3);
    assert.equal((await request('/store/products/' + gen.id + '/stock', { method: 'POST', body: { add: 0 } })).status, 400);
  } finally { await f.cleanup(); }
});

test('vendedor da venda: lista da loja, pré-seleção da última venda e logins na central', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignTenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    // Central cria um vendedor (operador) e lista os logins da loja.
    const ana = await api('/master/tenants/' + tenant + '/users', { method: 'POST', token: masterToken, body: { name: 'Ana Vendedora', email: 'ana-' + tenant + '@example.test', password: 'senha-forte-123', role: 'operator' } }, 201);
    const logins = await api('/master/tenants/' + tenant + '/users', { token: masterToken });
    assert.deepEqual(logins.map(u => u.role).sort(), ['operator', 'owner']);
    const outra = await api('/master/tenants/' + foreignTenant + '/users', { method: 'POST', token: masterToken, body: { name: 'De outra loja', email: 'x-' + tenant + '@example.test', password: 'senha-forte-123', role: 'operator' } }, 201);

    let s = await api('/store/sales/sellers');
    assert.deepEqual(s.sellers.map(x => x.name), ['Ana Vendedora', 'Owner']);
    assert.equal(s.last_seller_id, null);

    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const v1 = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', total_cents: 1000, seller_id: ana.id } }, 201);
    assert.equal(v1.sale.seller_id, ana.id);
    assert.equal((await api('/store/sales/sellers')).last_seller_id, ana.id, 'última venda pré-seleciona a Ana');
    // Sem vendedor: fica quem registrou. Vendedor de outra loja é recusado.
    const v2 = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'cash', total_cents: 500 } }, 201);
    assert.equal((await api('/store/sales/sellers')).last_seller_id, v2.sale.seller_id);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', total_cents: 100, seller_id: outra.id } })).status, 400);

    const cash = await api('/store/cash');
    assert.deepEqual(cash.summary.by_seller.map(x => [x.name, x.count, x.total_cents]), [['Ana Vendedora', 1, 1000], ['Owner', 1, 500]]);
    assert.equal((await api('/store/sales/' + v1.sale.id + '/receipt')).seller_name, 'Ana Vendedora');

    // Desativar na central: some da lista e não pode mais ser escolhida.
    await api('/master/users/' + ana.id, { method: 'PATCH', token: masterToken, body: { active: false } });
    s = await api('/store/sales/sellers');
    assert.deepEqual(s.sellers.map(x => x.name), ['Owner']);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', total_cents: 100, seller_id: ana.id } })).status, 400);
    assert.equal((await request('/master/tenants/' + tenant + '/users')).status, 403, 'lojista não lista logins da central');
  } finally { await f.cleanup(); }
});

test('preço editado por item, linhas avulsas e desconto distribuído nos itens', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const pel = await api('/store/products', { method: 'POST', body: { name: 'Película', price_cents: 2000, stock_qty: 5 } }, 201);
    // Película vendida por R$ 15 (preço editado) + 10 xerox a R$ 0,20 (linha avulsa).
    const r = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [
      { product_id: pel.id, quantity: 2, unit_price_cents: 1500 }, { name: 'Xerox', quantity: 10, unit_price_cents: 20 }] } }, 201);
    assert.equal(r.sale.total_cents, 3200);
    assert.deepEqual(r.sale.items.map(i => [i.name, i.quantity, i.unit_price_cents, i.list_price_cents, i.total_cents]), [['Película', 2, 1500, 2000, 3000], ['Xerox', 10, 20, null, 200]]);
    assert.equal(r.sale.description, '2x Película, 10x Xerox');
    const rec = await api('/store/sales/' + r.sale.id + '/receipt');
    assert.deepEqual(rec.items.map(i => [i.name, i.quantity, i.total_cents]), [['Película', 2, 3000], ['Xerox', 10, 200]]);
    assert.equal((await api('/store/products?q=pel'))[0].stock_qty, 3, 'baixa só do produto');
    // Desconto geral: distribuído entre os itens, soma das linhas = total cobrado.
    const d = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'cash', discount_cents: 100, items: [
      { product_id: pel.id, quantity: 1 }, { name: 'Capa avulsa', quantity: 1, unit_price_cents: 1000 }] } }, 201);
    assert.equal(d.sale.total_cents, 2900);
    assert.equal(d.sale.items.reduce((a, i) => a + i.total_cents, 0), 2900);
    // Linha avulsa precisa de nome e preço.
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ name: 'Sem preço', quantity: 1 }] } })).status, 400);
  } finally { await f.cleanup(); }
});

test('operador novato: vende e cadastra produto, mas não dá desconto, não muda preço, não cancela nem fecha o caixa', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    const nov = await f.addOperator(tenant, 'basic', 'Novato');
    const as = (path, opt = {}) => request(path, { ...opt, token: nov.token });
    assert.equal((await api('/store/sales/config', { token: nov.token })).access_level, 'basic');
    assert.equal((await api('/store/sales/config')).access_level, 'full', 'dono é livre');

    assert.equal((await as('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } })).status, 201, 'novato abre o caixa');
    const p = (await as('/store/products', { method: 'POST', body: { name: 'Capa', price_cents: 3000, cost_cents: 1000 } })).data;
    assert.ok(p.id, 'novato cadastra produto');
    const ok = await as('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ product_id: p.id, quantity: 1 }] } });
    assert.equal(ok.status, 201, 'novato vende pelo preço de cadastro');
    assert.equal((await as('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ product_id: p.id, quantity: 1, unit_price_cents: 2500 }] } })).status, 403);
    assert.equal((await as('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ product_id: p.id, quantity: 1 }], discount_cents: 100 } })).status, 403);
    assert.equal((await as('/store/sales/' + ok.data.sale.id + '/cancel', { method: 'POST', body: { reason: 'teste novato' } })).status, 403);
    assert.equal((await as('/store/cash/movements', { method: 'POST', body: { kind: 'expense', amount_cents: 100, method: 'cash', category: 'Outros', note: 'x' } })).status, 403);
    assert.equal((await as('/store/cash/close', { method: 'POST', body: { counted_cash_cents: 0 } })).status, 403);

    // Central muda para livre: vale na hora, sem novo login.
    const users = await api('/master/tenants/' + tenant + '/users', { token: masterToken });
    assert.equal(users.find(u => u.id === nov.id).access_level, 'basic');
    await api('/master/users/' + nov.id, { method: 'PATCH', token: masterToken, body: { access_level: 'full' } });
    assert.equal((await as('/store/sales/' + ok.data.sale.id + '/cancel', { method: 'POST', body: { reason: 'agora livre' } })).status, 200);
    // Criar já como novato pela central.
    const n2 = await api('/master/tenants/' + tenant + '/users', { method: 'POST', token: masterToken, body: { name: 'Outro Novato', email: 'n2-' + tenant + '@example.test', password: 'senha-forte-123', role: 'operator', access_level: 'basic' } }, 201);
    assert.equal(n2.access_level, 'basic');
  } finally { await f.cleanup(); }
});
