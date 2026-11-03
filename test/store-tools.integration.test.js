import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('links úteis: links, dívidas, emissor do recibo, atalhos e importação do painel antigo', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken, foreignToken } = f;
    // Desligado sem "Caixa e mensagens".
    assert.equal((await request('/store/tools/links')).status, 403);
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });

    // Atalhos padrão.
    let st = await api('/store/tools/settings');
    assert.deepEqual(st.shortcuts.map(s => s.view), ['cash', 'links', 'messages']);
    assert.deepEqual(st.receipt_issuer, {});

    // Links: endereço sem https vira https; javascript: é recusado; duplicado pede confirmação.
    const l1 = await api('/store/tools/links', { method: 'POST', body: { name: 'Fornecedor', url: 'fornecedor.com.br/pedidos', categories: ['Fornecedores', 'Fornecedores'], keywords: 'tela peça' } }, 201);
    assert.equal(l1.url, 'https://fornecedor.com.br/pedidos'); assert.deepEqual(l1.categories, ['Fornecedores']);
    assert.equal((await request('/store/tools/links', { method: 'POST', body: { name: 'X', url: 'javascript:alert(1)' } })).status, 400);
    assert.equal((await request('/store/tools/links', { method: 'POST', body: { name: 'Dup', url: 'http://www.fornecedor.com.br/pedidos/' } })).status, 409);
    await api('/store/tools/links?allow_duplicate=1', { method: 'POST', body: { name: 'Dup', url: 'http://www.fornecedor.com.br/pedidos/' } }, 201);
    const l2 = await api('/store/tools/links', { method: 'POST', body: { name: 'Consulta IMEI', url: 'https://imei.info' } }, 201);
    assert.ok(l2.position > l1.position);
    const pin = await api('/store/tools/links/' + l2.id, { method: 'PATCH', body: { pinned: true, categories: ['Consultas'] } });
    assert.equal(pin.pinned, true); assert.deepEqual(pin.categories, ['Consultas']);
    const opened = await api(`/store/tools/links/${l2.id}/open`, { method: 'POST' });
    assert.equal(opened.clicks, 1); assert.ok(opened.last_opened_at);
    let links = await api('/store/tools/links'); assert.equal(links.length, 3);
    await api('/store/tools/links/order', { method: 'PUT', body: { ids: [l2.id, l1.id, links[1].id] } });
    links = await api('/store/tools/links'); assert.deepEqual(links.map(l => l.id).slice(0, 2), [l2.id, l1.id]);
    // Outra loja não vê nem mexe.
    await api('/master/tenants/' + f.foreignTenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    assert.equal((await api('/store/tools/links', { token: foreignToken })).length, 0);
    assert.equal((await request('/store/tools/links/' + l1.id, { method: 'PATCH', token: foreignToken, body: { name: 'hack' } })).status, 404);
    assert.equal((await request('/store/tools/links/' + l1.id, { method: 'DELETE', token: foreignToken })).status, 404);

    // Atalhos: tela, link salvo e outro site; link de outra loja é recusado.
    assert.equal((await request('/store/tools/shortcuts', { method: 'PUT', token: foreignToken, body: { shortcuts: [{ type: 'link', link_id: l1.id }] } })).status, 404);
    assert.equal((await request('/store/tools/shortcuts', { method: 'PUT', body: { shortcuts: [{ type: 'url', label: 'X', url: 'javascript:1' }] } })).status, 400);
    const sc = await api('/store/tools/shortcuts', { method: 'PUT', body: { shortcuts: [{ type: 'view', view: 'cash' }, { type: 'link', link_id: l1.id }, { type: 'url', label: 'Banco', url: 'banco.com.br' }] } });
    assert.equal(sc.shortcuts[2].url, 'https://banco.com.br/');
    // Apagar o link tira o atalho dele.
    await api('/store/tools/links/' + l1.id, { method: 'DELETE' });
    st = await api('/store/tools/settings');
    assert.deepEqual(st.shortcuts.map(s => s.type), ['view', 'url']);

    // Operador novato: usa, mas não apaga.
    const basic = await f.addOperator(tenant, 'basic');
    assert.equal((await api('/store/tools/links', { token: basic.token })).length, 2);
    assert.equal((await request('/store/tools/links/' + l2.id, { method: 'DELETE', token: basic.token })).status, 403);

    // Dívidas.
    const maria = await api('/store/tools/debts', { method: 'POST', body: { name: 'Maria Souza', phone: '85 99999-0000' } }, 201);
    assert.equal(maria.balance_cents, 0); assert.deepEqual(maria.items, []);
    const i1 = await api(`/store/tools/debts/${maria.id}/items`, { method: 'POST', body: { who: 'Maria', description: 'Película', day: '2026-11-01', amount_cents: 3000 } }, 201);
    const i2 = await api(`/store/tools/debts/${maria.id}/items`, { method: 'POST', body: { description: 'Capa', amount_cents: 2500, paid_cents: 1000 } }, 201);
    assert.equal(i1.day, '2026-11-01'); assert.equal(i2.day, null);
    const up = await api('/store/tools/debt-items/' + i1.id, { method: 'PATCH', body: { paid_cents: 3000, done: true } });
    assert.equal(up.paid_cents, 3000); assert.equal(up.done, true); assert.equal(up.day, '2026-11-01', 'não mexe na data se não veio');
    assert.equal((await api('/store/tools/debt-items/' + i1.id, { method: 'PATCH', body: { day: null } })).day, null);
    assert.equal((await request('/store/tools/debt-items/' + i1.id, { method: 'PATCH', body: { amount_cents: -1 } })).status, 400);
    let all = await api('/store/tools/debts');
    assert.equal(all.length, 1); assert.equal(all[0].total_cents, 5500); assert.equal(all[0].paid_cents, 4000); assert.equal(all[0].balance_cents, 1500); assert.equal(all[0].open_items, 1);
    assert.equal((await request('/store/tools/debt-items/' + i2.id, { method: 'PATCH', token: foreignToken, body: { paid_cents: 2500 } })).status, 404);
    assert.equal((await request(`/store/tools/debts/${maria.id}/items`, { method: 'POST', token: foreignToken, body: { amount_cents: 1 } })).status, 404);
    assert.equal((await request('/store/tools/debts/' + maria.id, { method: 'DELETE', token: basic.token })).status, 403);
    // Operador novato anota e marca pagamento.
    await api(`/store/tools/debts/${maria.id}/items`, { method: 'POST', token: basic.token, body: { description: 'Cabo', amount_cents: 1500 } }, 201);
    const cleared = await api(`/store/tools/debts/${maria.id}/clear`, { method: 'POST' });
    assert.equal(cleared.items.length, 0); assert.equal(cleared.balance_cents, 0);
    const ren = await api('/store/tools/debts/' + maria.id, { method: 'PATCH', body: { name: 'Maria S.' } });
    assert.equal(ren.name, 'Maria S.'); assert.equal(ren.phone, '85 99999-0000');

    // Emissor do recibo: salvo para a loja; logo só imagem.
    const iss = await api('/store/tools/receipt-issuer', { method: 'PUT', body: { name: 'Eli@sTECH', city: 'Fortaleza', logo: 'data:image/png;base64,iVBORw0KGgo=' } });
    assert.equal(iss.name, 'Eli@sTECH');
    assert.equal((await api('/store/tools/receipt-issuer', { method: 'PUT', body: { phone: '(85) 3213-0000' } })).city, 'Fortaleza', 'junta com o que já tinha');
    assert.equal((await request('/store/tools/receipt-issuer', { method: 'PUT', body: { logo: 'data:text/html;base64,PHNjcmlwdD4=' } })).status, 400);
    assert.equal((await api('/store/tools/settings')).receipt_issuer.phone, '(85) 3213-0000');

    // Importação do painel antigo: acrescenta e pula repetidos.
    const imp = await api('/store/tools/import', { method: 'POST', body: {
      links: [{ name: 'IMEI', url: 'imei.info' }, { name: 'Novo', url: 'novo.com', categories: ['A'], pinned: true, clicks: 7 }, { name: '', url: '' }],
      debtors: [{ name: 'maria s.', items: [{ amount_cents: 100 }] }, { name: 'João', phone: '85988887777', items: [{ who: 'João', description: 'Bateria', day: '2026-10-20', amount_cents: 12000, paid_cents: 2000 }, {}] }]
    } });
    assert.deepEqual(imp, { links_added: 1, links_skipped: 2, debtors_added: 1, debtors_skipped: 1, items_added: 1 });
    all = await api('/store/tools/debts');
    const joao = all.find(p => p.name === 'João');
    assert.equal(joao.balance_cents, 10000); assert.equal(joao.items[0].day, '2026-10-20');
    assert.equal((await api('/store/tools/links')).find(l => l.name === 'Novo').clicks, 7);
    assert.equal((await request('/store/tools/import', { method: 'POST', token: basic.token, body: { links: [] } })).status, 403);

    // Apagar a pessoa apaga os itens.
    await api('/store/tools/debts/' + joao.id, { method: 'DELETE' });
    assert.equal((await f.db.query('SELECT count(*)::int n FROM store_debt_items WHERE debtor_id=$1', [joao.id])).rows[0].n, 0);
  } finally { await f.cleanup(); }
});
