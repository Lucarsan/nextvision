import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const day = n => { const d = new Date(Date.now() - 3 * 3600000); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('prontuário do pet: registros, retornos, troca de tutor e lista de animais', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 90000
}, async () => {
  const f = await createStoreFixture(); const { api, request, base } = f;
  const del = path => fetch(base + '/api' + path, { method: 'DELETE', headers: { Authorization: 'Bearer ' + f.ownerToken } }).then(r => r.status);
  try {
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { niche: 'pet' } });
    const ana = await api('/customers', { method: 'POST', body: { name: 'Ana Lima', phone: '85988887777' } }, 201);
    const bia = await api('/customers', { method: 'POST', body: { name: 'Bia Souza', phone: '85977776666' } }, 201);
    const thor = await api('/customers/' + ana.id + '/pets', { method: 'POST', body: { name: 'Thor', species: 'Cão' } }, 201);

    // Vacina com próxima dose vencida aparece nos avisos e na lista de animais.
    const v1 = await api('/pets/' + thor.id + '/records', { method: 'POST', body: { kind: 'vaccine', title: 'V10', record_date: day(-400), next_date: day(-35) } }, 201);
    await api('/pets/' + thor.id + '/records', { method: 'POST', body: { kind: 'antiparasitic', title: 'Antipulgas', record_date: day(-10), next_date: day(20) } }, 201);
    await api('/pets/' + thor.id + '/records', { method: 'POST', body: { kind: 'note', title: 'Observação', record_date: day(0), notes: 'Morde ao cortar unha' } }, 201);
    assert.equal((await request('/pets/' + thor.id + '/records', { method: 'POST', body: { kind: 'vaccine', title: 'V10', record_date: day(0), next_date: day(-1) } })).status, 400);
    assert.equal((await request('/pets/' + thor.id + '/records', { method: 'POST', body: { kind: 'xyz', title: 'X', record_date: day(0) } })).status, 400);
    let due = await api('/pet-records/due?days=30');
    assert.deepEqual(due.map(r => r.title), ['V10', 'Antipulgas']);
    assert.equal(due[0].customer_name, 'Ana Lima'); assert.equal(due[0].pet_name, 'Thor');
    let list = await api('/pets'); assert.equal(list[0].name, 'Thor'); assert.equal(String(list[0].next_due).slice(0, 10), day(-35)); assert.equal(list[0].customer_name, 'Ana Lima');

    // Nova dose da mesma vacina dá baixa no retorno pendente.
    await api('/pets/' + thor.id + '/records', { method: 'POST', body: { kind: 'vaccine', title: 'v10', record_date: day(0), next_date: day(365) } }, 201);
    due = await api('/pet-records/due?days=30'); assert.deepEqual(due.map(r => r.title), ['Antipulgas']);
    const ficha = await api('/pets/' + thor.id);
    assert.equal(ficha.records.length, 4); assert.equal(ficha.records.find(r => r.id === v1.id).done_next, true); assert.equal(ficha.customer_name, 'Ana Lima');

    // Editar, dar baixa e excluir registro; outra loja não vê nada.
    const anti = ficha.records.find(r => r.title === 'Antipulgas');
    await api('/pet-records/' + anti.id, { method: 'PATCH', body: { kind: 'antiparasitic', title: 'Antipulgas', record_date: String(anti.record_date).slice(0, 10), next_date: day(20), done_next: true } });
    assert.deepEqual(await api('/pet-records/due?days=30'), []);
    assert.equal((await request('/pets/' + thor.id, { token: f.foreignToken })).status, 404);
    assert.equal((await request('/pets/' + thor.id + '/records', { method: 'POST', body: { kind: 'note', title: 'X', record_date: day(0) }, token: f.foreignToken })).status, 404);
    assert.equal((await request('/pets', { token: f.foreignToken })).data.length, 0);
    assert.equal(await del('/pet-records/' + anti.id), 204); assert.equal(await del('/pet-records/' + anti.id), 404);

    // Trocar o tutor do animal.
    const moved = await api('/pets/' + thor.id, { method: 'PATCH', body: { name: 'Thor', species: 'Cão', customer_id: bia.id } });
    assert.equal(moved.customer_id, bia.id);
    assert.equal((await request('/pets/' + thor.id, { method: 'PATCH', body: { name: 'Thor', customer_id: '00000000-0000-4000-8000-000000000000' } })).status, 400);
    assert.deepEqual((await api('/customers')).find(c => c.id === bia.id).pets.map(p => p.name), ['Thor']);
  } finally { await f.cleanup(); }
});

