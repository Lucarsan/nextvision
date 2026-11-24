import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('mensagens do quiosque: obrigado, avaliação em 2 dias, cashback vencendo, aniversário, campanha e regras da rede', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, foreignTenant, masterToken, ownerToken, foreignToken, db } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'aud-msg', hostname: 'aud-msg.example.test' } }, 201);
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Grand Shopping' } });
    await api(`/master/tenants/${foreignTenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Benfica' } });
    for (const t of [tenant, foreignTenant]) await api('/master/tenants/' + t, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Dani', email: 'dani@aud-msg.test', function: 'supervisor', unit_ids: [tenant], password: 'senha-da-dani-123', pin: '5555' } }, 201);
    const sup = (await request('/auth/login', { method: 'POST', token: null, body: { email: 'dani@aud-msg.test', password: 'senha-da-dani-123' } })).data.token;

    // Supervisor muda a regra do cashback: vale para as duas unidades.
    await api('/network/settings/cashback', { method: 'PUT', token: sup, body: { enabled: true, percent: 10, max_use_percent: 100, valid_days: 90, min_sale_cents: 0 } });
    assert.equal((await db.query('SELECT count(*)::int n FROM tenants WHERE network_id=$1 AND cashback_enabled AND cashback_percent=10', [net.id])).rows[0].n, 2);
    // Contato: supervisor só nas unidades dele.
    assert.equal((await request(`/network/units/${foreignTenant}/contact`, { method: 'PUT', token: sup, body: { whatsapp: '85999990000', google_review_url: '', opening_hours: '' } })).status, 403);
    await api(`/network/units/${tenant}/contact`, { method: 'PUT', token: sup, body: { whatsapp: '(85) 99172-8887', google_review_url: 'https://g.page/r/abc/review', opening_hours: 'Seg a sáb, 10h às 22h' } });
    const pub = await api('/public/stores/aud-msg', { token: null });
    assert.deepEqual(pub.stores.map(s => [s.name, s.whatsapp]), [['Benfica', null], ['Grand Shopping', '5585991728887']]);

    // Venda com cliente nova → "obrigado" na fila, com cashback, comprovante e link das lojas.
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const sale = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Maria Souza', phone: '85988887777' }, total_cents: 20000, payment_method: 'pix' } }, 201);
    let qd = await api('/store/kiosk/messages');
    const th = qd.items.find(x => x.type === 'thanks');
    assert.ok(th); assert.equal(th.name, 'Maria Souza'); assert.match(th.text, /Olá, Maria!/); assert.match(th.text, /R\$\s?20,00 de cashback/); assert.match(th.text, /\/nossas-lojas\/aud-msg/);
    assert.equal(qd.review_link_missing, false);
    // Outra unidade não vê; enviar tira da fila.
    assert.equal((await api('/store/kiosk/messages', { token: foreignToken })).items.length, 0);
    await api('/store/kiosk/messages/log', { method: 'POST', body: { type: 'thanks', customer_id: th.customer_id, sale_id: th.sale_id } }, 201);
    assert.equal((await api('/store/kiosk/messages')).items.filter(x => x.type === 'thanks').length, 0);

    // Avaliação: aparece 2 dias depois (não antes) e conta como enviada com link.
    assert.equal((await api('/store/kiosk/messages')).items.filter(x => x.type === 'review').length, 0);
    const saleId = sale.id || sale.sale?.id;
    await db.query("UPDATE sales SET created_at=now()-interval '2 days' WHERE id=$1", [saleId]);
    qd = await api('/store/kiosk/messages');
    const rv = qd.items.find(x => x.type === 'review'); assert.ok(rv); assert.match(rv.text, /\/a\/[0-9a-f]{10}/);
    await api('/store/kiosk/messages/log', { method: 'POST', body: { type: 'review', customer_id: rv.customer_id } }, 201);
    assert.equal((await api('/store/kiosk/messages')).items.filter(x => x.type === 'review').length, 0);
    assert.equal((await db.query("SELECT count(*)::int n FROM customer_messages WHERE campaign='review' AND review_link")).rows[0].n, 1);

    // Cashback vencendo em 3 dias.
    await db.query("UPDATE cashback_lots SET expires_on=(now() AT TIME ZONE 'America/Fortaleza')::date + 3 WHERE customer_id=$1", [rv.customer_id]);
    qd = await api('/store/kiosk/messages'); const ex = qd.items.find(x => x.type === 'expiring');
    assert.ok(ex); assert.match(ex.text, /R\$\s?20,00 de cashback/);
    // Aniversário hoje; quem não quer ofertas fica de fora.
    await db.query("UPDATE customers SET birth_date=((now() AT TIME ZONE 'America/Fortaleza')::date - interval '30 years')::date WHERE id=$1", [rv.customer_id]);
    assert.ok((await api('/store/kiosk/messages')).items.find(x => x.type === 'birthday'));
    // Campanha da rede para todas: aparece na unidade da última compra; "não enviar" tira da fila.
    const day = (await db.query("SELECT to_char(now() AT TIME ZONE 'America/Fortaleza','YYYY-MM-DD') d")).rows[0].d;
    const cp = await api('/network/campaigns', { method: 'POST', token: sup, body: { title: 'Black Friday', body: 'Oi {nome}, Black Friday na Audace! Seu saldo: {saldo}', audience: 'all', starts_on: day, ends_on: day } }, 201);
    qd = await api('/store/kiosk/messages'); const c1 = qd.items.find(x => x.type === 'campaign');
    assert.ok(c1); assert.equal(c1.campaign, 'net:' + cp.id); assert.match(c1.text, /Oi Maria, Black Friday/);
    await db.query('UPDATE customers SET offers_opt_out=true WHERE id=$1', [rv.customer_id]);
    qd = await api('/store/kiosk/messages'); assert.equal(qd.items.filter(x => ['campaign', 'birthday'].includes(x.type)).length, 0);
    await db.query('UPDATE customers SET offers_opt_out=false WHERE id=$1', [rv.customer_id]);
    await api('/store/kiosk/messages/log', { method: 'POST', body: { type: 'campaign', customer_id: c1.customer_id, campaign: c1.campaign, skip: true } }, 201);
    assert.equal((await api('/store/kiosk/messages')).items.filter(x => x.type === 'campaign').length, 0);
    // Regras das mensagens: desligar aniversário.
    const st = await api('/network/settings', { token: sup });
    await api('/network/settings/messages', { method: 'PUT', token: sup, body: { ...st.messages, birthday_enabled: false } });
    assert.equal((await api('/store/kiosk/messages')).items.filter(x => x.type === 'birthday').length, 0);
    // Relatório do mês.
    const month = day.slice(0, 7);
    const sm = await api('/network/messages/summary?month=' + month, { token: sup });
    assert.deepEqual(sm.map(x => [x.unit, x.thanks, x.review]), [['Grand Shopping', 1, 1]]);
    assert.equal((await request('/store/kiosk/messages/log', { method: 'POST', token: foreignToken, body: { type: 'review', customer_id: rv.customer_id } })).status, 404);
  } finally { await f.cleanup(); }
});
