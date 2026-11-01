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
    const canceledRow = cash.sales.find(x => x.id === again.sale.id);
    assert.equal(canceledRow.canceled_by_name, 'Owner'); assert.equal(canceledRow.cancel_reason, 'Lançada em dobro');
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

test('saídas do caixa, cancelamento de lançamento e relatório do dia', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, foreignToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    const session = await api('/store/cash/open', { method: 'POST', body: { opening_cents: 5000 } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 10000, payment_method: 'cash' } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 20000, payment_method: 'pix' } }, 201);

    // Saída precisa de categoria ou descrição; sangria não aceita Pix.
    assert.equal((await request('/store/cash/movements', { method: 'POST', body: { kind: 'expense', amount_cents: 100 } })).status, 400);
    assert.equal((await request('/store/cash/movements', { method: 'POST', body: { kind: 'withdrawal', amount_cents: 100, method: 'pix' } })).status, 400);

    await api('/store/cash/movements', { method: 'POST', body: { kind: 'expense', amount_cents: 3000, method: 'cash', category: 'Fornecedor / peças', note: 'Tela A12' } }, 201);
    await api('/store/cash/movements', { method: 'POST', body: { kind: 'expense', amount_cents: 7000, method: 'pix', category: 'Energia' } }, 201);
    const wrong = await api('/store/cash/movements', { method: 'POST', body: { kind: 'expense', amount_cents: 999, method: 'cash', category: 'Outros' } }, 201);
    await api(`/store/cash/movements/${wrong.id}/cancel`, { method: 'POST', body: { reason: 'Valor errado' } });
    await api('/store/cash/movements', { method: 'POST', body: { kind: 'withdrawal', amount_cents: 2000, note: 'Cofre' } }, 201);

    const cash = await api('/store/cash');
    const s = cash.summary;
    assert.equal(s.sales_total_cents, 30000);
    assert.equal(s.expenses_total_cents, 10000, 'saída cancelada não conta');
    assert.equal(s.balance_cents, 20000);
    assert.deepEqual(s.expenses_by_method, { cash: { count: 1, total_cents: 3000 }, pix: { count: 1, total_cents: 7000 } });
    // gaveta: 50 + 100 (venda dinheiro) - 30 (saída dinheiro) - 20 (sangria) = 100
    assert.equal(s.expected_cash_cents, 10000);
    const canceled = cash.movements.find(m => m.id === wrong.id);
    assert.equal(canceled.canceled_by_name, 'Owner'); assert.equal(canceled.cancel_reason, 'Valor errado');

    const closed = await api('/store/cash/close', { method: 'POST', body: { counted_cash_cents: 10000 } });
    assert.equal(closed.difference_cents, 0);
    assert.equal((await request(`/store/cash/movements/${cash.movements[0].id}/cancel`, { method: 'POST', body: { reason: 'tarde' } })).status, 409);

    const report = await api(`/store/cash/sessions/${session.id}/report`);
    assert.equal(report.session.status, 'closed'); assert.equal(report.session.store_name, 'Loja de teste');
    assert.equal(report.summary.balance_cents, 20000); assert.equal(report.sales.length, 2); assert.equal(report.movements.length, 4);
    assert.equal((await request(`/store/cash/sessions/${session.id}/report`, { token: foreignToken })).status, 403, 'outra loja sem o recurso');
    const hist = await api('/store/cash/sessions');
    assert.equal(hist[0].expenses_total_cents, 10000);
  } finally { await f.cleanup(); }
});

test('itens frequentes do caixa', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignToken, masterToken } = f;
    // Recurso do caixa: desligado, as rotas recusam.
    assert.equal((await request('/store/sales/quick-items')).status, 403);
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    assert.deepEqual(await api('/store/sales/quick-items'), []);

    const pel = await api('/store/sales/quick-items', { method: 'POST', body: { label: 'Película 3D', price_cents: 2000 } }, 201);
    await api('/store/sales/quick-items', { method: 'POST', body: { label: 'Conserto' } }, 201);
    // Mesmo nome (sem diferenciar maiúsculas) atualiza o preço em vez de duplicar.
    const again = await api('/store/sales/quick-items', { method: 'POST', body: { label: 'película 3d', price_cents: 2500 } }, 201);
    assert.equal(again.id, pel.id);
    const list = await api('/store/sales/quick-items');
    assert.deepEqual(list.map(i => [i.label, i.price_cents]), [['Conserto', null], ['Película 3D', 2500]]);

    assert.equal((await request('/store/sales/quick-items', { method: 'POST', body: { label: '' } })).status, 400);
    assert.equal((await request('/store/sales/quick-items', { method: 'POST', body: { label: 'X', price_cents: -1 } })).status, 400);

    // Outra loja não vê nem apaga os itens desta.
    await api('/master/tenants/' + f.foreignTenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } }).catch(() => {});
    const foreignList = await request('/store/sales/quick-items', { token: foreignToken });
    assert.ok(foreignList.status === 403 || (foreignList.status === 200 && foreignList.data.length === 0));
    assert.notEqual((await request('/store/sales/quick-items/' + pel.id, { method: 'DELETE', token: foreignToken })).status, 200);

    await api('/store/sales/quick-items/' + pel.id, { method: 'DELETE' });
    assert.deepEqual((await api('/store/sales/quick-items')).map(i => i.label), ['Conserto']);
    assert.equal((await request('/store/sales/quick-items/' + pel.id, { method: 'DELETE' })).status, 404);
  } finally { await f.cleanup(); }
});