test('encerramento automático: finaliza pedidos começados no horário da loja', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 90000
}, async () => {
  process.env.AUTO_CLOSE_INTERVAL_MS = '400';
  const f = await createStoreFixture(); const { api, request } = f;
  try {
    // Configuração pela API (só o dono; horário válido).
    assert.equal((await request('/store/auto-close', { method: 'PATCH', body: { time: '25:00' } })).status, 400);
    const saved = await api('/store/auto-close', { method: 'PATCH', body: { time: '19:00' } });
    assert.equal(saved.auto_close_time, '19:00');
    assert.equal((await api('/store/settings')).auto_close_time, '19:00');
    // Se o horário de hoje já passou, só vale a partir de amanhã.
    await api('/store/auto-close', { method: 'PATCH', body: { time: '00:00' } });
    assert.equal((await f.db.query('SELECT auto_close_last_date IS NOT NULL started FROM tenants WHERE id=$1', [f.tenant])).rows[0].started, true);

    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Banho', 'Secagem', 'Pronto'] } }, 201);
    const cli = await api('/customers', { method: 'POST', body: { name: 'Ana Lima', phone: '85988887777' } }, 201);
    const mk = async () => api('/orders', { method: 'POST', body: { customer_id: cli.id, process_id: proc.id, details: { item_type: 'pet', pet_name: 'Thor' } } }, 201);
    const live = await mk(), paused = await mk(), queued = await mk(), other = await mk();
    for (const o of [live, paused]) await api('/orders/' + o.id + '/transition', { method: 'POST', body: { action: 'start' } });
    await api('/orders/' + paused.id + '/transition', { method: 'POST', body: { action: 'pause' } });

    // Simula "já passou do horário e ainda não rodou hoje".
    await f.db.query('UPDATE tenants SET auto_close_time=$2,auto_close_last_date=NULL WHERE id=$1', [f.tenant, '00:00']);
    let rows;
    for (let i = 0; i < 40; i++) {
      rows = (await f.db.query('SELECT id,status,completed_at FROM orders WHERE id = ANY($1)', [[live.id, paused.id, queued.id]])).rows;
      if (rows.filter(r => r.status === 'completed').length === 2) break; await new Promise(r => setTimeout(r, 250));
    }
    const st = Object.fromEntries(rows.map(r => [r.id, r.status]));
    assert.equal(st[live.id], 'completed'); assert.equal(st[paused.id], 'completed'); assert.equal(st[queued.id], 'queued');
    const audit = await f.db.query("SELECT count(*)::int n FROM audit_events WHERE action='auto_complete' AND tenant_id=$1", [f.tenant]);
    assert.equal(audit.rows[0].n, 2);
    // Roda uma vez por dia: um pedido iniciado depois não é finalizado de novo hoje.
    await api('/orders/' + queued.id + '/transition', { method: 'POST', body: { action: 'start' } });
    await new Promise(r => setTimeout(r, 1500));
    assert.equal((await f.db.query('SELECT status FROM orders WHERE id=$1', [queued.id])).rows[0].status, 'live');
    // Desligar.
    assert.equal((await api('/store/auto-close', { method: 'PATCH', body: { time: null } })).auto_close_time, null);
  } finally { delete process.env.AUTO_CLOSE_INTERVAL_MS; await f.cleanup(); }
});
