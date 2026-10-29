import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createStoreFixture } from './helpers/store-fixture.js';

test('daily store operations, private queue information and administrative niches', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL to local PostgreSQL', timeout: 60000
}, async t => {
  const f = await createStoreFixture();
  const { api, request, db } = f;
  try {
    let nicheStore, nicheToken, process, customer, foreignProcess, camera;
    const makeOrder = async (reference, details = {}) => api('/orders', { method: 'POST', body: { customer_id: customer.id, process_id: process.id, reference, details } }, 201);
    const publicPath = order => '/public/orders/' + new URL(order.tracking_url).pathname.split('/').at(-1);
    const move = (id, action, extra = {}) => api(`/orders/${id}/transition`, { method: 'POST', body: { action, ...extra } });
    await t.test('only the administrator chooses a niche and provisions its initial process', async () => {
      nicheStore = await api('/master/tenants', { method: 'POST', token: f.masterToken, body: { name: 'Assistência do teste', slug: 'niche-' + crypto.randomBytes(6).toString('hex'), niche: 'electronics' } }, 201);
      nicheToken = await f.addOwner(nicheStore.id);
      const settings = await api('/store/settings', { token: nicheToken });
      assert.equal(settings.niche, 'electronics'); assert.equal(settings.default_item_type, 'device');
      const processes = await api('/processes', { token: nicheToken });
      assert.equal(processes.length, 1); assert.equal(processes[0].name, 'Assistência técnica');
      assert.equal((await request('/master/tenants/' + nicheStore.id, { method: 'PATCH', token: nicheToken, body: { niche: 'automotive' } })).status, 403);
      assert.equal((await request('/store/settings', { method: 'PATCH', token: nicheToken, body: { name: 'Test', logo_url: '', email_notifications: 'off', niche: 'automotive' } })).status, 400);
      assert.equal((await api('/store/settings', { token: nicheToken })).niche, 'electronics');
    });
    await t.test('orders store structured item details and sort newest first without a list limit', async () => {
      customer = await api('/customers', { method: 'POST', body: { name: 'Cliente privado', phone: '85999990000', email: 'customer@example.test' } }, 201);
      camera = await api('/cameras', { method: 'POST', token:f.masterToken, body: { tenant_id:f.tenant,name: 'Bancada' } }, 201);
      process = await api('/processes', { method: 'POST', body: { name: 'Reparo', steps: ['Recepção', 'Diagnóstico', 'Finalização'], camera_id: camera.id } }, 201);
      const orders = [];
      for (let i = 0; i < 16; i++) orders.push(await makeOrder('RECENT-' + i, { item_type: 'vehicle', brand: 'Marca ' + i, model: 'Modelo ' + i, identifier: 'TEST' + i, notes: 'Nota privada ' + i }));
      const listed = await api('/orders'); assert.equal(listed.length, 16);
      assert.equal(listed[0].id, orders.at(-1).id); assert.equal(listed.at(-1).id, orders[0].id);
      assert.equal(listed[0].details.model, 'Modelo 15');
      await api('/orders/' + orders[0].id, { method: 'PATCH', body: { details: { item_type: 'device', brand: 'Nova marca', model: 'Novo modelo', notes: 'Não publicar' }, reference: 'EDITADO' } });
      const edited = (await api('/orders')).find(o => o.id === orders[0].id);
      assert.equal(edited.details.model, 'Novo modelo'); assert.equal(edited.external_reference, 'EDITADO');
      assert.equal((await request('/orders/' + edited.id, { method: 'PATCH', token: f.foreignToken, body: { details: { notes: 'Intrusão' } } })).status, 404);
      const publicOrder = await api(publicPath(orders[0]), { token: null });
      assert.equal('details' in publicOrder, false); assert.equal('customer_email' in publicOrder, false);
    });
    await t.test('queued work can pause; returning stages creates distinct recordings and stale actions cannot skip stages', async () => {
      const order = await makeOrder('BACK-TEST');
      await move(order.id, 'pause');
      assert.equal((await api('/orders')).find(o => o.id === order.id).started_at, null);
      assert.equal((await move(order.id, 'resume')).status, 'queued');
      await move(order.id, 'start');
      const actions = await Promise.all([request(`/orders/${order.id}/transition`, { method: 'POST', body: { action: 'advance', expected_step_index: 0, expected_status: 'live' } }), request(`/orders/${order.id}/transition`, { method: 'POST', body: { action: 'advance', expected_step_index: 0, expected_status: 'live' } })]);
      assert.deepEqual(actions.map(r => r.status).sort(), [200, 409]);
      await move(order.id, 'back', { expected_step_index: 1, expected_status: 'live' });
      await move(order.id, 'pause'); await move(order.id, 'resume');
      const recordings = (await db.query('SELECT id,step_index,visit_index,status FROM recordings WHERE order_id=$1 ORDER BY step_index,visit_index', [order.id])).rows;
      assert.equal(recordings.length, 4); assert.equal(new Set(recordings.map(r => r.id)).size, 4);
      assert.deepEqual(recordings.filter(r => r.step_index === 0).map(r => r.visit_index), [0, 1, 2]);
      assert.equal(recordings.filter(r => r.status === 'pending').length, 1);
      f.migrate(); // Must not recreate the old unique-per-step index.
    });
    await t.test('deleting live or paused work revokes the link and finalizes captures immediately', async () => {
      for (const paused of [false, true]) {
        const order = await makeOrder('DELETE-' + paused); await move(order.id, 'start');
        if (paused) await move(order.id, 'pause');
        assert.equal((await request('/orders/' + order.id, { method: 'DELETE', token: f.foreignToken })).status, 404);
        await api('/orders/' + order.id, { method: 'DELETE' });
        assert.equal((await request(publicPath(order), { token: null })).status, 404);
        assert.ok(!(await api('/orders')).some(o => o.id === order.id));
        const recordings = (await db.query('SELECT status FROM recordings WHERE order_id=$1', [order.id])).rows;
        assert.ok(recordings.length > 0 && recordings.every(r => r.status === 'finalizing'));
        assert.equal((await request(`/orders/${order.id}/transition`, { method: 'POST', body: { action: 'resume' } })).status, 404);
      }
    });
    await t.test('FIFO positions respect manual priorities and show only anonymous current phases', async () => {
      const active = await api('/orders/quick', { method: 'POST', token: nicheToken, body: { reference: 'SECRET-CURRENT' } }, 201);
      const first = await api('/orders/quick', { method: 'POST', token: nicheToken, body: { reference: 'FIRST-WAITING' } }, 201);
      const second = await api('/orders/quick', { method: 'POST', token: nicheToken, body: { reference: 'SECOND-WAITING' } }, 201);
      await api('/orders/' + active.id + '/transition', { method: 'POST', token: nicheToken, body: { action: 'start' } });
      await api('/orders/' + active.id + '/transition', { method: 'POST', token: nicheToken, body: { action: 'advance' } });
      let publicSecond = await api(publicPath(second), { token: null });
      assert.equal(publicSecond.queue_position, 2); assert.equal(publicSecond.active_services[0].step_name, 'Em preparação');
      for (const summary of publicSecond.active_services) assert.deepEqual(Object.keys(summary).sort(), ['status', 'step_index', 'step_name', 'total_steps']);
      assert.ok(!JSON.stringify(publicSecond).includes(active.id)); assert.ok(!JSON.stringify(publicSecond).includes('SECRET-CURRENT'));
      await api('/orders/queue-order', { method: 'PUT', token: nicheToken, body: { ids: [second.id, first.id] } });
      assert.equal((await api(publicPath(second), { token: null })).queue_position, 1);
      await api('/orders/' + active.id + '/transition', { method: 'POST', token: nicheToken, body: { action: 'pause' } });
      assert.equal((await api(publicPath(second), { token: null })).active_services[0].status, 'paused');
      await api('/orders/' + active.id, { method: 'DELETE', token: nicheToken });
      assert.deepEqual((await api(publicPath(second), { token: null })).active_services, []);
      await api('/orders/' + first.id, { method: 'DELETE', token: nicheToken });
      assert.equal((await api(publicPath(second), { token: null })).queue_position, 1);
      foreignProcess = await api('/processes', { method: 'POST', token: f.foreignToken, body: { name: 'Foreign', steps: ['SECRET-FOREIGN-PHASE'] } }, 201);
      const foreign = await api('/orders/quick', { method: 'POST', token: f.foreignToken, body: { reference: 'FOREIGN', process_id: foreignProcess.id } }, 201);
      await api('/orders/' + foreign.id + '/transition', { method: 'POST', token: f.foreignToken, body: { action: 'start' } });
      publicSecond = await api(publicPath(second), { token: null }); assert.ok(!JSON.stringify(publicSecond).includes('SECRET-FOREIGN-PHASE'));
    });
    await t.test('camera slots are centrally controlled and parallel requests cannot bypass a six-camera plan', async () => {
      const store = await api('/master/tenants', { method:'POST',token:f.masterToken,body:{name:'Six cameras',slug:'six-'+crypto.randomBytes(6).toString('hex'),camera_limit:6} },201);
      const ownerToken=await f.addOwner(store.id);
      assert.equal((await request('/cameras',{method:'POST',token:ownerToken,body:{tenant_id:store.id,name:'Not approved'}})).status,403);
      const attempts=await Promise.all(Array.from({length:7},(_,index)=>request('/cameras',{method:'POST',token:f.masterToken,body:{tenant_id:store.id,name:'Camera '+index}})));
      assert.equal(attempts.filter(r=>r.status===201).length,6);assert.equal(attempts.filter(r=>r.status===409).length,1);
      let cameras=(await api('/cameras',{token:f.masterToken})).filter(c=>c.tenant_id===store.id);assert.equal(cameras.length,6);
      assert.equal((await request('/master/tenants/'+store.id,{method:'PATCH',token:f.masterToken,body:{camera_limit:1}})).status,409);
      assert.equal((await request('/cameras/'+cameras[0].id,{method:'DELETE',token:ownerToken})).status,403);
      await api('/cameras/'+cameras[0].id,{method:'PATCH',token:f.masterToken,body:{replacement:true}});
      const replaced=(await api('/cameras',{token:f.masterToken})).find(c=>c.id===cameras[0].id);assert.equal(replaced.enabled,false);assert.equal(replaced.status,'unconfigured');
      assert.equal((await request('/cameras',{method:'POST',token:f.masterToken,body:{tenant_id:store.id,name:'Blocked still occupies a slot'}})).status,409);
      await api('/cameras/'+cameras[0].id,{method:'DELETE',token:f.masterToken});
      await api('/cameras',{method:'POST',token:f.masterToken,body:{tenant_id:store.id,name:'Replacement slot'}},201);
      assert.equal((await api('/store/settings',{token:ownerToken})).camera_count,6);
      const paths=(await db.query('SELECT stream_path FROM cameras WHERE tenant_id=$1 AND deleted_at IS NULL',[store.id])).rows;
      assert.equal(new Set(paths.map(c=>c.stream_path)).size,6);
    });
    await t.test('suspending a store revokes an existing owner session and restoring access restores it', async () => {
      await api('/master/tenants/'+nicheStore.id,{method:'PATCH',token:f.masterToken,body:{status:'suspended'}});
      assert.equal((await request('/orders',{token:nicheToken})).status,403);
      assert.equal((await request('/me',{token:nicheToken})).status,403);
      await api('/master/tenants/'+nicheStore.id,{method:'PATCH',token:f.masterToken,body:{status:'active'}});
      assert.equal((await request('/orders',{token:nicheToken})).status,200);
      const settings=await api('/master/settings',{token:f.masterToken});assert.equal(settings.sales_whatsapp,'');
      await api('/master/settings',{method:'PUT',token:f.masterToken,body:{sales_whatsapp:'5585999990000'}});
      assert.equal((await api('/store/settings',{token:nicheToken})).sales_whatsapp,'5585999990000');
      assert.equal((await request('/master/settings',{method:'PUT',body:{sales_whatsapp:'11111111111'}})).status,403);
      const stats=await api('/master/stats',{token:f.masterToken});assert.equal(stats.billing_automation_configured,false);
      assert.ok(stats.active_tenants>=1);
    });
  } finally { await f.cleanup(); }
});
