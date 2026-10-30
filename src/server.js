import 'dotenv/config';
import {storeProfiles} from './store-profile.js';
import express from 'express';import helmet from 'helmet';import rateLimit from 'express-rate-limit';import jwt from 'jsonwebtoken';import bcrypt from 'bcryptjs';import crypto from 'node:crypto';import {z} from 'zod';import {q,db} from './db.js';
const slugFromName=name=>String(name).replace(/@/g,'a').replace(/&/g,'e').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,60);
const app=express();app.set('trust proxy',1);app.disable('x-powered-by');app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'400kb'}));
const secret=process.env.JWT_SECRET;if(!secret||secret.length<32)throw Error('Configure JWT_SECRET com 32+ caracteres');
const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const bad=(res,status,message)=>res.status(status).json({error:message});
const valid=(schema,req,res)=>{const p=schema.safeParse(req.body);if(!p.success){bad(res,400,'Dados inválidos');return null;}return p.data;};
const uuid=z.string().uuid();
const auth=(req,res,next)=>{
 try{const token=/^Bearer (.+)$/i.exec(req.get('authorization')||'')?.[1];if(!token)return bad(res,401,'Não autenticado');req.user=jwt.verify(token,secret,{algorithms:['HS256']});}
 catch{return bad(res,401,'Sessão inválida');}
 q('SELECT u.active,u.role,u.tenant_id,t.status FROM users u LEFT JOIN tenants t ON t.id=u.tenant_id WHERE u.id=$1',[req.user.id]).then(({rows})=>{
  const user=rows[0];if(!user?.active||user.role!==req.user.role||user.tenant_id!==req.user.tenant_id)return bad(res,403,'Conta sem autorização');
  if(['owner','operator'].includes(user.role)&&!['trial','active'].includes(user.status))return bad(res,403,'Acesso da loja bloqueado. Entre em contato com a central.');
  next();
 }).catch(next);
};

const roles=(...allow)=>(req,res,next)=>allow.includes(req.user.role)?next():bad(res,403,'Sem permissão');
const tid=req=>req.user.tenant_id;
const cameraForStep=(mapping,defaultCamera,index)=>Object.hasOwn(mapping||{},String(index))?mapping[String(index)]:defaultCamera||null;
const nicheSchema=z.enum(Object.keys(storeProfiles));
const digitsOnly=v=>typeof v==='string'?v.replace(/\D/g,''):v;
const validCpf=c=>{if(!/^\d{11}$/.test(c)||/^(\d)\1{10}$/.test(c))return false;const d=n=>{let s=0;for(let i=0;i<n;i++)s+=Number(c[i])*(n+1-i);const r=(s*10)%11;return r===10?0:r};return d(9)===Number(c[9])&&d(10)===Number(c[10])};
const cpfField=z.preprocess(digitsOnly,z.union([z.literal(''),z.string().refine(validCpf,'CPF inválido')]).optional());
const birthField=z.union([z.literal(''),z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional();
const cepField=z.preprocess(digitsOnly,z.union([z.literal(''),z.string().regex(/^\d{8}$/,'CEP inválido')]).optional());
const orderDetails=z.object({item_type:z.enum(['vehicle','device','pet','other']).default('other'),device_kind:z.string().trim().max(40).default(''),brand:z.string().trim().max(80).default(''),model:z.string().trim().max(120).default(''),identifier:z.string().trim().max(100).default(''),color:z.string().trim().max(60).default(''),pet_name:z.string().trim().max(80).default(''),species:z.string().trim().max(40).default(''),breed:z.string().trim().max(80).default(''),size:z.string().trim().max(40).default(''),service:z.string().trim().max(300).default(''),notes:z.string().trim().max(2000).default('')}).strict();
async function notifyOrder(orderId,action){if(!process.env.RESEND_API_KEY||!process.env.EMAIL_FROM)return;const r=await q("SELECT t.name store,t.email_notifications mode,c.email,o.process_snapshot->>'name' process,o.process_snapshot->'steps' steps,o.step_index,o.status FROM orders o JOIN tenants t ON t.id=o.tenant_id JOIN customers c ON c.id=o.customer_id JOIN processes p ON p.id=o.process_id WHERE o.id=$1",[orderId]);const d=r.rows[0];if(!d?.email||d.mode==='off')return;const isEnd=action==='complete';if(!(d.mode==='all'||(d.mode==='steps'&&action==='advance')||(d.mode==='completed'&&isEnd)))return;const subject=isEnd?'Seu serviço foi concluído':action==='advance'?'Seu serviço avançou de etapa':'Atualização do seu serviço';const step=d.steps[d.step_index]||'Concluído';const message=String(d.store)+' — '+String(d.process)+': '+(isEnd?'Serviço concluído.':'Etapa atual: '+step+'.');const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.EMAIL_FROM,to:[d.email],subject,text:message})});if(!response.ok)throw Error('Provedor de e-mail recusou a solicitação (HTTP '+response.status+')');}
const audit=(req,action,type,id,tenant=tid(req))=>q('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',[tenant,req.user.id,action,type,id]);
app.get('/health',(_req,res)=>{res.set('Cache-Control','no-store');const revision=process.env.RENDER_GIT_COMMIT||process.env.NEXTVISION_BUILD_REVISION||'';res.json({ok:true,service:'nextvision',release:/^[a-z0-9-]{1,40}$/.test(process.env.NEXTVISION_RELEASE||'')?process.env.NEXTVISION_RELEASE:'portal-operations',revision:/^[a-f0-9]{7,40}$/i.test(revision)?revision:'development'});});
app.post('/api/auth/login',rateLimit({windowMs:900000,limit:12,standardHeaders:'draft-7',legacyHeaders:false}),route(async(req,res)=>{const v=valid(z.object({email:z.string().email(),password:z.string().min(1)}),req,res);if(!v)return;const {rows}=await q('SELECT id,tenant_id,name,email,password_hash,role FROM users WHERE lower(email)=lower($1) AND active=true',[v.email]);const u=rows[0];if(!u||!(await bcrypt.compare(v.password,u.password_hash)))return bad(res,401,'Credenciais inválidas');if(!['master','technician'].includes(u.role)){const r=await q("SELECT status FROM tenants WHERE id=$1",[u.tenant_id]);if(!r.rows.length||!['trial','active'].includes(r.rows[0].status))return bad(res,403,'Loja indisponível');}const token=jwt.sign({id:u.id,tenant_id:u.tenant_id,role:u.role},secret,{algorithm:'HS256',expiresIn:'8h'});res.json({token,user:{id:u.id,name:u.name,email:u.email,role:u.role,tenant_id:u.tenant_id}});}));
app.get('/api/me',auth,(req,res)=>res.json(req.user));

