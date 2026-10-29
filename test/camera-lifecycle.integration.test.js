import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

test('centralized camera installation, replacement and device isolation', {skip:process.env.TEST_DATABASE_URL?false:'Set TEST_DATABASE_URL',timeout:60000}, async t=>{
 const f=await createStoreFixture();const {api,request,db}=f;
 try{
  const device=async name=>{
   const code=await api('/master/tenants/'+f.tenant+'/activation-codes',{method:'POST',token:f.masterToken},201);
   return api('/connect/activate',{method:'POST',token:null,body:{activation_code:code.activation_code,device_name:name}},201);
  };
  const oldDevice=await device('First authorized computer'),newDevice=await device('Replacement computer');
  await api('/master/tenants/'+f.tenant,{method:'PATCH',token:f.masterToken,body:{camera_limit:3}});
  const cameraA=await api('/cameras',{method:'POST',token:f.masterToken,body:{tenant_id:f.tenant,name:'Front camera',device_id:oldDevice.device_token?oldDevice.id:null}},201);
  const cameraB=await api('/cameras',{method:'POST',token:f.masterToken,body:{tenant_id:f.tenant,name:'Second camera',device_id:oldDevice.id}},201);
  const technician=await f.addTechnician();let assignment,third;
  await t.test('assigned technicians can add cameras only within the authorized store and plan',async()=>{
   assignment=await api('/master/technicians/'+technician.id+'/assignments',{method:'POST',token:f.masterToken,body:{tenant_id:f.tenant}},201);
   third=await api('/technician/assignments/'+assignment.id+'/cameras',{method:'POST',token:technician.token,body:{name:'Third camera'}},201);
   assert.equal((await request('/technician/assignments/'+assignment.id+'/cameras',{method:'POST',token:technician.token,body:{name:'Over limit'}})).status,409);
   assert.equal((await request('/cameras/'+cameraA.id,{method:'PATCH',body:{enabled:false}})).status,403);
   assert.equal((await request('/cameras',{method:'POST',body:{tenant_id:f.tenant,name:'Owner-created camera'}})).status,403);
  });
  await t.test('each device receives distinct approved stream paths and no NVR credentials',async()=>{
   const config=await api('/connect/cameras',{token:oldDevice.device_token});
   assert.equal(config.cameras.length,2);assert.equal(new Set(config.cameras.map(c=>c.stream_path)).size,2);
   assert.ok(config.cameras.every(c=>!('password' in c)&&!('rtsp_url' in c)));
   assert.equal((await api('/connect/cameras',{token:newDevice.device_token})).cameras.length,0);
   const ownerList=await api('/cameras');assert.ok(ownerList.every(c=>!('stream_path' in c)&&!('device_id' in c)));
  });
  await t.test('metadata and temporary disable do not require reentering the camera source password',async()=>{
   const before=(await api('/connect/cameras',{token:oldDevice.device_token})).cameras.find(c=>c.id===cameraA.id).config_version;
   await api('/cameras/'+cameraA.id,{method:'PATCH',token:f.masterToken,body:{name:'Updated front camera',enabled:false}});
   let camera=(await api('/connect/cameras',{token:oldDevice.device_token})).cameras.find(c=>c.id===cameraA.id);
   assert.equal(camera.enabled,false);assert.equal(camera.config_version,before);
   await api('/cameras/'+cameraA.id,{method:'PATCH',token:f.masterToken,body:{enabled:true}});
   camera=(await api('/connect/cameras',{token:oldDevice.device_token})).cameras.find(c=>c.id===cameraA.id);
   assert.equal(camera.enabled,true);assert.equal(camera.config_version,before);
  });
  await t.test('rebinding closes the old capture and only the original device may confirm its completion',async()=>{
   const customer=await api('/customers',{method:'POST',body:{name:'Test customer'}},201);
   const process=await api('/processes',{method:'POST',body:{name:'Test process',steps:['Working'],camera_id:cameraA.id}},201);
   const order=await api('/orders',{method:'POST',body:{customer_id:customer.id,process_id:process.id}},201);
   await api('/orders/'+order.id+'/transition',{method:'POST',body:{action:'start'}});
   const jobs=await api('/connect/recording-jobs',{token:oldDevice.device_token});const job=jobs.jobs.find(job=>job.order_id===order.id);assert.ok(job);
   await api('/connect/recording-jobs/'+job.recording_id+'/event',{method:'POST',token:oldDevice.device_token,body:{event:'started'}});
   await api('/master/tenants/'+f.tenant+'/cameras/'+cameraA.id+'/device',{method:'PATCH',token:f.masterToken,body:{device_id:newDevice.id}});
   assert.ok((await api('/connect/recording-jobs',{token:oldDevice.device_token})).jobs.some(j=>j.recording_id===job.recording_id&&j.status==='finalizing'));
   assert.ok(!(await api('/connect/recording-jobs',{token:newDevice.device_token})).jobs.some(j=>j.recording_id===job.recording_id));
   assert.equal((await request('/connect/recording-jobs/'+job.recording_id+'/event',{method:'POST',token:newDevice.device_token,body:{event:'stopped'}})).status,404);
   await api('/connect/recording-jobs/'+job.recording_id+'/event',{method:'POST',token:oldDevice.device_token,body:{event:'stopped'}});
   await api('/cameras/'+cameraA.id,{method:'PATCH',token:f.masterToken,body:{replacement:true}});
   const row=(await db.query('SELECT id,enabled,status,config_version FROM cameras WHERE id=$1',[cameraA.id])).rows[0];assert.equal(row.id,cameraA.id);assert.equal(row.enabled,false);assert.equal(row.status,'unconfigured');assert.equal(row.config_version,3);
   await api('/cameras/'+cameraA.id,{method:'DELETE',token:f.masterToken});
   assert.equal((await db.query('SELECT count(*)::int n FROM recordings WHERE order_id=$1',[order.id])).rows[0].n,1);
   assert.ok(!(await api('/cameras')).some(c=>c.id===cameraA.id));
  });
  await t.test('completed technical assignments cannot mutate equipment until the central reauthorizes maintenance',async()=>{
   await api('/technician/assignments/'+assignment.id,{method:'PATCH',token:technician.token,body:{status:'completed'}});
   assert.equal((await request('/technician/assignments/'+assignment.id+'/cameras/'+third.id,{method:'DELETE',token:technician.token})).status,403);
   await api('/master/technicians/'+technician.id+'/assignments',{method:'POST',token:f.masterToken,body:{tenant_id:f.tenant}},201);
   await api('/technician/assignments/'+assignment.id+'/cameras/'+third.id,{method:'DELETE',token:technician.token});
   const audit=(await db.query("SELECT action FROM audit_events WHERE target_id=$1 AND action='remove_camera'",[third.id])).rows;assert.equal(audit.length,1);
   assert.equal((await request('/connect/cameras',{token:f.ownerToken})).status,401);
  });
 }finally{await f.cleanup();}
});
