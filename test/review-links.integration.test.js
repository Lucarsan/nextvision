import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createStoreFixture } from './helpers/store-fixture.js';

const id = () => crypto.randomUUID();
const localDay = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };

// Avaliações do Google: link /a/<código> por cliente na mensagem, clique medido, relatório da central.
test('link de avaliação medido: mensagem, cópia, página do pedido e relatório da central', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 120000
}, async () => {
  const f = await createStoreFixture();
  const { api, db, base } = f;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    await api('/store/sales/config', { method: 'PATCH', body: { google_review_url: 'https://g.page/r/teste/review' } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const sale = async (name, phone) => (await api('/store/sales', { method: 'POST', body: { new_customer: { name, phone }, total_cents: 1000, payment_method: 'pix' } }, 201)).customer;

    const ana = await sale('Ana Avalia', '85999990001'), bia = await sale('Bia Copia', '85999990002'), caio = await sale('Caio Nunca', '85999990003');
    assert.match(ana.review_code, /^[0-9a-f]{10}$/, 'a venda devolve o código do cliente (botão "Enviar status" logo após a venda)');
    const cfg = await api('/store/sales/config');
    assert.ok('review_link_base' in cfg && cfg.review_link_base.endsWith('/a/'));
    const st = await api('/store/messages/status');
    assert.equal(st.customers.find(c => c.id === bia.id).review_code, bia.review_code);

    // Ana: "Enviar" pelo WhatsApp; Bia: copiou e clicou "Já enviei" (mesmo registro); Caio: mensagem sem o link.
    await api('/store/messages/sent', { method: 'POST', body: { customer_id: ana.id, kind: 'status', review: true } }, 201);
    await api('/store/messages/sent', { method: 'POST', body: { customer_id: bia.id, kind: 'status', review: true } }, 201);
    await api('/store/messages/sent', { method: 'POST', body: { customer_id: caio.id, kind: 'status' } }, 201);
    // Oferta não vira "com link de avaliação".
    await api('/store/messages/sent', { method: 'POST', body: { customer_id: caio.id, kind: 'offer', campaign: 'x', review: true } }, 201);
    assert.equal((await db.query('SELECT count(*)::int n FROM customer_messages WHERE review_link')).rows[0].n, 2);

    // Página /a/<código>: redireciona para o Google pelo navegador e tem prévia com o nome da loja.
    let r = await fetch(base + '/a/' + ana.review_code, { redirect: 'manual' });
    assert.equal(r.status, 200); const html = await r.text();
    assert.match(html, /g\.page\/r\/teste\/review/); assert.match(html, /og:title" content="Avalie Loja de teste no Google"/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(base + '/a/0000000000')).status, 404);
    assert.equal((await fetch(base + '/a/xyz')).status, 404);
    // A prévia do WhatsApp só baixa o HTML: sem o JavaScript, nada é contado.
    assert.equal((await db.query('SELECT count(*)::int n FROM review_clicks')).rows[0].n, 0);

    // Cliques: Ana abre (2× seguidas no mesmo celular conta 1), Bia abre no celular dela.
    const anaPhone = id(), biaPhone = id(), staffPc = id(), tablet = id();
    assert.equal((await post('/api/public/review/' + ana.review_code + '/click', { visitor: anaPhone })).status, 204);
    await post('/api/public/review/' + ana.review_code + '/click', { visitor: anaPhone });
    await post('/api/public/review/' + bia.review_code + '/click', { visitor: biaPhone });
    // Equipe testando o link (navegador do painel) e um tablet que abriu links de clientes diferentes: fora da conta.
    await post('/api/public/review/' + caio.review_code + '/click', { visitor: staffPc, staff: true });
    await post('/api/public/review/' + ana.review_code + '/click', { visitor: tablet });
    await post('/api/public/review/' + caio.review_code + '/click', { visitor: tablet });
    assert.equal((await post('/api/public/review/' + ana.review_code + '/click', { visitor: 'x' })).status, 400);
    assert.equal((await db.query('SELECT count(*)::int n FROM review_clicks')).rows[0].n, 5);
    assert.equal((await db.query('SELECT count(*)::int n FROM review_client_clicks')).rows[0].n, 2);

    // Botão "Avaliar no Google" da página do pedido.
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Banho'] } }, 201);
    const order = await api('/orders/quick', { method: 'POST', body: { reference: 'R1', process_id: proc.id } }, 201);
    const tok = order.tracking_url.split('/p/')[1];
    assert.equal((await post('/api/public/orders/' + tok + '/review-click', { visitor: id() })).status, 204);
    assert.equal((await post('/api/public/orders/' + 'z'.repeat(20) + '/review-click', { visitor: id() })).status, 204);

    // Loja sem link do Google: /a/ não abre.
    await api('/store/sales/config', { method: 'PATCH', body: { google_review_url: '' } });
    assert.equal((await fetch(base + '/a/' + ana.review_code)).status, 404);

    // Central: números e lista por cliente.
    const day = localDay();
    const d = await api('/master/analytics/orders?from=' + day + '&to=' + day + '&tenant=' + f.tenant, { token: f.masterToken });
    const t = d.totals;
    assert.equal(t.review_sent, 2); assert.equal(t.review_sent_customers, 2);
    assert.equal(t.review_clicked, 2); assert.equal(t.review_clicked_of_sent, 2); assert.equal(t.review_rate, 100);
    assert.equal(t.review_clicks, 2); assert.equal(t.review_page_clicks, 1); assert.equal(t.review_staff_clicks, 3); assert.equal(t.review_confirmed, 0);
    const rowAna = d.reviews.find(x => x.customer_id === ana.id);
    assert.equal(rowAna.clicks, 1); assert.ok(rowAna.first_sent && rowAna.first_click);
    assert.equal(d.reviews.find(x => x.customer_id === caio.id), undefined, 'Caio: mensagem sem link e só cliques da equipe');

    // Marcar que a Ana avaliou (conferido no Google); outra loja não vê nada disso.
    const c = await api('/master/customers/' + ana.id + '/review-confirmed', { method: 'PATCH', token: f.masterToken, body: { confirmed: true } });
    assert.ok(c.review_confirmed_at);
    assert.equal((await f.request('/master/customers/' + ana.id + '/review-confirmed', { method: 'PATCH', token: f.ownerToken, body: { confirmed: true } })).status, 403);
    const n = await api('/master/analytics?from=' + day + '&to=' + day, { token: f.masterToken });
    assert.equal(n.totals.review_confirmed, 1);
    assert.equal(n.stores.find(s => s.tenant_id === f.foreignTenant).review_sent, 0);

    // CSV por cliente e linha no relatório para o lojista.
    const csv = await (await fetch(base + '/api/master/analytics.csv?group=review&from=' + day + '&to=' + day, { headers: { Authorization: 'Bearer ' + f.masterToken } })).text();
    assert.match(csv, /Ana Avalia/); assert.match(csv, /Avaliação confirmada em/);
    const prev = await api('/master/results-reports/preview?tenant=' + f.tenant + '&kind=daily', { token: f.masterToken });
    assert.ok(!/avaliar no Google/.test(prev.message), 'ontem sem envio: a linha de avaliação sai da mensagem');
    const { fillTemplate, DEFAULT_TEMPLATE } = await import('../src/link-analytics.js');
    assert.match(fillTemplate(DEFAULT_TEMPLATE, { ...n.stores.find(s => s.tenant_id === f.tenant), name: 'Loja' }, { title: 'hoje' }), /• 2 clientes abriram o link para avaliar no Google/);

    // Desmarcar.
    await api('/master/customers/' + ana.id + '/review-confirmed', { method: 'PATCH', token: f.masterToken, body: { confirmed: false } });
    assert.equal((await db.query('SELECT review_confirmed_at FROM customers WHERE id=$1', [ana.id])).rows[0].review_confirmed_at, null);
  } finally { await f.cleanup(); }
});