const digestToken=value=>crypto.createHash('sha256').update(value).digest('hex');
const deviceAuth=route(async(req,res,next)=>{
 const raw=/^Bearer (nvdev_[a-f0-9]{64})$/i.exec(req.get('authorization')||'')?.[1];
 if(!raw)return bad(res,401,'Dispositivo não autenticado');
 const result=await q("SELECT d.id,d.tenant_id,d.name,d.enabled,d.revoked_at,t.status tenant_status FROM shop_devices d JOIN tenants t ON t.id=d.tenant_id WHERE d.credential_hash=$1",[digestToken(raw)]);
 if(!result.rowCount||!result.rows[0].enabled||result.rows[0].revoked_at||!['trial','active'].includes(result.rows[0].tenant_status))return bad(res,403,'Dispositivo bloqueado');
 req.device=result.rows[0];next();
});
app.post('/api/master/tenants/:id/activation-codes',auth,roles('master'),rateLimit({windowMs:60000,limit:20}),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'Loja inválida');
 const store=await q("SELECT id,status FROM tenants WHERE id=$1",[req.params.id]);
 if(!store.rowCount)return bad(res,404,'Loja não encontrada');
 if(!['trial','active'].includes(store.rows[0].status))return bad(res,409,'Loja bloqueada');
 const code='NV-'+crypto.randomBytes(16).toString('hex').toUpperCase();
 const result=await q("INSERT INTO shop_activation_codes(tenant_id,code_hash,expires_at,created_by) VALUES($1,$2,now()+interval '30 minutes',$3) RETURNING id,expires_at",[req.params.id,digestToken(code),req.user.id]);
 await audit(req,'issue_activation','shop_device',result.rows[0].id,req.params.id);
 res.set('Cache-Control','no-store');res.status(201).json({activation_code:code,expires_at:result.rows[0].expires_at,tenant_id:req.params.id});
}));
app.post('/api/connect/activate',rateLimit({windowMs:15*60000,limit:12,standardHeaders:'draft-7',legacyHeaders:false}),route(async(req,res)=>{
 const v=valid(z.object({activation_code:z.string().regex(/^NV-[A-F0-9]{32}$/),device_name:z.string().trim().min(2).max(120)}),req,res);if(!v)return;
 const client=await db.connect();try{
  await client.query('BEGIN');
  const code=await client.query("SELECT a.id,a.tenant_id,t.status FROM shop_activation_codes a JOIN tenants t ON t.id=a.tenant_id WHERE a.code_hash=$1 AND a.used_at IS NULL AND a.expires_at>now() FOR UPDATE OF a",[digestToken(v.activation_code)]);
  if(!code.rowCount||!['trial','active'].includes(code.rows[0].status)){await client.query('ROLLBACK');return bad(res,403,'Código expirado, inválido ou loja bloqueada')}
  const credential='nvdev_'+crypto.randomBytes(32).toString('hex');
  const d=await client.query("INSERT INTO shop_devices(tenant_id,name,credential_hash,activation_id) VALUES($1,$2,$3,$4) RETURNING id,tenant_id,name,enabled",[code.rows[0].tenant_id,v.device_name,digestToken(credential),code.rows[0].id]);
  await client.query("UPDATE shop_activation_codes SET used_at=now() WHERE id=$1",[code.rows[0].id]);
  await client.query('COMMIT');
  res.set('Cache-Control','no-store');res.status(201).json({...d.rows[0],device_token:credential});
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}));
app.get('/api/connect/status',deviceAuth,route(async(req,res)=>{
 await q("UPDATE shop_devices SET last_seen_at=now() WHERE id=$1",[req.device.id]);
 res.set('Cache-Control','no-store');res.json({device_id:req.device.id,tenant_id:req.device.tenant_id,enabled:true,tenant_status:req.device.tenant_status,heartbeat_seconds:30});
}));
app.patch('/api/master/tenants/:id/cameras/:cameraId/device',auth,roles('master'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'Loja inválida');
 return editCamera(req,res,req.params.cameraId,req.params.id);
}));
app.get('/api/connect/cameras',deviceAuth,route(async(req,res)=>{
 const result=await q('SELECT id,name,station,enabled,stream_path,config_version FROM cameras WHERE tenant_id=$1 AND device_id=$2 AND deleted_at IS NULL ORDER BY created_at,id',[req.device.tenant_id,req.device.id]);
 const legacy=process.env.LIVE_CAMERA_ID;
 res.set('Cache-Control','no-store');res.json({mode:legacy?'legacy_single_camera':process.env.MEDIA_MULTI_CAMERA_ENABLED==='true'?'central_media':'unconfigured',cameras:result.rows.map(camera=>({...camera,stream_path:legacy===camera.id?'camera':camera.stream_path}))});
}));
app.get('/api/connect/recording-jobs',deviceAuth,route(async(req,res)=>{
 await q("UPDATE shop_devices SET last_seen_at=now() WHERE id=$1",[req.device.id]);
 const jobs=await q(`SELECT r.id recording_id,r.order_id,r.step_index,r.visit_index,r.camera_id,r.status,r.started_at,r.ended_at,
 o.status order_status,o.step_index current_step
 FROM recordings r JOIN orders o ON o.id=r.order_id AND o.tenant_id=r.tenant_id
 JOIN cameras ca ON ca.id=r.camera_id AND ca.tenant_id=r.tenant_id
 WHERE r.tenant_id=$1 AND ((r.status='finalizing' AND COALESCE(r.device_id,ca.device_id)=$2) OR (r.status IN ('pending','recording','paused') AND ca.device_id=$2 AND ca.enabled AND ca.deleted_at IS NULL))
 ORDER BY r.id LIMIT 100`,[req.device.tenant_id,req.device.id]);
 res.set('Cache-Control','no-store');res.json({device_id:req.device.id,tenant_id:req.device.tenant_id,poll_seconds:5,jobs:jobs.rows});
}));
app.post('/api/connect/recording-jobs/:id/event',deviceAuth,route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'Gravação inválida');
 const v=valid(z.object({event:z.enum(['started','stopped','failed']),error:z.string().max(300).optional()}),req,res);if(!v)return;
 const connection=await db.connect();try{
  await connection.query('BEGIN');
  const r=await connection.query(`SELECT r.id,r.status,r.order_id,r.step_index,r.ended_at,ca.enabled camera_enabled,ca.deleted_at camera_deleted_at,o.status order_status,o.step_index current_step
  FROM recordings r JOIN cameras ca ON ca.id=r.camera_id AND ca.tenant_id=r.tenant_id
  JOIN orders o ON o.id=r.order_id AND o.tenant_id=r.tenant_id
  WHERE r.id=$1 AND r.tenant_id=$2 AND (CASE WHEN r.status='finalizing' THEN COALESCE(r.device_id,ca.device_id)=$3 ELSE ca.device_id=$3 END) FOR UPDATE OF r`,[req.params.id,req.device.tenant_id,req.device.id]);
  if(!r.rowCount){await connection.query('ROLLBACK');return bad(res,404,'Gravação não encontrada')}
  const job=r.rows[0];
  const allowed=v.event==='started'?job.status==='pending'&&job.camera_enabled&&!job.camera_deleted_at&&job.order_status==='live'&&job.current_step===job.step_index:
    v.event==='stopped'?['finalizing','paused'].includes(job.status):
    ['pending','recording','finalizing','paused'].includes(job.status);
  if(!allowed){await connection.query('ROLLBACK');return bad(res,409,'Evento incompatível com o estado atual')}
  const target=v.event==='started'?'recording':v.event==='failed'?'failed':job.status==='paused'?'paused':'upload_pending';
  const updated=await connection.query("UPDATE recordings SET status=$1,started_at=CASE WHEN $1='recording' THEN COALESCE(started_at,now()) ELSE started_at END,ended_at=CASE WHEN $1 IN ('upload_pending','failed') THEN COALESCE(ended_at,now()) ELSE ended_at END,error_message=CASE WHEN $1='failed' THEN $3 ELSE NULL END,device_id=$4,updated_at=now() WHERE id=$2 RETURNING id,status,started_at,ended_at",[target,job.id,v.error||null,req.device.id]);
  await connection.query('COMMIT');res.json(updated.rows[0]);
 }catch(e){await connection.query('ROLLBACK');throw e}finally{connection.release()}
}));
app.get('/api/master/tenants/:id/devices',auth,roles('master'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'Loja inválida');
 res.json((await q("SELECT id,tenant_id,name,enabled,created_at,last_seen_at,revoked_at FROM shop_devices WHERE tenant_id=$1 ORDER BY created_at DESC",[req.params.id])).rows);
}));
app.patch('/api/master/tenants/:id/devices/:deviceId',auth,roles('master'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success||!uuid.safeParse(req.params.deviceId).success)return bad(res,400,'ID inválido');
 const v=valid(z.object({enabled:z.boolean()}),req,res);if(!v)return;
 const result=await q("UPDATE shop_devices SET enabled=$1 WHERE id=$2 AND tenant_id=$3 AND revoked_at IS NULL RETURNING id,tenant_id,name,enabled,last_seen_at",[v.enabled,req.params.deviceId,req.params.id]);
 if(!result.rowCount)return bad(res,404,'Dispositivo não encontrado');
 await audit(req,v.enabled?'enable':'disable','shop_device',req.params.deviceId,req.params.id);
 res.json(result.rows[0]);
}));
app.post('/api/master/tenants/:id/devices/:deviceId/revoke',auth,roles('master'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success||!uuid.safeParse(req.params.deviceId).success)return bad(res,400,'ID inválido');
 const result=await q("UPDATE shop_devices SET enabled=false,revoked_at=now() WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL RETURNING id,tenant_id,enabled,revoked_at",[req.params.deviceId,req.params.id]);
 if(!result.rowCount)return bad(res,404,'Dispositivo não encontrado');
 await audit(req,'revoke','shop_device',req.params.deviceId,req.params.id);res.json(result.rows[0]);
}));
app.get('/api/master/diagnostics',auth,roles('master'),route(async(req,res)=>{const r=await q("SELECT current_database() database, current_schema() schema, (SELECT count(*)::int FROM users) users_count, (SELECT count(*)::int FROM tenants) tenants_count, (SELECT count(*)::int FROM users WHERE role='master') masters_count");res.set('Cache-Control','no-store');res.json(r.rows[0]);}));
app.get('/api/master/tenants',auth,roles('master'),route(async(req,res)=>res.json((await q('SELECT t.*,(SELECT count(*)::int FROM cameras c WHERE c.tenant_id=t.id AND c.deleted_at IS NULL) cameras_count FROM tenants t ORDER BY created_at DESC')).rows)));
app.post('/api/master/tenants',auth,roles('master'),route(async(req,res)=>{
 const v=valid(z.object({name:z.string().trim().min(2).max(120),slug:z.string().regex(/^[a-z0-9-]{3,60}$/),retention_days:z.number().int().min(1).max(365).default(15),niche:nicheSchema.default('general'),camera_limit:z.number().int().min(1).max(128).default(1)}),req,res);if(!v)return;
 const c=await db.connect();try{
  await c.query('BEGIN');
  const r=await c.query('INSERT INTO tenants(name,slug,retention_days,niche,camera_limit) VALUES($1,$2,$3,$4,$5) RETURNING *',[v.name,v.slug,v.retention_days,v.niche,v.camera_limit]);await c.query('INSERT INTO tenant_slugs(slug,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[v.slug,r.rows[0].id]);
  const store=r.rows[0],profile=storeProfiles[v.niche];
  await c.query('INSERT INTO processes(tenant_id,name,steps) VALUES($1,$2,$3)',[store.id,profile.label,JSON.stringify(profile.steps)]);
  await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',[store.id,req.user.id,'create','tenant',store.id]);
  await c.query('COMMIT');res.status(201).json(store);
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));
app.patch('/api/master/tenants/:id',auth,roles('master'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');
 const v=valid(z.object({status:z.enum(['trial','active','past_due','suspended']).optional(),niche:nicheSchema.optional(),camera_limit:z.number().int().min(1).max(128).optional()}).strict().refine(v=>v.status!==undefined||v.niche!==undefined||v.camera_limit!==undefined),req,res);if(!v)return;
 const r=await q('UPDATE tenants SET status=COALESCE($1,status),niche=COALESCE($2,niche),camera_limit=COALESCE($3,camera_limit) WHERE id=$4 RETURNING *',[v.status||null,v.niche||null,v.camera_limit??null,req.params.id]);
 if(!r.rowCount)return bad(res,404,'Loja não encontrada');await audit(req,'update','tenant',req.params.id,req.params.id);res.json(r.rows[0]);
}));
app.post('/api/master/tenants/:id/users',auth,roles('master'),route(async(req,res)=>{if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');const v=valid(z.object({name:z.string().min(2),email:z.string().email(),password:z.string().min(12),role:z.enum(['owner','operator']).default('owner')}),req,res);if(!v)return;const exists=await q('SELECT id FROM tenants WHERE id=$1',[req.params.id]);if(!exists.rowCount)return bad(res,404,'Loja não encontrada');const r=await q('INSERT INTO users(tenant_id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role',[req.params.id,v.name,v.email.toLowerCase(),await bcrypt.hash(v.password,12),v.role]);await audit(req,'create','user',r.rows[0].id,req.params.id);res.status(201).json(r.rows[0]);}));
app.get('/api/master/technicians',auth,roles('master'),route(async(req,res)=>{
 const r=await q("SELECT u.id,u.name,u.email,u.active,count(a.id)::int assignments FROM users u LEFT JOIN technician_assignments a ON a.technician_id=u.id WHERE u.role='technician' GROUP BY u.id ORDER BY u.name");
 res.json(r.rows);
}));
app.post('/api/master/technicians',auth,roles('master'),route(async(req,res)=>{
 const v=valid(z.object({name:z.string().trim().min(2).max(120),email:z.string().email(),password:z.string().min(12)}),req,res);if(!v)return;
 const r=await q("INSERT INTO users(tenant_id,name,email,password_hash,role) VALUES(NULL,$1,$2,$3,'technician') RETURNING id,name,email,role",[v.name,v.email.toLowerCase(),await bcrypt.hash(v.password,12)]);res.status(201).json(r.rows[0]);
}));
app.post('/api/master/technicians/:id/assignments',auth,roles('master'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');
 const v=valid(z.object({tenant_id:uuid,notes:z.string().max(500).default('')}),req,res);if(!v)return;
 const r=await q("INSERT INTO technician_assignments(technician_id,tenant_id,notes) SELECT $1,t.id,$3 FROM tenants t WHERE t.id=$2 AND EXISTS(SELECT 1 FROM users u WHERE u.id=$1 AND u.role='technician' AND u.active=true) ON CONFLICT(technician_id,tenant_id) DO UPDATE SET status='assigned',notes=EXCLUDED.notes,completed_at=NULL RETURNING id,status",[req.params.id,v.tenant_id,v.notes]);
 if(!r.rowCount)return bad(res,404,'Técnico ou loja não encontrado');res.status(201).json(r.rows[0]);
}));
app.get('/api/technician/assignments',auth,roles('technician'),route(async(req,res)=>{
 const r=await q("SELECT a.id,a.status,a.notes,a.created_at,a.completed_at,t.id tenant_id,t.name store,t.slug,t.camera_limit,(SELECT count(*)::int FROM cameras c WHERE c.tenant_id=t.id AND c.deleted_at IS NULL) camera_count FROM technician_assignments a JOIN tenants t ON t.id=a.tenant_id WHERE a.technician_id=$1 AND a.status!='cancelled' ORDER BY a.created_at DESC",[req.user.id]);res.json(r.rows);
}));
app.get('/api/technician/assignments/:id/cameras',auth,roles('technician'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');
 const r=await q("SELECT c.id,c.name,c.station,c.status,c.enabled,c.created_at FROM cameras c JOIN technician_assignments a ON a.tenant_id=c.tenant_id WHERE a.id=$1 AND a.technician_id=$2 AND c.deleted_at IS NULL AND a.status IN ('assigned','in_progress','completed') ORDER BY c.created_at",[req.params.id,req.user.id]);res.json(r.rows);
}));
app.post('/api/technician/assignments/:id/cameras',auth,roles('technician'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');
 const v=valid(z.object({name:z.string().trim().min(2).max(120),station:z.string().trim().max(120).default('')}),req,res);if(!v)return;
 const r=await q("INSERT INTO cameras(tenant_id,name,station) SELECT a.tenant_id,$3,$4 FROM technician_assignments a WHERE a.id=$1 AND a.technician_id=$2 AND a.status IN ('assigned','in_progress') RETURNING id,name,station,status",[req.params.id,req.user.id,v.name,v.station]);
 if(!r.rowCount)return bad(res,403,'Instalação não autorizada');const camera=r.rows[0];const owner=(await q('SELECT tenant_id FROM cameras WHERE id=$1',[camera.id])).rows[0];await audit(req,'create','camera',camera.id,owner.tenant_id);res.status(201).json(camera);
}));
async function technicianCameraScope(req,res,remove=false){
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'Instalação inválida');
 const scope=await q("SELECT tenant_id FROM technician_assignments WHERE id=$1 AND technician_id=$2 AND status IN ('assigned','in_progress')",[req.params.id,req.user.id]);
 if(!scope.rowCount)return bad(res,403,'Instalação não autorizada');
 return editCamera(req,res,req.params.camera,scope.rows[0].tenant_id,remove);
}
app.patch('/api/technician/assignments/:id/cameras/:camera',auth,roles('technician'),route((req,res)=>technicianCameraScope(req,res)));
app.delete('/api/technician/assignments/:id/cameras/:camera',auth,roles('technician'),route((req,res)=>technicianCameraScope(req,res,true)));
app.patch('/api/technician/assignments/:id',auth,roles('technician'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');
 const v=valid(z.object({status:z.enum(['in_progress','completed'])}),req,res);if(!v)return;
 const r=await q("UPDATE technician_assignments SET status=$1,completed_at=CASE WHEN $1='completed' THEN now() ELSE NULL END WHERE id=$2 AND technician_id=$3 AND status IN ('assigned','in_progress') RETURNING id,status",[v.status,req.params.id,req.user.id]);
 if(!r.rowCount)return bad(res,409,'Instalação não disponível');res.json(r.rows[0]);
}));
app.get('/api/master/invoices',auth,roles('master'),route(async(req,res)=>res.json((await q('SELECT i.*,t.name tenant_name FROM invoices i JOIN tenants t ON t.id=i.tenant_id ORDER BY i.created_at DESC')).rows)));
app.get('/api/public/contact',rateLimit({windowMs:60000,limit:60}),route(async(_req,res)=>{const r=await q('SELECT sales_whatsapp FROM platform_settings WHERE id=true');res.set('Cache-Control','public, max-age=300');res.json({sales_whatsapp:r.rows[0]?.sales_whatsapp||''});}));
app.get('/api/master/overview',auth,roles('master'),route(async(_req,res)=>{
 const r=await q(`SELECT t.id,t.name,t.slug,t.niche,t.status,t.camera_limit,t.created_at,
  (SELECT count(*)::int FROM cameras c WHERE c.tenant_id=t.id AND c.deleted_at IS NULL) cameras,
  (SELECT count(*)::int FROM shop_devices d WHERE d.tenant_id=t.id AND d.revoked_at IS NULL) devices,
  (SELECT count(*)::int FROM shop_devices d WHERE d.tenant_id=t.id AND d.revoked_at IS NULL AND d.enabled AND d.last_seen_at > now() - interval '3 minutes') devices_online,
  (SELECT max(d.last_seen_at) FROM shop_devices d WHERE d.tenant_id=t.id AND d.revoked_at IS NULL) last_seen_at,
  (SELECT count(*)::int FROM orders o WHERE o.tenant_id=t.id AND o.deleted_at IS NULL AND o.created_at >= date_trunc('day', now() AT TIME ZONE 'America/Fortaleza') AT TIME ZONE 'America/Fortaleza') orders_today,
  (SELECT count(*)::int FROM orders o WHERE o.tenant_id=t.id AND o.deleted_at IS NULL AND o.status='live') orders_live,
  (SELECT max(o.created_at) FROM orders o WHERE o.tenant_id=t.id AND o.deleted_at IS NULL) last_order_at,
  (SELECT i.status FROM invoices i WHERE i.tenant_id=t.id ORDER BY i.due_date DESC LIMIT 1) last_invoice_status,
  (SELECT i.due_date FROM invoices i WHERE i.tenant_id=t.id ORDER BY i.due_date DESC LIMIT 1) last_invoice_due
  FROM tenants t ORDER BY t.created_at DESC`);
 res.json(r.rows);
}));
app.get('/api/master/stats',auth,roles('master'),route(async(req,res)=>{
 const r=await q(`SELECT count(*)::int tenants,
 count(*) FILTER(WHERE t.status='active')::int active_tenants,
 count(*) FILTER(WHERE t.status='trial')::int trial_tenants,
 count(*) FILTER(WHERE t.status='suspended')::int blocked_tenants,
 count(*) FILTER(WHERE t.status='past_due' OR EXISTS(SELECT 1 FROM invoices i WHERE i.tenant_id=t.id AND (i.status='overdue' OR (i.status='open' AND i.due_date<current_date))))::int delinquent_tenants,
 count(*) FILTER(WHERE t.status='active' AND EXISTS(SELECT 1 FROM invoices i WHERE i.tenant_id=t.id AND i.status='paid') AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.tenant_id=t.id AND (i.status='overdue' OR (i.status='open' AND i.due_date<current_date))))::int paid_tenants,
 (SELECT count(*)::int FROM cameras WHERE deleted_at IS NULL) cameras,
 (SELECT count(*)::int FROM invoices WHERE status='overdue' OR (status='open' AND due_date<current_date)) overdue_invoices
 FROM tenants t`);res.json({...r.rows[0],billing_automation_configured:false});
}));
app.get('/api/master/settings',auth,roles('master'),route(async(_req,res)=>res.json((await q('SELECT sales_whatsapp FROM platform_settings WHERE id=true')).rows[0])));
app.put('/api/master/settings',auth,roles('master'),route(async(req,res)=>{
 const v=valid(z.object({sales_whatsapp:z.string().regex(/^(?:[0-9]{10,15})?$/)}).strict(),req,res);if(!v)return;
 const result=await q('UPDATE platform_settings SET sales_whatsapp=$1 WHERE id=true RETURNING sales_whatsapp',[v.sales_whatsapp]);await audit(req,'update','platform_settings',null,null);res.json(result.rows[0]);
}));
app.get('/api/store/settings',auth,roles('owner','operator'),route(async(req,res)=>{
 const r=await q('SELECT t.name,t.slug,t.logo_url,t.email_notifications,t.niche,t.ready_message,t.camera_limit,t.city,t.state,t.message_templates,(SELECT count(*)::int FROM cameras c WHERE c.tenant_id=t.id AND c.deleted_at IS NULL) camera_count,(SELECT sales_whatsapp FROM platform_settings WHERE id=true) sales_whatsapp FROM tenants t WHERE t.id=$1',[tid(req)]);
 const store=r.rows[0]||{},profile=storeProfiles[store.niche]||storeProfiles.general;res.json({...store,niche_label:profile.label,default_item_type:profile.itemType,short_link_base:process.env.SHORT_LINK_BASE_URL||''});
}));
app.patch('/api/store/location',auth,roles('owner'),route(async(req,res)=>{const v=valid(z.object({city:z.string().trim().max(80),state:z.union([z.literal(''),z.string().regex(/^[A-Z]{2}$/)])}).strict(),req,res);if(!v)return;const r=await q('UPDATE tenants SET city=$1,state=$2 WHERE id=$3 RETURNING city,state',[v.city||null,v.state||null,tid(req)]);await audit(req,'update','tenant_location',tid(req));res.json(r.rows[0]);}));
app.patch('/api/store/message-templates',auth,roles('owner'),route(async(req,res)=>{const t=z.string().trim().max(1000);const v=valid(z.object({created:t,started:t,advanced:t,paused:t}).partial().strict(),req,res);if(!v)return;const r=await q("UPDATE tenants SET message_templates=message_templates || $1::jsonb WHERE id=$2 RETURNING message_templates",[JSON.stringify(v),tid(req)]);await audit(req,'update','tenant_messages',tid(req));res.json(r.rows[0]);}));
app.patch('/api/store/settings',auth,roles('owner'),route(async(req,res)=>{const v=valid(z.object({name:z.string().min(2).max(120),logo_url:z.union([z.string().url().startsWith('https://').max(1000),z.literal('')]),email_notifications:z.enum(['off','steps','completed','all'])}).strict(),req,res);if(!v)return;
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const current=(await c.query('SELECT name,slug FROM tenants WHERE id=$1 FOR UPDATE',[tid(req)])).rows[0];
  let slug=current.slug;
  if(current.name!==v.name){
   const base=slugFromName(v.name);
   if(base.length>=3){
    for(let n=1;n<100;n++){const candidate=n===1?base:base.slice(0,58)+n;const owner=await c.query('SELECT tenant_id FROM tenant_slugs WHERE slug=$1',[candidate]);const other=await c.query('SELECT 1 FROM tenants WHERE slug=$1 AND id<>$2',[candidate,tid(req)]);if((!owner.rowCount||owner.rows[0].tenant_id===tid(req))&&!other.rowCount){slug=candidate;break;}}
    await c.query('INSERT INTO tenant_slugs(slug,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[slug,tid(req)]);
   }
  }
  const r=await c.query('UPDATE tenants SET name=$1,slug=$2,logo_url=$3,email_notifications=$4 WHERE id=$5 RETURNING name,slug,logo_url,email_notifications',[v.name,slug,v.logo_url||null,v.email_notifications,tid(req)]);
  await c.query('COMMIT');
  await audit(req,'update','tenant_settings',tid(req));res.json(r.rows[0]);
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));
app.patch('/api/store/messages',auth,roles('owner'),route(async(req,res)=>{
 const v=valid(z.object({ready_message:z.string().trim().min(10).max(1000)}).strict(),req,res);if(!v)return;
 const r=await q('UPDATE tenants SET ready_message=$1 WHERE id=$2 RETURNING ready_message',[v.ready_message,tid(req)]);
 await audit(req,'update','store_messages',tid(req));res.json(r.rows[0]);
}));
app.get('/api/store/loyalty',auth,roles('owner','operator'),route(async(req,res)=>{
 const r=await q('SELECT loyalty_enabled,loyalty_target,loyalty_reward FROM tenants WHERE id=$1',[tid(req)]);
 res.json(r.rows[0]||{loyalty_enabled:false,loyalty_target:10,loyalty_reward:''});
}));
app.patch('/api/store/loyalty',auth,roles('owner'),route(async(req,res)=>{
 const v=valid(z.object({loyalty_enabled:z.boolean(),loyalty_target:z.number().int().min(2).max(100),loyalty_reward:z.string().trim().min(3).max(240)}),req,res);if(!v)return;
 const r=await q('UPDATE tenants SET loyalty_enabled=$1,loyalty_target=$2,loyalty_reward=$3 WHERE id=$4 RETURNING loyalty_enabled,loyalty_target,loyalty_reward',[v.loyalty_enabled,v.loyalty_target,v.loyalty_reward,tid(req)]);
 await audit(req,'update','loyalty_settings',tid(req));res.json(r.rows[0]);
}));
app.get('/api/store/loyalty/customers',auth,roles('owner','operator'),route(async(req,res)=>{
 const r=await q('SELECT c.id,c.name,count(l.id)::int checkins FROM customers c LEFT JOIN loyalty_checkins l ON l.customer_id=c.id AND l.tenant_id=c.tenant_id WHERE c.tenant_id=$1 GROUP BY c.id,c.name ORDER BY c.name',[tid(req)]);res.json(r.rows);
}));

const baseUrl=()=>process.env.PUBLIC_BASE_URL||'http://localhost:3000';
app.get('/api/store/logo',auth,roles('owner','operator'),route(async(req,res)=>{
 const r=await q('SELECT mime_type,image_data FROM tenant_logos WHERE tenant_id=$1',[tid(req)]);
 if(!r.rowCount)return bad(res,404,'Logo não cadastrado');
 res.type(r.rows[0].mime_type).set('Cache-Control','private, max-age=300').send(r.rows[0].image_data);
}));
app.put('/api/store/logo',auth,roles('owner'),route(async(req,res)=>{
 const v=valid(z.object({mime_type:z.enum(['image/png','image/jpeg','image/webp']),base64:z.string().min(10).max(360000)}),req,res);if(!v)return;
 const bin=Buffer.from(v.base64,'base64');
 if(bin.length>262144||bin.length===0||bin.toString('base64').replace(/=+$/,'')!==v.base64.replace(/=+$/,''))return bad(res,400,'Imagem inválida ou maior que 256 KB');
 const signatures={'image/png':bin.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'image/jpeg':bin[0]===255&&bin[1]===216&&bin[2]===255,'image/webp':bin.toString('ascii',0,4)==='RIFF'&&bin.toString('ascii',8,12)==='WEBP'};
 if(!signatures[v.mime_type])return bad(res,400,'Formato de imagem inválido');
 await q('INSERT INTO tenant_logos(tenant_id,mime_type,image_data) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET mime_type=EXCLUDED.mime_type,image_data=EXCLUDED.image_data,updated_at=now()',[tid(req),v.mime_type,bin]);
 const logoUrl=baseUrl()+'/api/public/store-logo/'+tid(req);await q('UPDATE tenants SET logo_url=$1 WHERE id=$2',[logoUrl,tid(req)]);await audit(req,'upload','tenant_logo',tid(req));res.json({logo_url:logoUrl});
}));
app.get('/api/public/store-logo/:id',rateLimit({windowMs:60000,limit:120}),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,404,'Não encontrado');
 const r=await q("SELECT l.mime_type,l.image_data FROM tenant_logos l JOIN tenants t ON t.id=l.tenant_id WHERE l.tenant_id=$1 AND t.status IN ('trial','active')",[req.params.id]);
 if(!r.rowCount)return bad(res,404,'Imagem não encontrada');res.type(r.rows[0].mime_type).set('Cache-Control','public, max-age=300').send(r.rows[0].image_data);
}));
app.get('/api/cameras',auth,roles('master','owner','operator'),route(async(req,res)=>{
 const columns=req.user.role==='master'?'id,tenant_id,name,station,status,device_id,enabled,created_at':'id,name,station,status,enabled,created_at';
 const result=await q('SELECT '+columns+' FROM cameras WHERE deleted_at IS NULL'+(req.user.role==='master'?'':' AND tenant_id=$1')+' ORDER BY created_at DESC',req.user.role==='master'?[]:[tid(req)]);res.json(result.rows);
}));
app.post('/api/cameras',auth,roles('master'),route(async(req,res)=>{
 const v=valid(z.object({tenant_id:uuid,name:z.string().trim().min(2).max(120),station:z.string().trim().max(120).default(''),device_id:uuid.nullish()}),req,res);if(!v)return;
 if(!(await q('SELECT 1 FROM tenants WHERE id=$1',[v.tenant_id])).rowCount)return bad(res,404,'Loja não encontrada');
 if(v.device_id&&!(await q('SELECT 1 FROM shop_devices WHERE id=$1 AND tenant_id=$2 AND enabled AND revoked_at IS NULL',[v.device_id,v.tenant_id])).rowCount)return bad(res,400,'Computador não autorizado para esta loja');
 const result=await q('INSERT INTO cameras(tenant_id,name,station,device_id) VALUES($1,$2,$3,$4) RETURNING id,tenant_id,name,station,status,device_id,enabled',[v.tenant_id,v.name,v.station,v.device_id||null]);await audit(req,'create','camera',result.rows[0].id,v.tenant_id);res.status(201).json(result.rows[0]);
}));
async function editCamera(req,res,cameraId,tenantId=null,remove=false){
 if(!uuid.safeParse(cameraId).success)return bad(res,400,'Câmera inválida');
 const v=remove?{}:valid(z.object({name:z.string().trim().min(2).max(120).optional(),station:z.string().trim().max(120).optional(),status:z.enum(['unconfigured','testing','ready','offline']).optional(),device_id:uuid.nullable().optional(),enabled:z.boolean().optional(),replacement:z.literal(true).optional()}).strict().refine(value=>Object.keys(value).length>0),req,res);if(!v)return;
 const c=await db.connect();try{
  await c.query('BEGIN');
  const r=await c.query('SELECT * FROM cameras WHERE id=$1 AND deleted_at IS NULL'+(tenantId?' AND tenant_id=$2':'')+' FOR UPDATE',tenantId?[cameraId,tenantId]:[cameraId]);
  const camera=r.rows[0];if(!camera){await c.query('ROLLBACK');return bad(res,404,'Câmera não encontrada');}
  if(v.device_id&&!(await c.query('SELECT 1 FROM shop_devices WHERE id=$1 AND tenant_id=$2 AND enabled AND revoked_at IS NULL',[v.device_id,camera.tenant_id])).rowCount){await c.query('ROLLBACK');return bad(res,400,'Computador não autorizado para esta loja');}
  if(remove||v.replacement||v.enabled===false||(v.device_id!==undefined&&v.device_id!==camera.device_id))await c.query("UPDATE recordings SET status='finalizing',device_id=COALESCE(device_id,$3),ended_at=COALESCE(ended_at,now()),updated_at=now() WHERE camera_id=$1 AND tenant_id=$2 AND status IN ('pending','recording','paused')",[camera.id,camera.tenant_id,camera.device_id]);
  const bindingChanged=!!v.replacement||(v.device_id!==undefined&&v.device_id!==camera.device_id);
  const result=await c.query('UPDATE cameras SET name=$1,station=$2,status=$3,device_id=$4,enabled=$5,config_version=config_version+CASE WHEN $8 THEN 1 ELSE 0 END,deleted_at=CASE WHEN $6 THEN now() ELSE deleted_at END WHERE id=$7 RETURNING id,tenant_id,name,station,status,device_id,enabled',[v.name??camera.name,v.station??camera.station,v.replacement?'unconfigured':v.status??camera.status,v.device_id===undefined?camera.device_id:v.device_id,remove||v.replacement?false:v.enabled??camera.enabled,remove,camera.id,bindingChanged]);
  await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',[camera.tenant_id,req.user.id,remove?'remove_camera':v.replacement?'replace_camera':'update_camera','camera',camera.id]);
  await c.query('COMMIT');res.json(result.rows[0]);
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
app.patch('/api/cameras/:id',auth,roles('master'),route((req,res)=>editCamera(req,res,req.params.id)));
app.delete('/api/cameras/:id',auth,roles('master'),route((req,res)=>editCamera(req,res,req.params.id,null,true)));
app.get('/api/customers',auth,roles('owner','operator'),route(async(req,res)=>res.json((await q('SELECT * FROM customers WHERE tenant_id=$1 ORDER BY created_at DESC',[tid(req)])).rows)));
app.post('/api/customers',auth,roles('owner','operator'),route(async(req,res)=>{const v=valid(z.object({name:z.string().min(2).max(120),email:z.string().email().optional().or(z.literal('')),phone:z.string().max(30).optional(),address:z.string().max(500).optional(),cpf:cpfField,birth_date:birthField,postal_code:cepField}),req,res);if(!v)return;const r=await q('INSERT INTO customers(tenant_id,name,email,phone,address,cpf,birth_date,postal_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[tid(req),v.name,v.email||null,v.phone||null,v.address||null,v.cpf||null,v.birth_date||null,v.postal_code||null]);res.status(201).json(r.rows[0]);}));
app.post('/api/customers/import',auth,roles('owner','operator'),route(async(req,res)=>{
 const row=z.object({name:z.string().trim().min(2).max(120),email:z.union([z.string().email(),z.literal('')]).default(''),phone:z.string().max(30).default(''),address:z.string().max(500).default('')});
 const v=valid(z.object({customers:z.array(row).min(1).max(300)}),req,res);if(!v)return;
 const conn=await db.connect();
 try{await conn.query('BEGIN');for(const x of v.customers)await conn.query('INSERT INTO customers(tenant_id,name,email,phone,address) VALUES($1,$2,$3,$4,$5)',[tid(req),x.name,x.email||null,x.phone,x.address]);await conn.query('COMMIT');res.status(201).json({imported:v.customers.length})}
 catch(e){await conn.query('ROLLBACK');throw e}finally{conn.release()}
}));
app.patch('/api/customers/:id',auth,roles('owner','operator'),route(async(req,res)=>{if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');const v=valid(z.object({name:z.string().min(2).max(120),email:z.union([z.string().email(),z.literal('')]),phone:z.string().max(30),address:z.string().max(500),cpf:cpfField,birth_date:birthField,postal_code:cepField}),req,res);if(!v)return;const r=await q('UPDATE customers SET name=$1,email=$2,phone=$3,address=$4,cpf=$7,birth_date=$8,postal_code=$9 WHERE id=$5 AND tenant_id=$6 RETURNING id,name,email,phone,address,cpf,birth_date,postal_code',[v.name,v.email||null,v.phone,v.address,req.params.id,tid(req),v.cpf||null,v.birth_date||null,v.postal_code||null]);if(!r.rowCount)return bad(res,404,'Cliente não encontrado');await audit(req,'update','customer',req.params.id);res.json(r.rows[0]);}));
async function checkCameraMapping(tenant,cameraId,mapping){
 const ids=[cameraId,...Object.values(mapping||{})].filter(Boolean);
 if(ids.some(id=>!uuid.safeParse(id).success))return false;
 if(!ids.length)return true;
 const r=await q('SELECT id FROM cameras WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND enabled AND deleted_at IS NULL',[tenant,ids]);
 return ids.every(id=>r.rows.some(x=>x.id===id));
}
const cameraMapping=z.record(z.string().regex(/^([0-9]|[12][0-9])$/),uuid.nullable()).default({});
app.patch('/api/processes/:id',auth,roles('owner'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');
 const v=valid(z.object({name:z.string().trim().min(2).max(120),steps:z.array(z.string().trim().min(1).max(120)).min(1).max(30),camera_id:uuid.nullish(),step_cameras:cameraMapping}),req,res);if(!v)return;if(!await checkCameraMapping(tid(req),v.camera_id,v.step_cameras))return bad(res,400,'Câmera inválida');if(Object.keys(v.step_cameras).some(i=>Number(i)>=v.steps.length))return bad(res,400,'Etapa de câmera inválida');
 const r=await q('UPDATE processes SET name=$1,steps=$2,camera_id=$5,step_cameras=$6 WHERE id=$3 AND tenant_id=$4 RETURNING *',[v.name,JSON.stringify(v.steps),req.params.id,tid(req),v.camera_id||null,JSON.stringify(v.step_cameras)]);
 if(!r.rowCount)return bad(res,404,'Processo não encontrado');await audit(req,'update','process',req.params.id);res.json(r.rows[0]);
}));
app.get('/api/processes',auth,roles('owner','operator'),route(async(req,res)=>res.json((await q('SELECT * FROM processes WHERE tenant_id=$1 ORDER BY created_at DESC',[tid(req)])).rows)));
app.post('/api/processes',auth,roles('owner'),route(async(req,res)=>{const v=valid(z.object({name:z.string().min(2),steps:z.array(z.string().min(1)).min(1).max(30),camera_id:uuid.nullish(),step_cameras:cameraMapping}),req,res);if(!v)return;if(!await checkCameraMapping(tid(req),v.camera_id,v.step_cameras))return bad(res,400,'Câmera inválida');if(Object.keys(v.step_cameras).some(i=>Number(i)>=v.steps.length))return bad(res,400,'Etapa de câmera inválida');const r=await q('INSERT INTO processes(tenant_id,name,steps,camera_id,step_cameras) VALUES($1,$2,$3,$4,$5) RETURNING *',[tid(req),v.name,JSON.stringify(v.steps),v.camera_id||null,JSON.stringify(v.step_cameras)]);res.status(201).json(r.rows[0]);}));
app.put('/api/orders/queue-order',auth,roles('owner','operator'),route(async(req,res)=>{
 const v=valid(z.object({ids:z.array(uuid).max(500)}),req,res);if(!v)return;
 if(new Set(v.ids).size!==v.ids.length)return bad(res,400,'Há pedidos repetidos');
 const conn=await db.connect();
 try{
  await conn.query('BEGIN');
  await conn.query('SELECT pg_advisory_xact_lock(hashtext($1))',[tid(req)+':order-queue']);
  const r=await conn.query("SELECT id FROM orders WHERE tenant_id=$1 AND status='queued' AND deleted_at IS NULL ORDER BY COALESCE(queue_rank,9223372036854775807),created_at,id FOR UPDATE",[tid(req)]);
  if(r.rowCount!==v.ids.length||r.rows.some(x=>!v.ids.includes(x.id))){await conn.query('ROLLBACK');return bad(res,409,'A fila mudou. Atualize antes de reordenar');}
  for(let i=0;i<v.ids.length;i++)await conn.query('UPDATE orders SET queue_rank=$1 WHERE id=$2 AND tenant_id=$3',[(i+1)*1000,v.ids[i],tid(req)]);
  await conn.query('COMMIT');res.json({ok:true});
 }catch(e){await conn.query('ROLLBACK');throw e}finally{conn.release()}
}));
app.delete('/api/orders/:id',auth,roles('owner','operator'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'Pedido inválido');
 const c=await db.connect();try{
  await c.query('BEGIN');
  const found=await c.query('SELECT id FROM orders WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE',[req.params.id,tid(req)]);
  if(!found.rowCount){await c.query('ROLLBACK');return bad(res,404,'Pedido não encontrado');}
  await c.query('UPDATE orders SET deleted_at=now() WHERE id=$1',[req.params.id]);
  await c.query("UPDATE recordings SET status='finalizing',ended_at=COALESCE(ended_at,now()),updated_at=now() WHERE order_id=$1 AND tenant_id=$2 AND status IN ('pending','recording','paused')",[req.params.id,tid(req)]);
  await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',[tid(req),req.user.id,'archive','order',req.params.id]);
  await c.query('COMMIT');res.json({ok:true});
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));
app.get('/api/orders',auth,roles('owner','operator'),route(async(req,res)=>res.json((await q("SELECT o.id,o.status,o.step_index,o.camera_id,o.created_at,o.started_at,o.completed_at,o.external_reference,o.order_number,o.source,o.queue_rank,o.share_code,o.customer_id,o.details,(SELECT coalesce(json_agg(ph.id ORDER BY ph.created_at),'[]'::json) FROM order_photos ph WHERE ph.order_id=o.id) photos,c.name customer,c.phone customer_phone,c.email customer_email,p.id process_id,o.process_snapshot->>'name' process,o.process_snapshot->'steps' steps FROM orders o LEFT JOIN customers c ON c.id=o.customer_id JOIN processes p ON p.id=o.process_id WHERE o.tenant_id=$1 AND o.deleted_at IS NULL ORDER BY o.created_at DESC,o.id DESC",[tid(req)])).rows)));
app.post('/api/orders',auth,roles('owner','operator'),route(async(req,res)=>{
 const v=valid(z.object({customer_id:uuid,process_id:uuid,reference:z.string().trim().max(70).default(''),details:orderDetails.default({})}),req,res);if(!v)return;
 const token=crypto.randomBytes(12).toString('base64url'),hash=digestToken(token);
 const r=await q("INSERT INTO orders(tenant_id,customer_id,process_id,public_token_hash,external_reference,details) SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM customers WHERE id=$2 AND tenant_id=$1) AND EXISTS(SELECT 1 FROM processes WHERE id=$3 AND tenant_id=$1) RETURNING id,status,order_number,share_code",[tid(req),v.customer_id,v.process_id,hash,v.reference||null,JSON.stringify(v.details)]);
 if(!r.rowCount)return bad(res,400,'Cliente ou processo inválido');await audit(req,'create','order',r.rows[0].id);
 res.status(201).json({...r.rows[0],tracking_url:(process.env.PUBLIC_BASE_URL||'http://localhost:3000')+'/p/'+token});
}));
app.patch('/api/orders/:id',auth,roles('owner','operator'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'Pedido inválido');
 const v=valid(z.object({details:orderDetails.optional(),reference:z.string().trim().max(70).optional(),customer_id:uuid.optional()}).strict().refine(v=>Object.keys(v).length>0),req,res);if(!v)return;
 if(v.customer_id&&!(await q('SELECT 1 FROM customers WHERE id=$1 AND tenant_id=$2',[v.customer_id,tid(req)])).rowCount)return bad(res,400,'Cliente inválido');
 const r=await q('UPDATE orders SET details=COALESCE($1::jsonb,details),external_reference=CASE WHEN $2 THEN $3 ELSE external_reference END,customer_id=COALESCE($4,customer_id) WHERE id=$5 AND tenant_id=$6 AND deleted_at IS NULL RETURNING id,status',[v.details?JSON.stringify(v.details):null,v.reference!==undefined,v.reference||null,v.customer_id||null,req.params.id,tid(req)]);
 if(!r.rowCount)return bad(res,404,'Pedido não encontrado');await audit(req,'update_details','order',req.params.id);res.json(r.rows[0]);
}));
app.post('/api/orders/quick',auth,roles('owner','operator'),route(async(req,res)=>{
 const v=valid(z.object({reference:z.string().trim().min(1).max(70),process_id:uuid.optional().nullable()}),req,res);if(!v)return;
 const reference=v.reference;const token=crypto.randomBytes(12).toString('base64url');
 const hash=crypto.createHash('sha256').update(token).digest('hex');
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  let processId=v.process_id;
  if(processId){const p=await client.query('SELECT id FROM processes WHERE id=$1 AND tenant_id=$2',[processId,tid(req)]);if(!p.rowCount){await client.query('ROLLBACK');return bad(res,400,'Processo inválido para esta loja');}}
  else{
   const p=await client.query("SELECT id FROM processes WHERE tenant_id=$1 AND name='Acompanhamento rápido' ORDER BY created_at LIMIT 1",[tid(req)]);
   if(p.rowCount)processId=p.rows[0].id;
   else {const created=await client.query("INSERT INTO processes(tenant_id,name,steps) VALUES($1,'Acompanhamento rápido',$2) RETURNING id",[tid(req),JSON.stringify(['Recebido','Em preparação','Pronto para entrega'])]);processId=created.rows[0].id;}
  }
  const order=await client.query("INSERT INTO orders(tenant_id,customer_id,process_id,public_token_hash,source,external_reference) VALUES($1,NULL,$2,$3,'quick',$4) ON CONFLICT DO NOTHING RETURNING id,status,external_reference",[tid(req),processId,hash,reference]);
  if(!order.rowCount){await client.query('ROLLBACK');return bad(res,409,'Número de pedido já cadastrado nesta loja');}
  await client.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',[tid(req),req.user.id,'create_quick','order',order.rows[0].id]);
  await client.query('COMMIT');
  res.status(201).json({...order.rows[0],tracking_url:(process.env.PUBLIC_BASE_URL||'http://localhost:3000')+'/p/'+token});
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}));
app.post('/api/store/loyalty/redeem',auth,roles('owner','operator'),route(async(req,res)=>{
 const v=valid(z.object({code:z.string().trim().regex(/^[A-Z0-9]{8}$/)}),req,res);if(!v)return;
 const hash=crypto.createHash('sha256').update(v.code).digest('hex');
 const client=await db.connect();
 try{await client.query('BEGIN');
 const r=await client.query("UPDATE loyalty_redemptions SET status='redeemed',redeemed_at=now(),redeemed_by=$1 WHERE code_hash=$2 AND tenant_id=$3 AND status='issued' RETURNING id,reward_snapshot",[req.user.id,hash,tid(req)]);
 if(!r.rowCount){await client.query('ROLLBACK');return bad(res,404,'Cupom inválido, utilizado ou de outra loja');}
 await client.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',[tid(req),req.user.id,'loyalty_redeem','loyalty_redemption',r.rows[0].id]);
 await client.query('COMMIT');res.json({ok:true,reward:r.rows[0].reward_snapshot});
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}));
app.post('/api/public/orders/:token/loyalty/claim',rateLimit({windowMs:60000,limit:8}),route(async(req,res)=>{
 if(!/^[A-Za-z0-9_-]{16,100}$/.test(req.params.token))return bad(res,404,'Pedido não encontrado');
 const hash=crypto.createHash('sha256').update(req.params.token).digest('hex');
 const client=await db.connect();
 try{await client.query('BEGIN');
 const r=await client.query("SELECT o.tenant_id,o.customer_id,t.loyalty_target,t.loyalty_reward FROM orders o JOIN tenants t ON t.id=o.tenant_id WHERE (o.public_token_hash=$1 OR o.share_code=$2) AND o.customer_id IS NOT NULL AND t.loyalty_enabled=true AND t.status IN ('trial','active') AND o.deleted_at IS NULL",[hash,req.params.token]);
 const o=r.rows[0];if(!o){await client.query('ROLLBACK');return bad(res,403,'Fidelidade não disponível para este pedido');}
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[o.tenant_id+':'+o.customer_id]);
 const existing=await client.query("SELECT id FROM loyalty_redemptions WHERE tenant_id=$1 AND customer_id=$2 AND status='issued' LIMIT 1",[o.tenant_id,o.customer_id]);
 if(existing.rowCount){await client.query('ROLLBACK');return bad(res,409,'Já existe um cupom pendente. Consulte o histórico.');}
 const eligible=await client.query("SELECT id FROM loyalty_checkins WHERE tenant_id=$1 AND customer_id=$2 AND redemption_id IS NULL ORDER BY created_at,id LIMIT $3",[o.tenant_id,o.customer_id,o.loyalty_target]);
 if(eligible.rowCount<o.loyalty_target){await client.query('ROLLBACK');return bad(res,409,'Ainda não há check-ins suficientes');}
 const code=crypto.randomBytes(4).toString('hex').toUpperCase();
 const codeHash=crypto.createHash('sha256').update(code).digest('hex');
 const coupon=await client.query("INSERT INTO loyalty_redemptions(tenant_id,customer_id,code_hash,target_snapshot,reward_snapshot) VALUES($1,$2,$3,$4,$5) RETURNING id,issued_at",[o.tenant_id,o.customer_id,codeHash,o.loyalty_target,o.loyalty_reward]);
 await client.query('UPDATE loyalty_checkins SET redemption_id=$1 WHERE id=ANY($2::uuid[])',[coupon.rows[0].id,eligible.rows.map(x=>x.id)]);
 await client.query('COMMIT');res.status(201).json({code,issued_at:coupon.rows[0].issued_at,reward:o.loyalty_reward});
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}));
app.post('/api/orders/:id/transition',auth,roles('owner','operator'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');
 const v=valid(z.object({action:z.enum(['start','pause','resume','advance','back','complete','reopen']),expected_step_index:z.number().int().min(0).optional(),expected_status:z.enum(['queued','live','paused','completed']).optional()}),req,res);if(!v)return;
 const c=await db.connect();try{
  await c.query('BEGIN');
  const r=await c.query("SELECT o.*,o.process_snapshot->'steps' steps,o.process_snapshot->>'camera_id' process_camera_id,o.process_snapshot->'step_cameras' step_cameras FROM orders o WHERE o.id=$1 AND o.tenant_id=$2 AND o.deleted_at IS NULL FOR UPDATE OF o",[req.params.id,tid(req)]);
  const o=r.rows[0];
  if(!o){await c.query('ROLLBACK');return bad(res,404,'Pedido não encontrado');}
  if((v.expected_step_index!==undefined&&v.expected_step_index!==o.step_index)||(v.expected_status!==undefined&&v.expected_status!==o.status)){
   await c.query('ROLLBACK');return bad(res,409,'O pedido mudou. Atualize antes de continuar');
  }
  let status=o.status,index=o.step_index,unstart=false,reopen=false;
  if(v.action==='start'&&status==='queued')status='live';
  else if(v.action==='pause'&&['queued','live'].includes(status))status='paused';
  else if(v.action==='resume'&&status==='paused')status=o.started_at?'live':'queued';
  else if(v.action==='advance'&&status==='live'&&index<o.steps.length-1)index++;
  else if(v.action==='back'&&['live','paused'].includes(status)&&index>0)index--;
  else if(v.action==='back'&&['live','paused'].includes(status)&&index===0&&o.started_at){status='queued';unstart=true;}
  else if(v.action==='reopen'&&status==='completed'&&o.completed_at&&Date.now()-new Date(o.completed_at).getTime()<24*3600000){status='live';reopen=true;}
  else if(v.action==='complete'&&status==='live'&&index===o.steps.length-1)status='completed';
  else{await c.query('ROLLBACK');return bad(res,409,'Transição inválida');}
  const camera=cameraForStep(o.step_cameras,o.process_camera_id,index);
  if(status==='live'&&camera){
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['nextvision-camera:'+camera]);
   const occupied=await c.query(`SELECT 1 FROM orders busy WHERE busy.tenant_id=$1 AND busy.id<>$2 AND busy.status='live' AND busy.deleted_at IS NULL
    AND (CASE WHEN (busy.process_snapshot->'step_cameras') ? busy.step_index::text THEN busy.process_snapshot->'step_cameras'->>busy.step_index::text ELSE busy.process_snapshot->>'camera_id' END)=$3 LIMIT 1`,[tid(req),o.id,camera]);
   if(occupied.rowCount){await c.query('ROLLBACK');return bad(res,409,'Esta câmera está em uso por outro pedido. Pause ou conclua o atendimento atual antes de usar esta câmera.');}
  }
  // Close the old capture before assigning a distinct file/job to a new visit.
  if(['pause','advance','back','complete','resume'].includes(v.action)){
   await c.query("UPDATE recordings SET status='finalizing',ended_at=COALESCE(ended_at,now()),updated_at=now() WHERE order_id=$1 AND tenant_id=$2 AND step_index=$3 AND status IN ('pending','recording','paused')",[o.id,tid(req),o.step_index]);
  }
  if(status==='live'&&camera&&['start','advance','back','resume','reopen'].includes(v.action)&&(await c.query('SELECT 1 FROM cameras WHERE id=$1 AND tenant_id=$2 AND enabled AND deleted_at IS NULL',[camera,tid(req)])).rowCount){
   await c.query("INSERT INTO recordings(tenant_id,order_id,step_index,camera_id,status,visit_index) SELECT $1,$2,$3,$4,'pending',COALESCE(max(visit_index),-1)+1 FROM recordings WHERE order_id=$2 AND step_index=$3",[tid(req),o.id,index,camera]);
  }
  const upd=await c.query("UPDATE orders SET camera_id=$4,status=$1,step_index=$2,started_at=CASE WHEN $5 THEN NULL WHEN $1='live' AND started_at IS NULL THEN now() ELSE started_at END,completed_at=CASE WHEN $1='completed' THEN now() WHEN $6 THEN NULL ELSE completed_at END WHERE id=$3 RETURNING id,status,step_index",[status,index,o.id,status==='queued'?null:camera,unstart,reopen]);
  if(reopen)await c.query('DELETE FROM loyalty_checkins WHERE order_id=$1 AND tenant_id=$2 AND redemption_id IS NULL',[o.id,tid(req)]);
  if(v.action==='complete'&&o.customer_id)await c.query('INSERT INTO loyalty_checkins(tenant_id,customer_id,order_id) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM tenants WHERE id=$1 AND loyalty_enabled=true) ON CONFLICT(order_id) DO NOTHING',[tid(req),o.customer_id,o.id]);
  await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',[tid(req),req.user.id,v.action,'order',o.id]);
  await c.query('COMMIT');void notifyOrder(o.id,v.action).catch(e=>console.error('Falha no e-mail:',e.message));res.json(upd.rows[0]);
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));

const photoSignature={'image/png':b=>b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'image/jpeg':b=>b[0]===255&&b[1]===216&&b[2]===255,'image/webp':b=>b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'};
app.post('/api/orders/:id/photos',auth,roles('owner','operator'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'Pedido inválido');
 const v=valid(z.object({mime_type:z.enum(['image/png','image/jpeg','image/webp']),base64:z.string().min(10).max(400000)}),req,res);if(!v)return;
 const bin=Buffer.from(v.base64,'base64');
 if(!bin.length||bin.length>300000||!photoSignature[v.mime_type](bin))return bad(res,400,'Foto inválida ou maior que 300 KB');
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const o=await c.query('SELECT id FROM orders WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE',[req.params.id,tid(req)]);
  if(!o.rowCount){await c.query('ROLLBACK');return bad(res,404,'Pedido não encontrado');}
  if((await c.query('SELECT count(*)::int n FROM order_photos WHERE order_id=$1',[req.params.id])).rows[0].n>=6){await c.query('ROLLBACK');return bad(res,409,'Limite de 6 fotos por pedido');}
  const r=await c.query('INSERT INTO order_photos(tenant_id,order_id,mime_type,image_data,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,created_at',[tid(req),req.params.id,v.mime_type,bin,req.user.id]);
  await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',[tid(req),req.user.id,'add_photo','order',req.params.id]);
  await c.query('COMMIT');res.status(201).json(r.rows[0]);
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}));
app.delete('/api/orders/:id/photos/:photoId',auth,roles('owner','operator'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success||!uuid.safeParse(req.params.photoId).success)return bad(res,400,'Foto inválida');
 const r=await q('DELETE FROM order_photos WHERE id=$1 AND order_id=$2 AND tenant_id=$3',[req.params.photoId,req.params.id,tid(req)]);
 if(!r.rowCount)return bad(res,404,'Foto não encontrada');await audit(req,'delete_photo','order',req.params.id);res.status(204).end();
}));
app.get('/api/public/orders/:token/photos/:photoId',rateLimit({windowMs:60000,limit:120}),route(async(req,res)=>{
 if(!/^[\w-]{16,100}$/.test(req.params.token)||!uuid.safeParse(req.params.photoId).success)return bad(res,404,'Não encontrado');
 const r=await q("SELECT ph.mime_type,ph.image_data FROM order_photos ph JOIN orders o ON o.id=ph.order_id AND o.tenant_id=ph.tenant_id JOIN tenants t ON t.id=o.tenant_id WHERE ph.id=$1 AND (o.public_token_hash=$2 OR o.share_code=$3) AND o.deleted_at IS NULL AND t.status IN ('trial','active')",[req.params.photoId,digestToken(req.params.token),req.params.token]);
 if(!r.rowCount)return bad(res,404,'Foto não encontrada');
 res.type(r.rows[0].mime_type).set('Cache-Control','private, max-age=3600').send(r.rows[0].image_data);
}));
// Apaga fotos vencidas pelo prazo de guarda de cada loja.
const purgeOldPhotos=()=>q("DELETE FROM order_photos ph USING tenants t WHERE t.id=ph.tenant_id AND ph.created_at < now() - make_interval(days => t.retention_days)").catch(e=>console.error('Limpeza de fotos falhou:',e.code||e.name));
setTimeout(purgeOldPhotos,60000).unref();setInterval(purgeOldPhotos,6*3600000).unref();

const liveMediaConfig=()=>{
 const {MEDIA_UPSTREAM_URL,MEDIA_USERNAME,MEDIA_PASSWORD,LIVE_CAMERA_ID}=process.env;
 if(!MEDIA_UPSTREAM_URL||!MEDIA_USERNAME||!MEDIA_PASSWORD||(LIVE_CAMERA_ID&&!uuid.safeParse(LIVE_CAMERA_ID).success)||(!LIVE_CAMERA_ID&&process.env.MEDIA_MULTI_CAMERA_ENABLED!=='true'))return null;
 let origin;try{origin=new URL(MEDIA_UPSTREAM_URL);}catch{return null;}
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/')return null;
 return {origin,username:MEDIA_USERNAME,password:MEDIA_PASSWORD,cameraId:LIVE_CAMERA_ID||null};
};
const allowedMediaAsset=name=>/^(index|stream|segment|part|init)[A-Za-z0-9_.-]{0,100}\.(?:m3u8|ts|m4s|mp4)$/.test(name)||/^[A-Za-z0-9_-]{1,100}\.(?:m3u8|ts|m4s|mp4)$/.test(name);
// Several customers of the same store share one public IP (store/home Wi-Fi), and
// LL-HLS polls parts every second. Limit per IP generously and per order link tightly.
const hlsPerIp=rateLimit({windowMs:60000,limit:1800,standardHeaders:'draft-7',legacyHeaders:false});
const hlsPerLink=rateLimit({windowMs:60000,limit:600,standardHeaders:'draft-7',legacyHeaders:false,keyGenerator:req=>'hls-link:'+String(req.params.token||'').slice(0,100)});
app.get('/api/public/orders/:token/live/:asset',hlsPerIp,hlsPerLink,route(async(req,res)=>{
 const config=liveMediaConfig();
 if(!config){console.error('HLS configuration incomplete');return bad(res,503,'Vídeo indisponível');}
 const {token,asset}=req.params;
 if(!/^[\w-]{16,100}$/.test(token)||!allowedMediaAsset(asset))return bad(res,404,'Não encontrado');
 const hash=crypto.createHash('sha256').update(token).digest('hex');
 // A camera must belong to this tenant and this active order; never expose a general camera feed
 const found=await q(`SELECT o.id,o.tenant_id,o.step_index,c.id media_camera,c.stream_path,o.process_snapshot->'step_cameras' step_cameras,o.process_snapshot->>'camera_id' process_camera
 FROM orders o JOIN tenants t ON t.id=o.tenant_id
 JOIN processes p ON p.id=o.process_id AND p.tenant_id=o.tenant_id
 JOIN cameras c ON c.id=(CASE WHEN (o.process_snapshot->'step_cameras') ? o.step_index::text THEN o.process_snapshot->'step_cameras'->>o.step_index::text ELSE o.process_snapshot->>'camera_id' END)::uuid AND c.tenant_id=o.tenant_id AND c.enabled AND c.deleted_at IS NULL
 AND ((c.device_id IS NULL AND $3::uuid IS NOT NULL) OR EXISTS(SELECT 1 FROM shop_devices d WHERE d.id=c.device_id AND d.tenant_id=c.tenant_id AND d.enabled AND d.revoked_at IS NULL))
 WHERE (o.public_token_hash=$1 OR o.share_code=$2) AND o.status='live'
 AND o.deleted_at IS NULL AND t.status IN ('trial','active') AND ($3::uuid IS NULL OR c.id=$3)`,[hash,token,config.cameraId]);
 if(!found.rowCount)return bad(res,404,'Vídeo indisponível');
 const order=found.rows[0];
 const chosen=cameraForStep(order.step_cameras,order.process_camera,order.step_index);
 if(chosen!==order.media_camera||(config.cameraId&&chosen!==config.cameraId))return bad(res,404,'Vídeo indisponível');
 const competing=await q(`SELECT 1 FROM orders o JOIN processes p ON p.id=o.process_id AND p.tenant_id=o.tenant_id
 WHERE o.tenant_id=$1 AND o.id<>$2 AND o.status='live' AND o.deleted_at IS NULL
 AND (CASE WHEN (o.process_snapshot->'step_cameras') ? o.step_index::text
 THEN o.process_snapshot->'step_cameras'->>o.step_index::text
 ELSE o.process_snapshot->>'camera_id' END)=$3 LIMIT 1`,[order.tenant_id,order.id,chosen]);
 if(competing.rowCount)return bad(res,409,'Câmera ocupada por outro pedido');
 const streamPath=config.cameraId?'camera':order.stream_path;
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(streamPath||''))return bad(res,503,'Câmera sem caminho de transmissão');
 const url=new URL('/'+streamPath+'/'+asset,config.origin);
 // MediaMTX binds HLS child playlists/segments to a ?session= token.
 // Preserve only known HLS query parameters, never arbitrary URLs.
 const allowedQuery=new Set(['session','_HLS_msn','_HLS_part','_HLS_skip']);
 for(const [key,value] of Object.entries(req.query)){
  if(!allowedQuery.has(key)||typeof value!=='string'||value.length>160||!/^[a-zA-Z0-9_.-]+$/.test(value))return bad(res,400,'Parâmetro HLS inválido');
  url.searchParams.set(key,value);
 }
 // Skip the initial cookie probe, but do not send Cookie: cookieCheck=1.
 // We do not keep an upstream cookie jar. Without that cookie MediaMTX puts
 // its session in child playlist/segment URLs, which this proxy preserves.
 if(asset==='index.m3u8')url.searchParams.set('cookieCheck','1');
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),35000);
 let upstream;
 try{upstream=await fetch(url,{headers:{Authorization:'Basic '+Buffer.from(config.username+':'+config.password).toString('base64'),'User-Agent':'curl/8.0.0','Accept':'*/*'},redirect:'manual',signal:controller.signal});}
 catch(e){console.error('HLS upstream network failure:',e.cause?.code||e.name);return bad(res,e.name==='AbortError'?504:502,e.name==='AbortError'?'Tempo limite ao acessar transmissão':'Falha ao carregar vídeo');}
 finally{clearTimeout(timeout);}
 if(!upstream.ok){const body=(await upstream.text().catch(()=>'' )).slice(0,2048);const type=/session not found/i.test(body)?'mediamtx-session':/authentication (?:error|failed)/i.test(body)?'mediamtx-auth':/cloudflare/i.test(body)?'cloudflare-page':/unauthorized/i.test(body)?'unauthorized':'unknown';console.error('HLS denied',{status:upstream.status,contentType:upstream.headers.get('content-type'),originServer:upstream.headers.get('server'),hasCfRay:!!upstream.headers.get('cf-ray'),bodyType:type,bodyLength:body.length});return bad(res,502,'Origem do vídeo indisponível');}
 const mime=asset.endsWith('.m3u8')?'application/vnd.apple.mpegurl':asset.endsWith('.ts')?'video/mp2t':'video/mp4';
 res.set({'Content-Type':mime,'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'});
 if(asset.endsWith('.m3u8')){
  let playlist=await upstream.text();
  // Rewrite all HLS media references to this order-scoped proxy (including fMP4 LL-HLS tags).
  const routeFor=reference=>{
   if(!/^[A-Za-z0-9_.-]+\.(?:m3u8|ts|m4s|mp4)(?:\?[A-Za-z0-9_=.-]+)?$/.test(reference))return null;
   const [file,query='']=reference.split('?');
   if(!allowedMediaAsset(file))return null;
   return '/api/public/orders/'+encodeURIComponent(token)+'/live/'+file+(query?'?'+query:'');
  };
  const lines=playlist.split(/\r?\n/);
  const rewritten=[];
  for(const line of lines){
   if(line.startsWith('#')){
    if(/^#EXT-X-(?:KEY|SESSION-KEY):/i.test(line))return bad(res,502,'Playlist criptografada não suportada');
    let invalid=false;
    const next=line.replace(/URI="([^"]+)"/g,(_match,uri)=>{
     const mapped=routeFor(uri);
     if(!mapped){invalid=true;return _match}
     return 'URI="'+mapped+'"';
    });
    if(invalid)return bad(res,502,'Playlist inválida');
    rewritten.push(next);
   }else if(line){
    const mapped=routeFor(line);
    if(!mapped)return bad(res,502,'Playlist inválida');
    rewritten.push(mapped);
   }else rewritten.push(line);
  }
  playlist=rewritten.join('\n');
  return res.send(playlist);
 }
 const bytes=await upstream.arrayBuffer();
 if(bytes.byteLength>8*1024*1024)return bad(res,502,'Segmento excede o limite');
 res.send(Buffer.from(bytes));
}));
app.get('/api/public/orders/:token/recordings',rateLimit({windowMs:60000,limit:60}),route(async(req,res)=>{
 const token=req.params.token;
 if(!/^[\w-]{16,100}$/.test(token))return bad(res,404,'Não encontrado');
 const r=await q("SELECT rec.id,rec.step_index,rec.visit_index,rec.status,rec.started_at,rec.ended_at FROM recordings rec JOIN orders o ON o.id=rec.order_id AND o.tenant_id=rec.tenant_id JOIN tenants t ON t.id=o.tenant_id WHERE (o.public_token_hash=$1 OR o.share_code=$2) AND t.status IN ('trial','active') AND o.deleted_at IS NULL ORDER BY rec.step_index,rec.visit_index",[digestToken(token),token]);
 res.set('Cache-Control','no-store');res.json(r.rows);
}));
app.get('/api/public/orders/:token',rateLimit({windowMs:60000,limit:90}),route(async(req,res)=>{
 if(!/^[\w-]{16,100}$/.test(req.params.token))return bad(res,404,'Não encontrado');
 const r=await q(`SELECT o.id,o.status,o.step_index,o.camera_id,o.external_reference,
 EXISTS(SELECT 1 FROM cameras available WHERE available.id=o.camera_id AND available.tenant_id=o.tenant_id AND available.enabled AND available.deleted_at IS NULL AND (available.device_id IS NULL OR EXISTS(SELECT 1 FROM shop_devices d WHERE d.id=available.device_id AND d.tenant_id=available.tenant_id AND d.enabled AND d.revoked_at IS NULL))) camera_available,
 o.process_snapshot->>'name' process,o.process_snapshot->'steps' steps,t.name store,t.logo_url,t.niche,(SELECT coalesce(json_agg(ph.id ORDER BY ph.created_at),'[]'::json) FROM order_photos ph WHERE ph.order_id=o.id) photos,o.details->>'brand' item_brand,o.details->>'model' item_model,
 t.loyalty_enabled,t.loyalty_target,t.loyalty_reward,
 CASE WHEN o.customer_id IS NOT NULL AND t.loyalty_enabled THEN
 (SELECT count(*)::int FROM loyalty_checkins l WHERE l.tenant_id=o.tenant_id AND l.customer_id=o.customer_id AND l.redemption_id IS NULL) ELSE NULL END loyalty_checkins,
 CASE WHEN o.customer_id IS NOT NULL AND t.loyalty_enabled THEN
 (SELECT coalesce(json_agg(json_build_object('status',lr.status,'reward',lr.reward_snapshot,'issued_at',lr.issued_at,'redeemed_at',lr.redeemed_at) ORDER BY lr.issued_at DESC),'[]'::json)
 FROM loyalty_redemptions lr WHERE lr.tenant_id=o.tenant_id AND lr.customer_id=o.customer_id) ELSE '[]'::json END loyalty_history,
 (SELECT position::int FROM (SELECT id,row_number() OVER(ORDER BY queue_rank NULLS LAST,created_at,id) position
 FROM orders WHERE tenant_id=o.tenant_id AND status='queued' AND deleted_at IS NULL) queue WHERE queue.id=o.id) queue_position,
 CASE WHEN o.status='queued' THEN
 (SELECT coalesce(json_agg(json_build_object('step_name',a.process_snapshot->'steps'->>a.step_index,'step_index',a.step_index,
 'total_steps',jsonb_array_length(a.process_snapshot->'steps'),'status',a.status) ORDER BY a.started_at,a.id),'[]'::json)
 FROM orders a WHERE a.tenant_id=o.tenant_id AND a.id<>o.id AND a.deleted_at IS NULL
 AND (a.status='live' OR (a.status='paused' AND a.started_at IS NOT NULL))) ELSE '[]'::json END active_services
 FROM orders o JOIN tenants t ON t.id=o.tenant_id
 WHERE (o.public_token_hash=$1 OR o.share_code=$2) AND o.deleted_at IS NULL AND t.status IN ('trial','active')`,[digestToken(req.params.token),req.params.token]);
 if(!r.rowCount)return bad(res,404,'Pedido não encontrado');
 res.set('Cache-Control','no-store');res.json(r.rows[0]);
}));
// Rota explícita da prévia, independente da resolução do diretório de trabalho.
app.get('/loja-preview.html',(_req,res)=>res.sendFile('loja-preview.html',{root:new URL('../public/',import.meta.url).pathname}));
// Link curto: /<loja>/<numero>. Limite por IP dificulta testar numeros em sequencia.
const shortLinkLimit=rateLimit({windowMs:10*60000,limit:40,standardHeaders:'draft-7',legacyHeaders:false});
app.get(/^\/([a-z0-9-]{3,60})\/(\d{4,5})\/?$/,shortLinkLimit,route(async(req,res)=>{
 const r=await q("SELECT o.share_code FROM tenant_slugs s JOIN tenants t ON t.id=s.tenant_id JOIN orders o ON o.tenant_id=t.id WHERE s.slug=$1 AND o.order_number=$2 AND o.deleted_at IS NULL AND t.status IN ('trial','active') ORDER BY o.created_at DESC LIMIT 1",[req.params[0],Number(req.params[1])]);
 if(!r.rowCount)return res.status(404).sendFile('tracking.html',{root:'public'});
 res.redirect(302,'/p/'+encodeURIComponent(r.rows[0].share_code));
}));
app.use(express.static('public'));app.get('/p/:token',(_req,res)=>res.sendFile('tracking.html',{root:'public'}));
app.use((err,req,res,next)=>{console.error(err.code||err.name);if(err.code==='P0001'&&err.message==='camera_limit_reached')return bad(res,409,'Limite de câmeras do plano atingido. Solicite ampliação à central.');if(err.code==='P0001'&&err.message==='camera_limit_below_installed')return bad(res,409,'Remova as câmeras excedentes antes de reduzir o plano.');if(err.code==='23505'){console.error('Violação de unicidade:',err.constraint||'desconhecida');return bad(res,409,err.constraint==='users_email_key'?'Este e-mail já está cadastrado':err.constraint==='tenants_slug_key'?'Este identificador de loja já existe':'Já existe um registro com esses dados');}if(err.code==='23503')return bad(res,400,'Referência inválida');return bad(res,500,'Erro interno');});
app.listen(Number(process.env.PORT||3000),async()=>{console.log('NextVision API pronta');try{const r=await q("SELECT current_database() AS database,(SELECT count(*)::int FROM users) AS users_count,(SELECT count(*)::int FROM tenants) AS tenants_count");console.log('Diagnóstico de conexão:',JSON.stringify(r.rows[0]));}catch(e){console.error('Diagnóstico de conexão falhou:',e.code||e.message)}});
