import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createStoreFixture } from './helpers/store-fixture.js';

// Cancelar venda com NFC-e: até 30 minutos cancela o cupom na ACBr junto; depois, a venda não se cancela
// (troca ou devolução). Recusa da SEFAZ ou falta de resposta: a venda continua valendo.
const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

async function fakeAcbr() {
  const seen = []; const state = { mode: 'ok' };
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : null;
    seen.push({ method: req.method, url: req.url, body });
    const send = (s, j) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url === '/token') return send(200, { access_token: 'tk', expires_in: 2592000 });
    const m = req.url.match(/^\/nfce\/([^/]+)\/cancelamento$/);
    if (m && req.method === 'POST') {
      if (state.mode === 'reject') return send(200, { id: 'ev1', status: 'rejeitado', codigo_status: 501, motivo_status: 'Prazo de cancelamento superior ao previsto' });
      return send(200, { id: 'ev1', status: 'registrado', codigo_status: 135, motivo_status: 'Evento registrado e vinculado a NF-e', numero_protocolo: '323260000000777' });
    }
    send(404, { error: { message: 'rota falsa ' + req.url } });
  });
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  return { url: 'http://127.0.0.1:' + srv.address().port, seen, state, close: () => new Promise(r => { srv.closeAllConnections(); srv.close(r); }) };
}

test('cancelar venda com NFC-e: cancela o cupom até 30 minutos; depois, só troca ou devolução', { skip, timeout: 60000 }, async () => {
  const fake = await fakeAcbr();
  const f = await createStoreFixture({ env: { ACBR_CLIENT_ID: 'cid', ACBR_CLIENT_SECRET: 'csec', ACBR_AMBIENTE: 'sandbox', ACBR_API_URL: fake.url, ACBR_AUTH_URL: fake.url + '/token' } });
  try {
    const { api, request, tenant, db } = f;
    await db.query('UPDATE tenants SET sales_enabled=true WHERE id=$1', [tenant]);
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const prod = (await db.query("INSERT INTO products(tenant_id,name,barcode,price_cents,stock_qty) VALUES($1,'Brinco Gota','003622',5000,5) RETURNING id", [tenant])).rows[0].id;
    const sell = () => api('/store/sales', { method: 'POST', body: { items: [{ product_id: prod, quantity: 1 }], anonymous: true, payment_method: 'credit' } }, 201).then(r => r.sale);
    let n = 0;
    const cupom = (saleId, ageMin, status = 'authorized') => db.query(`INSERT INTO fiscal_documents(tenant_id,sale_id,model,env,series,number,status,provider,provider_ref,payload,created_at)
      VALUES($1,$2,65,'homologacao',10,$3,$4,'acbr',$5,'{}'::jsonb, now() - make_interval(mins => $6)) RETURNING id`, [tenant, saleId, ++n, status, 'nf' + n, ageMin]).then(r => r.rows[0].id);
    const cancel = id => request(`/store/sales/${id}/cancel`, { method: 'POST', body: { reason: 'Cliente desistiu da compra' } });

    // Dentro dos 30 minutos: cancela o cupom e a venda; estoque volta.
    const s1 = await sell(); const d1 = await cupom(s1.id, 10);
    const today = await api('/store/kiosk/cash-today').catch(() => null);
    if (today) assert.equal(today.sales.find(x => x.id === s1.id).nfce.status, 'authorized');
    assert.equal((await cancel(s1.id)).status, 200);
    const ev = fake.seen.find(x => x.url === '/nfce/nf1/cancelamento');
    assert.ok(ev, 'pediu o cancelamento na ACBr'); assert.match(ev.body.justificativa, /^Venda cancelada no caixa: Cliente desistiu/);
    assert.ok(ev.body.justificativa.length >= 15);
    const doc1 = (await db.query('SELECT status, cancel_protocol, canceled_at FROM fiscal_documents WHERE id=$1', [d1])).rows[0];
    assert.equal(doc1.status, 'canceled'); assert.equal(doc1.cancel_protocol, '323260000000777'); assert.ok(doc1.canceled_at);
    assert.ok((await db.query('SELECT canceled_at FROM sales WHERE id=$1', [s1.id])).rows[0].canceled_at);
    assert.equal((await db.query('SELECT stock_qty FROM products WHERE id=$1', [prod])).rows[0].stock_qty, 5);

    // Passou de 30 minutos: não chama a ACBr e a venda continua.
    const s2 = await sell(); await cupom(s2.id, 31);
    const before = fake.seen.length;
    const r2 = await cancel(s2.id);
    assert.equal(r2.status, 409); assert.match(r2.data.error, /30 minutos.*troca ou devolução/);
    assert.equal(fake.seen.length, before);
    assert.equal((await db.query('SELECT canceled_at FROM sales WHERE id=$1', [s2.id])).rows[0].canceled_at, null);

    // SEFAZ recusa: venda continua valendo, cupom continua autorizado, motivo gravado.
    fake.state.mode = 'reject';
    const s3 = await sell(); const d3 = await cupom(s3.id, 5);
    const r3 = await cancel(s3.id);
    assert.equal(r3.status, 502); assert.match(r3.data.error, /501.*A venda continua valendo/);
    assert.equal((await db.query('SELECT canceled_at FROM sales WHERE id=$1', [s3.id])).rows[0].canceled_at, null);
    assert.equal((await db.query('SELECT status FROM fiscal_documents WHERE id=$1', [d3])).rows[0].status, 'authorized');

    // Cupom ainda em processamento: espera.
    const s4 = await sell(); await cupom(s4.id, 1, 'processing');
    assert.equal((await cancel(s4.id)).status, 409);

    // Venda sem cupom: regra de sempre (cancela enquanto o caixa está aberto), sem chamar a ACBr.
    fake.state.mode = 'ok';
    const s5 = await sell(); const b5 = fake.seen.length;
    assert.equal((await cancel(s5.id)).status, 200); assert.equal(fake.seen.length, b5);
  } finally { await f.cleanup(); await fake.close(); }
});
