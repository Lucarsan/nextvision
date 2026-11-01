import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createStoreFixture } from './helpers/store-fixture.js';

const id = () => crypto.randomUUID();
const localDay = (offset = 0) => { const d = new Date(Date.now() + offset * 86400000); const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };

test('medição do acompanhamento, números da central e relatórios para os lojistas', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 90000
}, async () => {
  const f = await createStoreFixture();
  const { api, request, db, base } = f;
  const post = (path, body) => fetch(base + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // Para respostas 204 (sem corpo): devolve só o status.
  const call = async (path, { method = 'POST', body, token = f.ownerToken } = {}) => (await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined })).status;
  try {
    const proc = await api('/processes', { method: 'POST', body: { name: 'Reparo', steps: ['Bancada'] } }, 201);
    const o1 = await api('/orders/quick', { method: 'POST', body: { reference: 'A1', process_id: proc.id } }, 201);
    const o2 = await api('/orders/quick', { method: 'POST', body: { reference: 'A2', process_id: proc.id } }, 201);
    await api('/orders/quick', { method: 'POST', body: { reference: 'A3', process_id: proc.id } }, 201);
    const t1 = o1.tracking_url.split('/p/')[1], t2 = o2.tracking_url.split('/p/')[1];

    // Cliente abre o link 1 duas vezes no mesmo celular (retorno) e a mãe abre uma vez.
    const phone = id(), mom = id(), v1 = id(), v2 = id(), v3 = id();
    assert.equal((await post('/public/orders/' + t1 + '/visit', { visit: v1, visitor: phone, visible: 0, live: 0, device: 'mobile', source: 'whatsapp' })).status, 204);
    assert.equal((await post('/public/orders/' + t1 + '/visit', { visit: v1, visitor: phone, visible: 30, live: 20, device: 'mobile' })).status, 204);
    // Batimento atrasado com valor menor não diminui; valor absurdo é limitado ao tempo real (+60 s).
    await post('/public/orders/' + t1 + '/visit', { visit: v1, visitor: phone, visible: 10, live: 5 });
    await post('/public/orders/' + t1 + '/visit', { visit: v1, visitor: phone, visible: 86000, live: 86000 });
    let row = (await db.query('SELECT visible_seconds, live_seconds, device, source FROM link_visits WHERE id=$1', [v1])).rows[0];
    assert.ok(row.visible_seconds >= 30 && row.visible_seconds <= 70, 'limitado ao tempo real: ' + row.visible_seconds);
    assert.equal(row.device, 'mobile'); assert.equal(row.source, 'whatsapp');
    await db.query('UPDATE link_visits SET visible_seconds=40, live_seconds=20 WHERE id=$1', [v1]);
    await post('/public/orders/' + t1 + '/visit', { visit: v2, visitor: phone, visible: 20, live: 0, device: 'mobile' });
    await post('/public/orders/' + t1 + '/visit', { visit: v3, visitor: mom, visible: 0, live: 0, device: 'desktop' });
    // Mesmo id de visita em outro pedido não sequestra a visita.
    await post('/public/orders/' + t2 + '/visit', { visit: v1, visitor: phone, visible: 50, live: 50 });
    assert.equal((await db.query('SELECT order_id FROM link_visits WHERE id=$1', [v1])).rows[0].order_id, o1.id);
    // Entrada inválida e link inexistente.
    assert.equal((await post('/public/orders/' + t1 + '/visit', { visit: 'x', visitor: phone, visible: 0, live: 0 })).status, 400);
    assert.equal((await post('/public/orders/' + 'z'.repeat(24) + '/visit', { visit: id(), visitor: phone, visible: 0, live: 0 })).status, 204);
    assert.equal((await db.query("SELECT count(*)::int n FROM link_visits")).rows[0].n, 3);
    // Ação do cliente: conversar com a loja.
    assert.equal((await post('/public/orders/' + t1 + '/event', { kind: 'talk_store', visitor: phone })).status, 204);
    assert.equal((await post('/public/orders/' + t1 + '/event', { kind: 'link_sent' })).status, 400, 'cliente não registra envio');

    // Loja: enviou pelo WhatsApp (link curto) e copiou (link /p/).
    const slug = 'loja-medida-' + crypto.randomBytes(3).toString('hex');
    await db.query('INSERT INTO tenant_slugs(slug, tenant_id) VALUES($1,$2)', [slug, f.tenant]);
    const n1 = (await db.query('SELECT order_number FROM orders WHERE id=$1', [o1.id])).rows[0].order_number;
    assert.equal(await call('/store/link-shares', { body: { link: 'https://ficoupronto.com/' + slug + '/' + n1, channel: 'whatsapp' } }), 204);
    assert.equal(await call('/store/link-shares', { body: { link: o2.tracking_url, channel: 'copy' } }), 204);
    // Outra loja não registra envio de pedido alheio.
    assert.equal(await call('/store/link-shares', { token: f.foreignToken, body: { link: o2.tracking_url, channel: 'whatsapp' } }), 404);
    assert.equal(await call('/store/link-shares', { body: { link: 'https://exemplo.com/qualquer', channel: 'whatsapp' } }), 404);

    // Painel da loja: o pedido mostra quantas vezes foi aberto.
    const orders = await api('/orders');
    const mine = orders.find(o => o.id === o1.id);
    assert.equal(mine.link_opens, 3); assert.equal(mine.link_people, 2);

    // Central: números do período.
    const today = localDay(), d = await api('/master/analytics?from=' + localDay(-1) + '&to=' + today, { token: f.masterToken });
    assert.equal(d.totals.links, 3); assert.equal(d.totals.opens, 3); assert.equal(d.totals.people, 2);
    assert.equal(d.totals.links_opened, 1); assert.equal(d.totals.open_rate, 33);
    assert.equal(d.totals.returns, 1, 'o mesmo celular abriu duas vezes');
    assert.equal(d.totals.sent, 1); assert.equal(d.totals.copied, 1); assert.equal(d.totals.talks, 1);
    assert.equal(d.totals.live_seconds, 20); assert.equal(d.totals.avg_visible_seconds, 20);
    assert.equal(d.days.length, 2); assert.equal(d.days.at(-1).opens, 3);
    const store = d.stores.find(s => s.tenant_id === f.tenant);
    assert.equal(store.opens, 3); assert.equal(d.public_stats_enabled, false);
    assert.equal((await request('/master/analytics', { token: f.ownerToken })).status, 403);
    assert.equal((await request('/master/analytics?from=2020-01-01&to=2026-01-01', { token: f.masterToken })).status, 400);

    // CSV por loja e por pedido.
    for (const group of ['store', 'day', 'order']) {
      const r = await fetch(base + '/api/master/analytics.csv?group=' + group + '&from=' + today + '&to=' + today, { headers: { Authorization: 'Bearer ' + f.masterToken } });
      assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/csv/);
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM para abrir acentuado no Excel');
      const text = bytes.toString('utf8');
      if (group === 'order') assert.match(text, /A1;/);
    }

    // Número público: desligado → 404; ligado → só totais.
    assert.equal((await fetch(base + '/api/public/stats')).status, 404);
    await api('/master/analytics/settings', { method: 'PATCH', token: f.masterToken, body: { public_stats_enabled: true } });
    const pub = await (await fetch(base + '/api/public/stats')).json();
    assert.ok(pub.opens >= 3 && pub.links >= 3); assert.deepEqual(Object.keys(pub).sort(), ['links', 'live_hours', 'opens', 'people', 'stores', 'updated_at']);

    // Relatórios para os lojistas: programação diária, mensagem com os números de ontem.
    await db.query("UPDATE link_visits SET started_at=started_at-interval '1 day'");
    await db.query("UPDATE orders SET created_at=created_at-interval '1 day' WHERE tenant_id=$1", [f.tenant]);
    await db.query("UPDATE tenants SET whatsapp='5585999990000' WHERE id=$1", [f.tenant]);
    await api('/master/tenants/' + f.tenant + '/results-report', { method: 'PATCH', token: f.masterToken, body: { results_report: 'daily' } });
    await api('/master/tenants/' + f.foreignTenant + '/results-report', { method: 'PATCH', token: f.masterToken, body: { results_report: 'off' } });
    let rep = await api('/master/results-reports?date=' + today, { token: f.masterToken });
    const due = rep.due.find(r => r.tenant_id === f.tenant);
    assert.ok(due, 'loja diária aparece hoje'); assert.equal(rep.due.some(r => r.tenant_id === f.foreignTenant), false);
    assert.match(due.message, /3 pedidos com link/); assert.match(due.message, /3 aberturas por 2 pessoas\n/); assert.match(due.message, /33% dos links foram abertos/);
    assert.match(due.message, /1 clientes voltaram/); assert.equal(due.whatsapp, '5585999990000'); assert.equal(due.sent, null);
    assert.equal(await call('/master/results-reports/sent', { token: f.masterToken, body: { tenant_id: f.tenant, period_key: due.period.key } }), 204);
    rep = await api('/master/results-reports?date=' + today, { token: f.masterToken });
    assert.ok(rep.due.find(r => r.tenant_id === f.tenant).sent, 'marcado como enviado');
    // Modelo editado vale para a mensagem; nulo volta ao padrão.
    await api('/master/analytics/settings', { method: 'PATCH', token: f.masterToken, body: { store_report_template: 'Oi {loja}: {aberturas} aberturas em {periodo}. {campo_inexistente}' } });
    const prev = await api('/master/results-reports/preview?tenant=' + f.tenant + '&kind=daily', { token: f.masterToken });
    assert.match(prev.message, /^Oi Loja de teste: 3 aberturas em \d{2}\/\d{2}\/\d{4}\. \{campo_inexistente\}$/);
    await api('/master/analytics/settings', { method: 'PATCH', token: f.masterToken, body: { store_report_template: null } });
    // Sem pedidos novos no período, a linha da taxa some (em vez de "— dos links").
    const { fillTemplate, DEFAULT_TEMPLATE } = await import('../src/link-analytics.js');
    const empty = fillTemplate(DEFAULT_TEMPLATE, { name: 'X', links: 0, links_opened: 0, opens: 2, people: 2, returns: 0, avg_visible_seconds: 48, live_seconds: 30 }, { title: 'ontem' });
    assert.doesNotMatch(empty, /dos links foram abertos|—/); assert.match(empty, /2 aberturas por 2 pessoas/);
    assert.match((await api('/master/results-reports/preview?tenant=' + f.tenant + '&kind=weekly', { token: f.masterToken })).message, /Seus resultados no Ficou Pronto/);
    // Semanal só no dia escolhido.
    const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
    await api('/master/tenants/' + f.tenant + '/results-report', { method: 'PATCH', token: f.masterToken, body: { results_report: 'weekly', results_report_weekday: (weekday + 1) % 7 } });
    assert.equal((await api('/master/results-reports?date=' + today, { token: f.masterToken })).due.length, 0);
    assert.equal((await request('/master/results-reports', { token: f.ownerToken })).status, 403);

    // E-mail da loja ganha a seção de acompanhamento.
    const { reportHtml } = await import('../src/reports.js');
    const { linkStats } = await import('../src/link-analytics.js');
    const qq = (text, params) => db.query(text, params);
    const eng = (await linkStats(qq, { from: localDay(-1), to: today, tenantId: f.tenant })).stores[0];
    assert.equal(eng.opens, 3);
    const html = reportHtml({ kind: 'daily', day: localDay(-1), period: { title: 'ontem' }, store: { name: 'Loja' }, timezone: 'America/Fortaleza', engagement: eng,
      sales: [], sales_total: 0, discounts: 0, by_method: {}, by_seller: [], by_day: [], canceled: { n: 0, total: 0 }, items: [], items_total: 0, items_cost: 0, cost_known: true,
      typed: { n: 0, total: 0 }, expenses: [], expenses_total: 0, expenses_by_category: [], moves: {}, purchases: [], purchases_total: 0, services: [], services_total: 0,
      by_supplier: [], new_products: [], new_customers: { n: 0, qr: 0 }, sessions: [], restock: [], balance: 0 });
    assert.match(html, /Acompanhamento dos clientes/); assert.match(html, /Aberturas do link/);
  } finally { await f.cleanup(); }
});
