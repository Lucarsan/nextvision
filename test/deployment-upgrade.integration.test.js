import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p}
test('upgrade from schema 13 boots the new API while the bridge remains compatible',{
 skip:process.env.TEST_DATABASE_URL&&process.env.LEGACY_BRIDGE_ROOT?false:'Set local TEST_DATABASE_URL and LEGACY_BRIDGE_ROOT',timeout:60000
},async()=>{
 const url=new URL(process.env.TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
 const db=new pg.Client({connectionString:url.toString(),ssl:false});await db.connect();
 const schema='nv_deploy_'+crypto.randomBytes(6).toString('hex'),children=[];
 const [tenant,camera,processID,owner]=Array.from({length:4},()=>crypto.randomUUID());
 const secret=crypto.randomBytes(32).toString('hex');
 const token=jwt.sign({id:owner,tenant_id:tenant,role:'owner'},secret,{algorithm:'HS256'});
 const start=(file,cwd,env)=>{const p=spawn(process.execPath,[file],{cwd,env,stdio:['ignore','pipe','pipe']});p.stdout.resume();p.stderr.resume();children.push(p);return p};
 try{
  await db.query('CREATE SCHEMA '+schema);await db.query('SET search_path TO '+schema+',public');
  for(const file of (await readdir('sql')).filter(f=>f.endsWith('.sql')&&f<'014').sort())await db.query(await readFile('sql/'+file,'utf8'));
  await db.query("INSERT INTO tenants(id,name,slug,status) VALUES($1,'Upgrade test',$2,'active')",[tenant,schema]);
  await db.query("INSERT INTO users(id,tenant_id,name,email,password_hash,role) VALUES($1,$2,'Owner',$3,'unused','owner')",[owner,tenant,schema+'@example.test']);
  await db.query("INSERT INTO cameras(id,tenant_id,name) VALUES($1,$2,'Existing camera')",[camera,tenant]);
  await db.query("INSERT INTO processes(id,tenant_id,name,steps,camera_id) VALUES($1,$2,'Existing process','[\"Working\"]',$3)",[processID,tenant,camera]);
  url.searchParams.set('options','-c search_path='+schema+',public');
  const bridgePort=await port(),newPort=await port();
  const env={...process.env,DATABASE_URL:url.toString(),DB_SSL:'disable',JWT_SECRET:secret,BOOTSTRAP_ADMIN_EMAIL:'',BOOTSTRAP_ADMIN_PASSWORD:'',MEDIA_UPSTREAM_URL:'',RESEND_API_KEY:'',EMAIL_FROM:'',NODE_ENV:'production'};
  const bridgeBase='http://127.0.0.1:'+bridgePort,newBase='http://127.0.0.1:'+newPort;
  const wait=async(base,release)=>{for(let i=0;i<100;i++){try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(1000)});const j=await r.json();assert.equal(r.status,200);assert.equal(j.release,release);return}catch{await sleep(100)}}throw new Error('Deployment did not become healthy: '+release)};
  const request=async(base,path,method='GET',body)=>{const r=await fetch(base+'/api'+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});return {status:r.status,data:await r.json()}};
  const create=async(base,reference)=>{const r=await request(base,'/orders/quick','POST',{reference,process_id:processID});assert.equal(r.status,201,r.data.error);return r.data};
  const move=async(base,order,action)=>{const r=await request(base,'/orders/'+order.id+'/transition','POST',{action});assert.equal(r.status,200,r.data.error);return r};
  start('src/server.js',resolve(process.env.LEGACY_BRIDGE_ROOT),{...env,PORT:String(bridgePort),PUBLIC_BASE_URL:bridgeBase});
  await wait(bridgeBase,'schema-bridge');
  const before=await create(bridgeBase,'Before upgrade');await move(bridgeBase,before,'start');await move(bridgeBase,before,'pause');
  assert.equal((await db.query('SELECT count(*)::int n FROM recordings')).rows[0].n,1);
  start('src/start.js',resolve('.'),{...env,PORT:String(newPort),PUBLIC_BASE_URL:newBase,NEXTVISION_BUILD_REVISION:'1234567890abcdef'});
  await wait(newBase,'portal-operations');
  assert.equal((await db.query('SELECT count(*)::int n FROM nextvision_schema_migrations')).rows[0].n,19);
  assert.equal((await db.query('SELECT process_snapshot->>\'name\' name FROM orders WHERE id=$1',[before.id])).rows[0].name,'Existing process');
  // The prior bridge is still serving during Render's rolling transition.
  const during=await create(bridgeBase,'Bridge after schema upgrade');await move(bridgeBase,during,'start');
  await move(bridgeBase,during,'pause');
  const fresh=await create(newBase,'New API');await move(newBase,fresh,'start');await move(newBase,fresh,'pause');await move(newBase,fresh,'resume');
  assert.equal((await db.query('SELECT count(*)::int n FROM recordings WHERE order_id=$1',[fresh.id])).rows[0].n,2);
  const orders=await request(newBase,'/orders');assert.equal(orders.status,200);assert.equal(orders.data.length,3);
  const home=await fetch(newBase+'/loja.html');assert.equal(home.status,200);assert.ok((await home.text()).includes('store.js'));
  // Startup migrations must be repeatable even after several visits exist.
  const rerun=start('src/migrate.js',resolve('.'),env);const [code]=await once(rerun,'exit');assert.equal(code,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM recordings WHERE order_id=$1',[fresh.id])).rows[0].n,2);
 }finally{
  for(const p of children.reverse())if(p.exitCode===null&&p.signalCode===null){p.kill('SIGTERM');await Promise.race([once(p,'exit'),sleep(2000)]);if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await once(p,'exit')}}
  await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await db.end();
 }
});
