import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoreFixture} from './helpers/store-fixture.js';

test('camera reservation serializes different orders and preserves active captures',{
 skip:process.env.TEST_DATABASE_URL?false:'Set TEST_DATABASE_URL',timeout:30000
},async()=>{
 const f=await createStoreFixture();const {api,request,db}=f;
 try{
  await api('/master/tenants/'+f.tenant,{method:'PATCH',token:f.masterToken,body:{camera_limit:2}});
  const cameras=[];for(const name of ['First station','Second station'])cameras.push(await api('/cameras',{method:'POST',token:f.masterToken,body:{tenant_id:f.tenant,name}},201));
  const process=await api('/processes',{method:'POST',body:{name:'Two stations',steps:['First','Second'],camera_id:cameras[0].id,step_cameras:{1:cameras[1].id}}},201);
  const other=await api('/processes',{method:'POST',body:{name:'Second station only',steps:['Second'],camera_id:cameras[1].id}},201);
  const make=async(reference,process_id=process.id)=>api('/orders/quick',{method:'POST',body:{reference,process_id}},201);
  const first=await make('First'),second=await make('Second'),independent=await make('Other',other.id);
  const move=(order,action)=>request('/orders/'+order.id+'/transition',{method:'POST',body:{action}});
  const race=await Promise.all([move(first,'start'),move(second,'start')]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  const winner=race[0].status===200?first:second,loser=winner===first?second:first;
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1',[loser.id])).rows[0].status,'queued');
  assert.equal((await db.query('SELECT count(*)::int n FROM recordings WHERE order_id=$1',[loser.id])).rows[0].n,0);
  assert.equal((await move(independent,'start')).status,200);
  const capture=(await db.query('SELECT id,status FROM recordings WHERE order_id=$1',[winner.id])).rows[0];
  assert.equal((await move(winner,'advance')).status,409);
  assert.equal((await db.query('SELECT step_index FROM orders WHERE id=$1',[winner.id])).rows[0].step_index,0);
  assert.deepEqual((await db.query('SELECT id,status FROM recordings WHERE order_id=$1',[winner.id])).rows,[capture]);
  assert.equal((await move(winner,'pause')).status,200);assert.equal((await move(loser,'start')).status,200);
  assert.equal((await move(winner,'resume')).status,409);
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1',[winner.id])).rows[0].status,'paused');
  assert.equal((await move(loser,'pause')).status,200);assert.equal((await move(winner,'resume')).status,200);
 }finally{await f.cleanup()}
});
