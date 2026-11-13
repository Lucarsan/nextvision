import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createStoreFixture } from './helpers/store-fixture.js';

const id = () => crypto.randomUUID();

// Envio do link: pedido mostra se o link saiu ou o motivo de não sair; QR fixo mostra os pedidos só ao aparelho reconhecido.
test('link não enviado com motivo e área do cliente pelo QR fixo', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 90000
}, async () => {
  const f = await createStoreFixture();
  const { api, db, base } = f;
  const call = async (path, { method = 'POST', body, token = f.ownerToken } = {}) => (await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined })).status;
  const pub = async (path, body) => { const r = await fetch(base + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  try {
    const slug = 'portal-' + f.tenant.slice(0, 8);
    await db.query("UPDATE tenants SET slug=$1, whatsapp='558532130953' WHERE id=$2", [slug, f.tenant]);
    await db.query('INSERT INTO tenant_slugs(slug,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [slug, f.tenant]);
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Banho', 'Secagem'] } }, 201);
    const maria = await api('/customers', { method: 'POST', body: { name: 'maria souza', phone: '85988887777' } }, 201);
    const joao = await api('/customers', { method: 'POST', body: { name: 'João', phone: '85977776666' } }, 201);
    const o1 = await api('/orders', { method: 'POST', body: { customer_id: maria.id, process_id: proc.id, details: { pet_name: 'Thor' } } }, 201);
    const o2 = await api('/orders', { method: 'POST', body: { customer_id: maria.id, process_id: proc.id, details: { pet_name: 'Luna' } } }, 201);
    const o3 = await api('/orders', { method: 'POST', body: { customer_id: joao.id, process_id: proc.id } }, 201);
    const byId = async () => Object.fromEntries((await api('/orders')).map(o => [o.id, o]));

    // Recém-criado: sem envio e sem motivo.
    let all = await byId();
    assert.equal(all[o1.id].link_shared_at, null); assert.equal(all[o1.id].link_skip, null);

    // Enviado pelo WhatsApp.
    assert.equal(await call('/store/link-shares', { body: { link: o1.tracking_url, channel: 'whatsapp' } }), 204);
    // Motivos: inválido recusado; outra loja não registra; "depois" fica pendente; "sem WhatsApp" resolve.
    assert.equal(await call('/store/orders/' + o2.id + '/link-skip', { body: { reason: 'preguiça' } }), 400);
    assert.equal(await call('/store/orders/' + o2.id + '/link-skip', { body: { reason: 'later' }, token: f.foreignToken }), 404);
    assert.equal(await call('/store/orders/' + o2.id + '/link-skip', { body: { reason: 'later' }, token: null }), 401);
    assert.equal(await call('/store/orders/not-a-uuid/link-skip', { body: { reason: 'later' } }), 404);
    assert.equal(await call('/store/orders/' + o2.id + '/link-skip', { body: { reason: 'later' } }), 204);
    assert.equal(await call('/store/orders/' + o3.id + '/link-skip', { body: { reason: 'no_whatsapp' } }), 204);
    all = await byId();
    assert.ok(all[o1.id].link_shared_at, 'enviado tem data');
    assert.equal(all[o2.id].link_skip, 'later'); assert.equal(all[o2.id].link_shared_at, null);
    assert.equal(all[o3.id].link_skip, 'no_whatsapp');
    // Relatório por pedido traz o motivo.
    const day = new Date().toISOString().slice(0, 10), next = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10), prev = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    const rows = await api('/master/analytics/orders?from=' + prev + '&to=' + next + '&tenant=' + f.tenant, { token: f.masterToken });
    const list = Array.isArray(rows) ? rows : rows.orders;
    assert.equal(list.find(r => r.id === o3.id).skip_reason, 'no_whatsapp');
    void day;

    // ---- Área do cliente pelo QR fixo ----
    const t1 = o1.tracking_url.split('/p/')[1];
    const phone = id(), stranger = id(), tablet = id();
    // Celular da Maria abriu o link do Thor.
    assert.equal((await pub('/public/orders/' + t1 + '/visit', { visit: id(), visitor: phone, visible: 5, live: 0, device: 'mobile' })).status, 204);
    let r = await pub('/public/stores/' + slug + '/my-orders', { visitor: phone });
    assert.equal(r.status, 200); assert.equal(r.data.known, true); assert.equal(r.data.name, 'Maria');
    assert.deepEqual(r.data.orders.map(o => o.item).sort(), ['Luna', 'Thor'], 'vê os pedidos dela, inclusive o que ainda não recebeu');
    assert.ok(r.data.orders.every(o => /^\/p\/[\w-]+$/.test(o.link)));
    assert.ok(!JSON.stringify(r.data).includes('85988887777'), 'não devolve telefone');
    // Aparelho desconhecido, inválido ou de outra loja: nada.
    assert.deepEqual((await pub('/public/stores/' + slug + '/my-orders', { visitor: stranger })).data, { known: false });
    assert.equal((await pub('/public/stores/' + slug + '/my-orders', { visitor: 'x' })).status, 400);
    assert.equal((await pub('/public/stores/nao-existe-xyz/my-orders', { visitor: phone })).status, 404);
    // Tablet da loja que abriu links de clientes diferentes não vira "área do cliente".
    const t3 = o3.tracking_url.split('/p/')[1];
    await pub('/public/orders/' + t1 + '/visit', { visit: id(), visitor: tablet, visible: 0, live: 0 });
    await pub('/public/orders/' + t3 + '/visit', { visit: id(), visitor: tablet, visible: 0, live: 0 });
    assert.deepEqual((await pub('/public/stores/' + slug + '/my-orders', { visitor: tablet })).data, { known: false });
    // Aparelho da equipe também não.
    const staff = id();
    await pub('/public/orders/' + t1 + '/visit', { visit: id(), visitor: staff, visible: 0, live: 0, staff: true });
    assert.deepEqual((await pub('/public/stores/' + slug + '/my-orders', { visitor: staff })).data, { known: false });
    // Pedido excluído some.
    await api('/orders/' + o2.id, { method: 'DELETE' });
    r = await pub('/public/stores/' + slug + '/my-orders', { visitor: phone });
    assert.deepEqual(r.data.orders.map(o => o.item), ['Thor']);
  } finally { await f.cleanup(); }
});

