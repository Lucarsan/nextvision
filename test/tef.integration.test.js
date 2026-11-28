import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';
const hostPost = (base, path, host, body) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: host, 'Content-Type': 'application/json' } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(b || '{}') }));
  });
  r.on('error', reject); r.write(JSON.stringify(body)); r.end();
});
// Respostas do Slim (formato da documentação do AutoTEF).
const cardOk = (atk, extra = {}) => ({ acquirerTransactionKey: atk, authorisationCode: '130192', brandName: 'MASTER CREDITO ', maskedPrimaryAccountNumber: '************1234',
  merchantDocument: '46.383.376/0001-23', stoneCode: '123123123', messageDisplay: 'Aprovado', clientVia: 'VIA CLIENTE', merchantVia: 'VIA LOJA', ...extra });

test('TEF Stone: cobrança registrada antes do pinpad, venda só com aprovação, estorno e pendências', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, base, db } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace', hostname: 'audace.example.test' } }, 201);
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Grand Shopping' } });
    await db.query("UPDATE tenants SET cnpj='46383376000123' WHERE id=$1", [tenant]);
    await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-grand' } });
    const ana = await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Ana Paula', function: 'vendedora', unit_id: tenant, pin: '1234' } }, 201);
    await api(`/master/networks/${net.id}/people`, { method: 'POST', token: masterToken, body: { name: 'Gabriel Mota', email: 'gabriel@audace.test', function: 'dono', password: 'senha-do-gabriel-1', pin: '9999' } }, 201);
    const kt = (await hostPost(base, '/api/auth/unit', 'audace.example.test', { unit_id: tenant, password: 'senha-grand' })).data.token;
    await api('/store/cash/open', { method: 'POST', token: kt, body: { opening_cents: 0, seller_id: ana.id, seller_pin: '1234' } }, 201);
    const prod = (await db.query("INSERT INTO products(tenant_id, name, barcode, price_cents, stock_qty, ncm) VALUES($1, 'Corrente Aço Elo P', '003622', 4900, 9, '71171900') RETURNING id", [tenant])).rows[0].id;
    const sale = extra => request('/store/sales', { method: 'POST', token: kt, body: { items: [{ product_id: prod, quantity: 1 }], anonymous: true, seller_id: ana.id, seller_pin: '1234', ...extra } });
    const tx = body => api('/store/tef/transactions', { method: 'POST', token: kt, body }, 201);
    const result = (id, body) => request(`/store/tef/transactions/${id}/result`, { method: 'POST', token: kt, body });

    // Desligado: o caixa segue como hoje e não dá para registrar cobrança.
    assert.equal((await api('/store/tef/config', { token: kt })).mode, 'off');
    assert.equal((await request('/store/tef/transactions', { method: 'POST', token: kt, body: { method: 'credit', amount_cents: 4900 } })).status, 409);
    assert.equal((await sale({ payment_method: 'credit' })).status, 201, 'sem TEF a venda no cartão grava como antes');

    // Central: sandbox/produção exigem Stone Code; porta e endereço validados.
    assert.equal((await request(`/master/tenants/${tenant}/tef`, { method: 'PATCH', token: masterToken, body: { mode: 'sandbox' } })).status, 400);
    assert.equal((await request(`/master/tenants/${tenant}/tef`, { method: 'PATCH', token: masterToken, body: { local_url: 'http://evil.example:8000' } })).status, 400);
    assert.equal((await request(`/master/tenants/${tenant}/tef`, { method: 'PATCH', token: kt, body: { mode: 'simulator' } })).status, 403);
    const cfg = await api(`/master/tenants/${tenant}/tef`, { method: 'PATCH', token: masterToken, body: { mode: 'sandbox', stone_code: '684250012', pinpad_port: 'com4' } });
    assert.deepEqual(cfg, { mode: 'sandbox', stone_code: '684250012', pinpad_port: 'COM4', local_url: null });
    const c = await api('/store/tef/config', { token: kt });
    assert.equal(c.mode, 'sandbox'); assert.equal(c.local_url, 'http://127.0.0.1:8000'); assert.equal(c.stone_code, '684250012');

    // Com TEF ligado, o quiosque não grava venda no cartão/Pix sem cobrança do pinpad (ou maquininha avulsa).
    assert.equal((await sale({ payment_method: 'credit' })).status, 400);
    assert.equal((await sale({ payment_method: 'cash' })).status, 201);
    assert.equal((await sale({ payment_method: 'debit', offline_payment: true, offline_auth: 'AUT1' })).status, 201);

    // Cartão aprovado → venda com os dados para a NFC-e.
    const t1 = await tx({ method: 'credit', amount_cents: 4900, installments: 3 });
    assert.equal(t1.status, 'pending'); assert.equal(t1.installments, 3);
    assert.equal((await request('/store/tef/transactions', { method: 'POST', token: kt, body: { method: 'debit', amount_cents: 100 } })).status, 409, 'uma cobrança de cartão por vez');
    assert.equal((await request('/store/tef/transactions', { method: 'POST', token: kt, body: { method: 'debit', amount_cents: 100, installments: 2 } })).status, 400);
    const r1 = await result(t1.id, { kind: 'card', http: 200, body: cardOk('ATK-1'), terminal_serial: '03000398' });
    assert.equal(r1.status, 200); assert.equal(r1.data.status, 'approved'); assert.deepEqual(r1.data.warnings, []);
    assert.equal((await result(t1.id, { kind: 'card', http: 200, body: cardOk('ATK-X') })).status, 409, 'resultado não é trocado depois de finalizado');
    assert.equal((await sale({ payment_method: 'debit', tef_transaction_ids: [t1.id] })).status, 409, 'forma diferente da cobrada');
    const s1 = await sale({ payment_method: 'credit', tef_transaction_ids: [t1.id] });
    assert.equal(s1.status, 201, JSON.stringify(s1.data));
    assert.deepEqual(s1.data.sale.tef, [{ method: 'credit', amount_cents: 4900, acquirer_cnpj: '16501555000157', brand: '02', auth: '130192', terminal_id: '03000398', nsu: 'ATK-1', tef_transaction_id: t1.id }]);
    assert.equal((await sale({ payment_method: 'credit', tef_transaction_ids: [t1.id] })).status, 409, 'a mesma cobrança não paga duas vendas');
    const pv = await api(`/master/sales/${s1.data.sale.id}/nfce-preview`, { token: masterToken });
    const pay = pv.doc.payments[0];
    assert.equal(pay.integration, 1); assert.equal(pay.acquirer_cnpj, '16501555000157'); assert.equal(pay.brand, '02'); assert.equal(pay.auth, '130192'); assert.equal(pay.terminal_id, '03000398');
    assert.ok(!pv.problems.some(p => /TEF|credenciadora|autorização|bandeira|terminal/.test(p)), pv.problems.join('; '));

    // Recusado: não vira venda. Sem resposta: fica pendente ("unknown") e aparece no caixa.
    const t2 = await tx({ method: 'debit', amount_cents: 4900 });
    assert.equal((await result(t2.id, { kind: 'card', http: 400, body: { responseCode: 'DECL', responseReason: '1016', messageDisplay: 'Não autorizada' } })).data.status, 'declined');
    assert.equal((await sale({ payment_method: 'debit', tef_transaction_ids: [t2.id] })).status, 409);
    const t3 = await tx({ method: 'debit', amount_cents: 4900 });
    assert.equal((await result(t3.id, { kind: 'lost' })).data.status, 'unknown');
    // CNPJ do comprovante diferente do da unidade: aprova, mas avisa (Stone Code trocado).
    const t4 = await tx({ method: 'credit', amount_cents: 5000 });
    const r4 = await result(t4.id, { kind: 'card', http: 200, body: cardOk('ATK-4', { merchantDocument: '11.999.222/0001-99' }) });
    assert.equal(r4.data.status, 'approved'); assert.equal(r4.data.warnings.length, 1);
    // Valor diferente da venda: recusa a venda e a cobrança vira estorno pendente.
    const mm = await sale({ payment_method: 'credit', tef_transaction_ids: [t4.id] });
    assert.equal(mm.status, 409); assert.match(mm.data.error, /não bate/);

    await db.query("UPDATE tef_transactions SET created_at=now()-interval '5 minutes' WHERE tenant_id=$1", [tenant]);
    let pend = (await api('/store/tef/pending', { token: kt })).items;
    assert.deepEqual(pend.map(p => [p.id, p.reason]).sort(), [[t3.id, 'no_answer'], [t4.id, 'no_sale']].sort());
    assert.equal((await request(`/store/tef/pending`, { token: f.foreignToken })).status, 403, 'outra loja sem caixa');
    // Estorno: dados para o Slim (ATK, valor em reais, tipo e cartão) e marcação depois do 200 do pinpad.
    const cd = await api(`/store/tef/transactions/${t4.id}/cancel-data`, { token: kt });
    assert.deepEqual(cd.request, { acquirerTransactionKey: 'ATK-4', amount: 50, transactionType: 'credit', panMask: '************1234' });
    assert.equal((await request(`/store/tef/transactions/${t1.id}/reversed`, { method: 'POST', token: kt, body: {} })).status, 409, 'venda ativa não se estorna por aqui');
    assert.equal((await api(`/store/tef/transactions/${t4.id}/reversed`, { method: 'POST', token: kt, body: {} })).status, 'reversed');
    // Sem resposta: resolvido à mão depois de conferir no app da Stone.
    assert.equal((await request(`/store/tef/transactions/${t3.id}/resolve`, { method: 'POST', token: kt, body: { note: 'x' } })).status, 400);
    await api(`/store/tef/transactions/${t3.id}/resolve`, { method: 'POST', token: kt, body: { note: 'Não passou no app da Stone' } });
    assert.equal((await api('/store/tef/pending', { token: kt })).items.length, 0);

    // Cancelar venda paga no pinpad: a resposta diz o que estornar e a cobrança aparece nas pendências até estornar.
    const cx = await api(`/store/sales/${s1.data.sale.id}/cancel`, { method: 'POST', token: kt, body: { reason: 'Cliente desistiu', seller_pin: '1234' } });
    assert.deepEqual(cx.tef_to_reverse, [{ id: t1.id, method: 'credit', amount_cents: 4900 }]);
    pend = (await api('/store/tef/pending', { token: kt })).items;
    assert.deepEqual(pend.map(p => [p.id, p.reason, p.sale_number]), [[t1.id, 'sale_canceled', s1.data.sale.sale_number]]);
    await api(`/store/tef/transactions/${t1.id}/reversed`, { method: 'POST', token: kt, body: { body: { receipt: { acquirerTransactionKey: 'EST-777', transactionDateTime: '2026-11-28T13:00:00', clientVia: 'VIA ESTORNO' } } } });
    const rv = await api(`/store/tef/transactions/${t1.id}/receipt`, { token: kt });
    assert.equal(rv.reversal.atk, 'EST-777', 'comprovante mostra o ATK do estorno'); assert.equal(rv.reversal.receipt, 'VIA ESTORNO');
    assert.equal((await db.query('SELECT reversal_response FROM tef_transactions WHERE id=$1', [t1.id])).rows[0].reversal_response.receipt.clientVia, undefined, 'via não vai para o jsonb');

    // Pix: QR criado → pago (endToEndId) → venda com Pix dinâmico; expirado não vira venda.
    const p1 = await tx({ method: 'pix', amount_cents: 4900 });
    assert.equal((await result(p1.id, { kind: 'pix_status', http: 200, body: { responseCode: '0000' } })).status, 400, 'status antes do QR');
    assert.equal((await result(p1.id, { kind: 'pix_created', http: 200, body: { transactionId: 'PIX-1', responseCode: '0000', wasSuccessfull: true, qrCodeImage: 'AAAA' } })).data.status, 'pending');
    assert.equal((await result(p1.id, { kind: 'lost' })).data.status, 'pending', 'Pix com QR continua aguardando');
    const pp = await result(p1.id, { kind: 'pix_status', http: 200, body: { responseCode: '0000', wasSuccessfull: true, endTwoEndIdentification: ['E1823612020251125'], receipt: { merchantDocument: '46.383.376/0001-23', stoneCode: '684250012' } } });
    assert.equal(pp.data.status, 'approved'); assert.equal(pp.data.e2e_id, 'E1823612020251125');
    const raw = (await db.query('SELECT response FROM tef_transactions WHERE id=$1', [p1.id])).rows[0].response;
    assert.equal(JSON.stringify(raw).includes('qrCodeImage'), false, 'imagem do QR não fica no banco');
    const sp = await sale({ payment_method: 'pix', tef_transaction_ids: [p1.id] });
    assert.equal(sp.status, 201); assert.equal(sp.data.sale.tef[0].auth, 'E1823612020251125');
    assert.equal((await request(`/store/tef/transactions/${p1.id}/cancel-data`, { token: kt })).status, 409, 'Pix se devolve pelo app');
    const p2 = await tx({ method: 'pix', amount_cents: 4900 });
    await result(p2.id, { kind: 'pix_created', http: 200, body: { transactionId: 'PIX-2', wasSuccessfull: true } });
    assert.equal((await result(p2.id, { kind: 'pix_status', http: 400, body: { responseCode: 'C207', responseReason: 'expired' } })).data.status, 'expired');

    // Simulador: o fluxo funciona, mas a NFC-e recusa (pagamento de mentira).
    await api(`/master/tenants/${tenant}/tef`, { method: 'PATCH', token: masterToken, body: { mode: 'simulator' } });
    const ts = await tx({ method: 'credit', amount_cents: 4900 });
    assert.equal(ts.mode, 'simulator');
    await result(ts.id, { kind: 'card', http: 200, body: cardOk('SIM-1') });
    const ss = await sale({ payment_method: 'credit', tef_transaction_ids: [ts.id] });
    assert.equal(ss.data.sale.tef[0].simulated, true);
    const pvs = await api(`/master/sales/${ss.data.sale.id}/nfce-preview`, { token: masterToken });
    assert.ok(pvs.problems.some(p => /simulado/.test(p)));

    // Isolamento: outra loja não vê nem mexe nas cobranças desta.
    assert.equal((await request(`/store/tef/transactions/${ts.id}/cancel-data`, { token: f.foreignToken })).status, 403);
  } finally { await f.cleanup(); }
});
