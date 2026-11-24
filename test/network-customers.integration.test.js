import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('rede: cliente cadastrada numa unidade é achada e usa o cashback em outra', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { tenant, masterToken, api, request } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace-cli', hostname: 'audace-cli.example.test' } }, 201);
    const b = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Messejana', slug: 'audace-messejana-cli' } }, 201);
    const bToken = await f.addOwner(b.id);
    for (const [id, tok] of [[tenant, f.ownerToken], [b.id, bToken]]) {
      await api(`/master/tenants/${id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id } });
      await api('/master/tenants/' + id, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
      await api('/store/sales/cashback', { method: 'PATCH', token: tok, body: { cashback_enabled: true, cashback_percent: 5, cashback_max_use_percent: 30, cashback_valid_days: 90 } });
      await api('/store/cash/open', { method: 'POST', token: tok, body: { opening_cents: 0 } }, 201);
    }
    await api('/master/tenants/' + f.foreignTenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    // Compra em Maracanaú: gera R$ 5,00 de cashback.
    const s1 = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Maria Souza', phone: '85 98888-1234' }, total_cents: 10000, payment_method: 'pix' } }, 201);
    const maria = s1.customer.id;
    assert.ok(maria);
    await f.db.query("UPDATE customers SET cpf='09096174305' WHERE id=$1", [maria]);

    // Em Messejana ela não existe: sem ?network=1 não aparece; com, aparece marcada como de outra unidade.
    assert.equal((await api('/store/sales/customers?q=09096174305', { token: bToken })).length, 0);
    const found = await api('/store/sales/customers?network=1&q=09096174305', { token: bToken });
    assert.equal(found.length, 1); assert.equal(found[0].remote, true); assert.equal(found[0].id, maria);
    // Unidade fora da rede não acha.
    assert.equal((await api('/store/sales/customers?network=1&q=09096174305', { token: f.foreignToken })).length, 0);
    assert.equal((await request('/store/sales/customers/adopt', { method: 'POST', token: f.foreignToken, body: { id: maria } })).status, 404);

    const local = await api('/store/sales/customers/adopt', { method: 'POST', token: bToken, body: { id: maria } });
    assert.notEqual(local.id, maria); assert.equal(local.name, 'Maria Souza'); assert.equal(local.cashback.balance_cents, 500);
    assert.equal((await api('/store/sales/customers/adopt', { method: 'POST', token: bToken, body: { id: maria } })).id, local.id);
    // Agora a busca em Messejana mostra a ficha local, não mais a remota.
    const again = await api('/store/sales/customers?network=1&q=Maria', { token: bToken });
    assert.deepEqual(again.map(x => [x.id, !!x.remote]), [[local.id, false]]);

    // Usa R$ 3,00 em Messejana (30% de R$ 10,00): sai do lote gerado em Maracanaú.
    await api('/store/sales', { method: 'POST', token: bToken, body: { customer_id: local.id, total_cents: 1000, payment_method: 'pix', cashback_use_cents: 300 } }, 201);
    const inA = (await api('/store/sales/customers?q=Maria')).find(x => x.id === maria);
    assert.equal(inA.cashback.balance_cents, 200 + 35); // o saldo é o mesmo nas duas unidades
    const inB = (await api('/store/sales/customers?q=Maria', { token: bToken })).find(x => x.id === local.id);
    assert.equal(inB.cashback.balance_cents, 200 + 35);

    // Cliente nova criada no caixa de Messejana com o mesmo telefone fica ligada à de Maracanaú.
    const s3 = await api('/store/sales', { method: 'POST', token: bToken, body: { new_customer: { name: 'João Lima', phone: '85 97777-0000' }, total_cents: 2000, payment_method: 'pix' } }, 201);
    const s4 = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'João Lima', phone: '(85) 97777-0000' }, total_cents: 2000, payment_method: 'pix' } }, 201);
    const links = (await f.db.query("SELECT link_id FROM customers WHERE name='João Lima'")).rows;
    assert.equal(links.length, 2); assert.ok(links[0].link_id); assert.equal(links[0].link_id, links[1].link_id);
    assert.ok(s3 && s4);
  } finally { await f.cleanup(); }
});