// Pedidos de antes do recurso não cobram envio, a não ser que o cliente esteja com venda em "A receber" aberta.
test('link não enviado só cobra pedidos novos ou com venda a receber aberta', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 90000
}, async () => {
  const f = await createStoreFixture();
  const { api, db } = f;
  try {
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Banho'] } }, 201);
    const bia = await api('/customers', { method: 'POST', body: { name: 'Bia', phone: '85911112222' } }, 201);
    const caio = await api('/customers', { method: 'POST', body: { name: 'Caio', phone: '85933334444' } }, 201);
    const oldGone = await api('/orders', { method: 'POST', body: { customer_id: bia.id, process_id: proc.id } }, 201);
    const oldWaiting = await api('/orders', { method: 'POST', body: { customer_id: caio.id, process_id: proc.id } }, 201);
    // Como a migração 057 deixa os pedidos que já existiam.
    await db.query('UPDATE orders SET link_due=false WHERE id = ANY($1)', [[oldGone.id, oldWaiting.id]]);
    const fresh = await api('/orders', { method: 'POST', body: { customer_id: bia.id, process_id: proc.id } }, 201);
    const due = async () => Object.fromEntries((await api('/orders')).map(o => [o.id, o.link_due]));
    let d = await due();
    assert.equal(d[fresh.id], true, 'pedido novo cobra');
    assert.equal(d[oldGone.id], false, 'antigo dispensado');
    assert.equal(d[oldWaiting.id], false);
    // Caio com venda em "A receber" aberta: o pet ainda está na loja, volta a cobrar.
    const p = await api('/store/sales/pending', { method: 'POST', body: { customer_id: caio.id, total_cents: 5000, description: 'Banho' } }, 201);
    d = await due();
    assert.equal(d[oldWaiting.id], true, 'a receber aberto cobra');
    assert.equal(d[oldGone.id], false);
    // Cancelada a venda, volta a ficar dispensado.
    await api('/store/sales/pending/' + p.id + '/cancel', { method: 'POST', body: { reason: 'Teste' } });
    d = await due();
    assert.equal(d[oldWaiting.id], false);
  } finally { await f.cleanup(); }
});