test('QR code de atendimento cadastra cliente novo e abre o WhatsApp da loja', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, db, tenant } = f;
    const slug = 'qr-' + tenant.slice(0, 8);
    await db.query('UPDATE tenants SET slug=$1 WHERE id=$2', [slug, tenant]);
    await db.query('INSERT INTO tenant_slugs(slug,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [slug, tenant]);
    const pub = path => '/public/stores/' + slug + path;
    // Sem WhatsApp da loja: a página avisa e o envio é recusado.
    assert.deepEqual(await api(pub('/contact'), { token: null }), { name: 'Loja de teste', logo_url: null, ready: false });
    assert.equal((await request(pub('/contact'), { method: 'POST', token: null, body: { name: 'Maria', phone: '85988887777' } })).status, 409);
    await db.query("UPDATE tenants SET whatsapp='558532130953' WHERE id=$1", [tenant]);

    const r = await api(pub('/contact'), { method: 'POST', token: null, body: { name: 'maria souza', phone: '(85) 98888-7777' } }, 201);
    assert.equal(r.whatsapp_url, 'https://wa.me/558532130953?text=' + encodeURIComponent('Olá! Sou Maria e vim pelo QR code da loja.'));
    let list = await api('/customers');
    assert.equal(list.filter(c => c.source === 'qrcode').length, 1);
    assert.equal(list.find(c => c.source === 'qrcode').phone, '85988887777');

    // Mesmo número de novo (com +55 e sem o 9): não duplica.
    await api(pub('/contact'), { method: 'POST', token: null, body: { name: 'Maria S', phone: '+55 85 8888-7777' } }, 200);
    // Cliente importado só com telefone ganha o nome informado.
    await api('/customers', { method: 'POST', body: { name: '(85) 97777-1111', phone: '85977771111' } }, 201);
    await api(pub('/contact'), { method: 'POST', token: null, body: { name: 'João Lima', phone: '85977771111' } }, 200);
    list = await api('/customers');
    assert.equal(list.filter(c => c.source === 'qrcode').length, 1);
    assert.ok(list.some(c => c.name === 'João Lima' && c.phone === '85977771111'));

    assert.equal((await request(pub('/contact'), { method: 'POST', token: null, body: { name: 'X', phone: '123' } })).status, 400);
    // Nome sem letras ou WhatsApp sem DDD válido não passam (a tela também trava o botão).
    // (a rota aceita 8 envios por 10 min; por isso só dois casos aqui)
    for (const body of [{ name: '1234', phone: '85988887777' }, { name: 'Maria', phone: '00988887777' }])
      assert.equal((await request(pub('/contact'), { method: 'POST', token: null, body })).status, 400, JSON.stringify(body));
    assert.equal((await request('/public/stores/nao-existe/contact', { token: null })).status, 404);

    // Painel: link, prévia e mensagem personalizada.
    const qr = await api('/store/qr');
    assert.match(qr.url, new RegExp('/' + slug + '/oi$'));
    assert.equal(qr.new_last_24h, 1);
    await api('/store/qr', { method: 'PATCH', body: { qr_message: 'Oi, sou {nome}! Quero imprimir na {loja}.' } });
    const r2 = await api(pub('/contact'), { method: 'POST', token: null, body: { name: 'Ana', phone: '85966665555' } }, 201);
    assert.ok(r2.whatsapp_url.endsWith(encodeURIComponent('Oi, sou Ana! Quero imprimir na Loja de teste.')));

    const svg = await fetch(f.base + '/api' + pub('/qr.svg'));
    assert.equal(svg.status, 200); assert.match(svg.headers.get('content-type'), /svg/);
    const page = await fetch(f.base + '/' + slug + '/oi');
    assert.equal(page.status, 200); assert.match(await page.text(), /Fale com a loja/);
  } finally { await f.cleanup(); }
});
