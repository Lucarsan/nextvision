import 'dotenv/config';
import express from 'express';import helmet from 'helmet';import rateLimit from 'express-rate-limit';import jwt from 'jsonwebtoken';import bcrypt from 'bcryptjs';import crypto from 'node:crypto';import {z} from 'zod';import {q,db} from './db.js';
const app=express();app.set('trust proxy',1);app.disable('x-powered-by');app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'400kb'}));
const secret=process.env.JWT_SECRET;if(!secret||secret.length<32)throw Error('Configure JWT_SECRET com 32+ caracteres');
const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const bad=(res,status,message)=>res.status(status).json({error:message});
const valid=(schema,req,res)=>{const p=schema.safeParse(req.body);if(!p.success){bad(res,400,'Dados inválidos');return null;}return p.data;};
const uuid=z.string().uuid();const auth=(req,res,next)=>{try{const token=/^Bearer (.+)$/i.exec(req.get('authorization')||'')?.[1];if(!token)return bad(res,401,'Não autenticado');req.user=jwt.verify(token,secret,{algorithms:['HS256']});next();}catch{return bad(res,401,'Sessão inválida');}};
const roles=(...allow)=>(req,res,next)=>allow.includes(req.user.role)?next():bad(res,403,'Sem permissão');
const tid=req=>req.user.tenant_id;
async function notifyOrder(orderId,action){if(!process.env.RESEND_API_KEY||!process.env.EMAIL_FROM)return;const r=await q("SELECT t.name store,t.email_notifications mode,c.email,p.name process,p.steps,o.step_index,o.status FROM orders o JOIN tenants t ON t.id=o.tenant_id JOIN customers c ON c.id=o.customer_id JOIN processes p ON p.id=o.process_id WHERE o.id=$1",[orderId]);const d=r.rows[0];if(!d?.email||d.mode==='off')return;const isEnd=action==='complete';if(!(d.mode==='all'||(d.mode==='steps'&&action==='advance')||(d.mode==='completed'&&isEnd)))return;const subject=isEnd?'Seu serviço foi concluído':action==='advance'?'Seu serviço avançou de etapa':'Atualização do seu serviço';const step=d.steps[d.step_index]||'Concluído';const message=String(d.store)+' — '+String(d.process)+': '+(isEnd?'Serviço concluído.':'Etapa atual: '+step+'.');const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.EMAIL_FROM,to:[d.email],subject,text:message})});if(!response.ok)throw Error('Provedor de e-mail recusou a solicitação (HTTP '+response.status+')');}
const audit=(req,action,type,id,tenant=tid(req))=>q('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',[tenant,req.user.id,action,type,id]);
app.get('/health',(_req,res)=>res.json({ok:true,service:'nextvision'}));
app.post('/api/auth/login',rateLimit({windowMs:900000,limit:12,standardHeaders:'draft-7',legacyHeaders:false}),route(async(req,res)=>{const v=valid(z.object({email:z.string().email(),password:z.string().min(1)}),req,res);if(!v)return;const {rows}=await q('SELECT id,tenant_id,name,email,password_hash,role FROM users WHERE lower(email)=lower($1) AND active=true',[v.email]);const u=rows[0];if(!u||!(await bcrypt.compare(v.password,u.password_hash)))return bad(res,401,'Credenciais inválidas');if(!['master','technician'].includes(u.role)){const r=await q("SELECT status FROM tenants WHERE id=$1",[u.tenant_id]);if(!r.rows.length||!['trial','active'].includes(r.rows[0].status))return bad(res,403,'Loja indisponível');}const token=jwt.sign({id:u.id,tenant_id:u.tenant_id,role:u.role},secret,{algorithm:'HS256',expiresIn:'8h'});res.json({token,user:{id:u.id,name:u.name,email:u.email,role:u.role,tenant_id:u.tenant_id}});}));
app.get('/api/me',auth,(req,res)=>res.json(req.user));
app.get('/api/master/diagnostics',auth,roles('master'),route(async(req,res)=>{const r=await q("SELECT current_database() database, current_schema() schema, (SELECT count(*)::int FROM users) users_count, (SELECT count(*)::int FROM tenants) tenants_count, (SELECT count(*)::int FROM users WHERE role='master') masters_count");res.set('Cache-Control','no-store');res.json(r.rows[0]);}));
app.get('/api/master/tenants',auth,roles('master'),route(async(req,res)=>res.json((await q('SELECT t.*,(SELECT count(*)::int FROM cameras c WHERE c.tenant_id=t.id) cameras_count FROM tenants t ORDER BY created_at DESC')).rows)));
app.post('/api/master/tenants',auth,roles('master'),route(async(req,res)=>{const v=valid(z.object({name:z.string().min(2),slug:z.string().regex(/^[a-z0-9-]{3,60}$/),retention_days:z.number().int().min(1).max(365).default(15)}),req,res);if(!v)return;const r=await q('INSERT INTO tenants(name,slug,retention_days) VALUES($1,$2,$3) RETURNING *',[v.name,v.slug,v.retention_days]);await audit(req,'create','tenant',r.rows[0].id,r.rows[0].id);res.status(201).json(r.rows[0]);}));
app.patch('/api/master/tenants/:id',auth,roles('master'),route(async(req,res)=>{if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');const v=valid(z.object({status:z.enum(['trial','active','past_due','suspended'])}),req,res);if(!v)return;const r=await q('UPDATE tenants SET status=$1 WHERE id=$2 RETURNING *',[v.status,req.params.id]);if(!r.rowCount)return bad(res,404,'Loja não encontrada');await audit(req,'status','tenant',req.params.id,req.params.id);res.json(r.rows[0]);}));
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
 const r=await q("SELECT a.id,a.status,a.notes,a.created_at,a.completed_at,t.id tenant_id,t.name store,t.slug,(SELECT count(*)::int FROM cameras c WHERE c.tenant_id=t.id) camera_count FROM technician_assignments a JOIN tenants t ON t.id=a.tenant_id WHERE a.technician_id=$1 AND a.status!='cancelled' ORDER BY a.created_at DESC",[req.user.id]);res.json(r.rows);
}));
app.get('/api/technician/assignments/:id/cameras',auth,roles('technician'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');
 const r=await q("SELECT c.id,c.name,c.station,c.status,c.created_at FROM cameras c JOIN technician_assignments a ON a.tenant_id=c.tenant_id WHERE a.id=$1 AND a.technician_id=$2 AND a.status IN ('assigned','in_progress','completed') ORDER BY c.created_at",[req.params.id,req.user.id]);res.json(r.rows);
}));
app.post('/api/technician/assignments/:id/cameras',auth,roles('technician'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');
 const v=valid(z.object({name:z.string().trim().min(2).max(120),station:z.string().trim().max(120).default('')}),req,res);if(!v)return;
 const r=await q("INSERT INTO cameras(tenant_id,name,station) SELECT a.tenant_id,$3,$4 FROM technician_assignments a WHERE a.id=$1 AND a.technician_id=$2 AND a.status IN ('assigned','in_progress') RETURNING id,name,station,status",[req.params.id,req.user.id,v.name,v.station]);
 if(!r.rowCount)return bad(res,403,'Instalação não autorizada');res.status(201).json(r.rows[0]);
}));
app.patch('/api/technician/assignments/:id/cameras/:camera',auth,roles('technician'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success||!uuid.safeParse(req.params.camera).success)return bad(res,400,'ID inválido');
 const v=valid(z.object({name:z.string().trim().min(2).max(120),station:z.string().trim().max(120),status:z.enum(['unconfigured','testing','ready','offline'])}),req,res);if(!v)return;
 const r=await q("UPDATE cameras SET name=$1,station=$2,status=$3 WHERE id=$4 AND tenant_id IN(SELECT a.tenant_id FROM technician_assignments a WHERE a.id=$5 AND a.technician_id=$6 AND a.status IN ('assigned','in_progress')) RETURNING id,name,station,status",[v.name,v.station,v.status,req.params.camera,req.params.id,req.user.id]);
 if(!r.rowCount)return bad(res,403,'Câmera não disponível nesta instalação');res.json(r.rows[0]);
}));
app.patch('/api/technician/assignments/:id',auth,roles('technician'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');
 const v=valid(z.object({status:z.enum(['in_progress','completed'])}),req,res);if(!v)return;
 const r=await q("UPDATE technician_assignments SET status=$1,completed_at=CASE WHEN $1='completed' THEN now() ELSE NULL END WHERE id=$2 AND technician_id=$3 AND status IN ('assigned','in_progress') RETURNING id,status",[v.status,req.params.id,req.user.id]);
 if(!r.rowCount)return bad(res,409,'Instalação não disponível');res.json(r.rows[0]);
}));
app.get('/api/master/invoices',auth,roles('master'),route(async(req,res)=>res.json((await q('SELECT i.*,t.name tenant_name FROM invoices i JOIN tenants t ON t.id=i.tenant_id ORDER BY i.created_at DESC')).rows)));
app.get('/api/master/stats',auth,roles('master'),route(async(req,res)=>res.json((await q("SELECT (SELECT count(*)::int FROM tenants) tenants,(SELECT count(*)::int FROM cameras) cameras,(SELECT count(*)::int FROM invoices WHERE status='overdue') overdue_invoices")).rows[0])));
app.get('/api/store/settings',auth,roles('owner','operator'),route(async(req,res)=>{const r=await q('SELECT name,slug,logo_url,email_notifications FROM tenants WHERE id=$1',[tid(req)]);res.json(r.rows[0]||{});}));
app.patch('/api/store/settings',auth,roles('owner'),route(async(req,res)=>{const v=valid(z.object({name:z.string().min(2).max(120),logo_url:z.union([z.string().url().startsWith('https://').max(1000),z.literal('')]),email_notifications:z.enum(['off','steps','completed','all'])}),req,res);if(!v)return;const r=await q('UPDATE tenants SET name=$1,logo_url=$2,email_notifications=$3 WHERE id=$4 RETURNING name,slug,logo_url,email_notifications',[v.name,v.logo_url||null,v.email_notifications,tid(req)]);await audit(req,'update','tenant_settings',tid(req));res.json(r.rows[0]);}));
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
app.get('/api/cameras',auth,roles('master','owner','operator'),route(async(req,res)=>res.json((await q(req.user.role==='master'?'SELECT id,tenant_id,name,station,status,created_at FROM cameras ORDER BY created_at DESC':'SELECT id,tenant_id,name,station,status,created_at FROM cameras WHERE tenant_id=$1 ORDER BY created_at DESC',req.user.role==='master'?[]:[tid(req)])).rows)));
app.post('/api/cameras',auth,roles('owner'),route(async(req,res)=>{const v=valid(z.object({name:z.string().min(2),station:z.string().max(120).optional()}),req,res);if(!v)return;const r=await q('INSERT INTO cameras(tenant_id,name,station) VALUES($1,$2,$3) RETURNING id,name,station,status',[tid(req),v.name,v.station||null]);res.status(201).json(r.rows[0]);}));
app.patch('/api/cameras/:id',auth,roles('owner'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');
 const v=valid(z.object({name:z.string().trim().min(2).max(120),station:z.string().max(120)}),req,res);if(!v)return;
 const r=await q('UPDATE cameras SET name=$1,station=$2 WHERE id=$3 AND tenant_id=$4 RETURNING id,name,station,status',[v.name,v.station,req.params.id,tid(req)]);
 if(!r.rowCount)return bad(res,404,'Câmera não encontrada');await audit(req,'update','camera',req.params.id);res.json(r.rows[0]);
}));
app.get('/api/customers',auth,roles('owner','operator'),route(async(req,res)=>res.json((await q('SELECT * FROM customers WHERE tenant_id=$1 ORDER BY created_at DESC',[tid(req)])).rows)));
app.post('/api/customers',auth,roles('owner','operator'),route(async(req,res)=>{const v=valid(z.object({name:z.string().min(2),email:z.string().email().optional().or(z.literal('')),phone:z.string().max(30).optional(),address:z.string().max(500).optional()}),req,res);if(!v)return;const r=await q('INSERT INTO customers(tenant_id,name,email,phone,address) VALUES($1,$2,$3,$4,$5) RETURNING *',[tid(req),v.name,v.email||null,v.phone||null,v.address||null]);res.status(201).json(r.rows[0]);}));
app.post('/api/customers/import',auth,roles('owner','operator'),route(async(req,res)=>{
 const row=z.object({name:z.string().trim().min(2).max(120),email:z.union([z.string().email(),z.literal('')]).default(''),phone:z.string().max(30).default(''),address:z.string().max(500).default('')});
 const v=valid(z.object({customers:z.array(row).min(1).max(300)}),req,res);if(!v)return;
 const conn=await db.connect();
 try{await conn.query('BEGIN');for(const x of v.customers)await conn.query('INSERT INTO customers(tenant_id,name,email,phone,address) VALUES($1,$2,$3,$4,$5)',[tid(req),x.name,x.email||null,x.phone,x.address]);await conn.query('COMMIT');res.status(201).json({imported:v.customers.length})}
 catch(e){await conn.query('ROLLBACK');throw e}finally{conn.release()}
}));
app.patch('/api/customers/:id',auth,roles('owner','operator'),route(async(req,res)=>{if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');const v=valid(z.object({name:z.string().min(2).max(120),email:z.union([z.string().email(),z.literal('')]),phone:z.string().max(30),address:z.string().max(500)}),req,res);if(!v)return;const r=await q('UPDATE customers SET name=$1,email=$2,phone=$3,address=$4 WHERE id=$5 AND tenant_id=$6 RETURNING id,name,email,phone,address',[v.name,v.email||null,v.phone,v.address,req.params.id,tid(req)]);if(!r.rowCount)return bad(res,404,'Cliente não encontrado');await audit(req,'update','customer',req.params.id);res.json(r.rows[0]);}));
async function checkCameraMapping(tenant,cameraId,mapping){
 const ids=[cameraId,...Object.values(mapping||{})].filter(Boolean);
 if(ids.some(id=>!uuid.safeParse(id).success))return false;
 if(!ids.length)return true;
 const r=await q('SELECT id FROM cameras WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenant,ids]);
 return ids.every(id=>r.rows.some(x=>x.id===id));
}
const cameraMapping=z.record(z.string().regex(/^([0-9]|[12][0-9])$/),uuid).default({});
app.patch('/api/processes/:id',auth,roles('owner'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');
 const v=valid(z.object({name:z.string().trim().min(2).max(120),steps:z.array(z.string().trim().min(1).max(120)).min(1).max(30),camera_id:uuid.nullish(),step_cameras:cameraMapping}),req,res);if(!v)return;if(!await checkCameraMapping(tid(req),v.camera_id,v.step_cameras))return bad(res,400,'Câmera inválida');if(Object.keys(v.step_cameras).some(i=>Number(i)>=v.steps.length))return bad(res,400,'Etapa de câmera inválida');
 const active=await q("SELECT 1 FROM orders WHERE tenant_id=$1 AND process_id=$2 AND status!='completed' LIMIT 1",[tid(req),req.params.id]);
 if(active.rowCount)return bad(res,409,'Conclua os pedidos ativos deste processo antes de editar suas etapas');
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
  const r=await conn.query("SELECT id FROM orders WHERE tenant_id=$1 AND status='queued' ORDER BY COALESCE(queue_rank,9223372036854775807),created_at,id FOR UPDATE",[tid(req)]);
  if(r.rowCount!==v.ids.length||r.rows.some(x=>!v.ids.includes(x.id))){await conn.query('ROLLBACK');return bad(res,409,'A fila mudou. Atualize antes de reordenar');}
  for(let i=0;i<v.ids.length;i++)await conn.query('UPDATE orders SET queue_rank=$1 WHERE id=$2 AND tenant_id=$3',[(i+1)*1000,v.ids[i],tid(req)]);
  await conn.query('COMMIT');res.json({ok:true});
 }catch(e){await conn.query('ROLLBACK');throw e}finally{conn.release()}
}));
app.delete('/api/orders/:id',auth,roles('owner','operator'),route(async(req,res)=>{
 if(!uuid.safeParse(req.params.id).success)return bad(res,400,'Pedido inválido');
 const r=await q("UPDATE orders SET deleted_at=now() WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL AND status IN ('queued','completed') RETURNING id",[req.params.id,tid(req)]);
 if(!r.rowCount)return bad(res,409,'Pedido não encontrado ou em atendimento. Pause e finalize antes de excluir.');
 await audit(req,'archive','order',req.params.id);
 res.json({ok:true});
}));
app.get('/api/orders',auth,roles('owner','operator'),route(async(req,res)=>res.json((await q("SELECT o.id,o.status,o.step_index,o.camera_id,o.created_at,o.external_reference,o.source,o.queue_rank,o.share_code,c.name customer,p.id process_id,p.name process,p.steps FROM orders o LEFT JOIN customers c ON c.id=o.customer_id JOIN processes p ON p.id=o.process_id WHERE o.tenant_id=$1 AND o.deleted_at IS NULL ORDER BY CASE WHEN o.status='queued' THEN 0 ELSE 1 END,COALESCE(o.queue_rank,9223372036854775807),o.created_at,o.id",[tid(req)])).rows)));
app.post('/api/orders',auth,roles('owner','operator'),route(async(req,res)=>{const v=valid(z.object({customer_id:uuid,process_id:uuid}),req,res);if(!v)return;const token=crypto.randomBytes(12).toString('base64url');const hash=crypto.createHash('sha256').update(token).digest('hex');const r=await q('INSERT INTO orders(tenant_id,customer_id,process_id,camera_id,public_token_hash) SELECT $1,$2,$3,(SELECT camera_id FROM processes WHERE id=$3 AND tenant_id=$1),$4 WHERE EXISTS(SELECT 1 FROM customers WHERE id=$2 AND tenant_id=$1) AND EXISTS(SELECT 1 FROM processes WHERE id=$3 AND tenant_id=$1) RETURNING id,status',[tid(req),v.customer_id,v.process_id,hash]);if(!r.rowCount)return bad(res,400,'Cliente ou processo inválido');await audit(req,'create','order',r.rows[0].id);res.status(201).json({...r.rows[0],tracking_url:(process.env.PUBLIC_BASE_URL||'http://localhost:3000')+'/p/'+token});}));
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
app.post('/api/orders/:id/transition',auth,roles('owner','operator'),route(async(req,res)=>{if(!uuid.safeParse(req.params.id).success)return bad(res,400,'ID inválido');const v=valid(z.object({action:z.enum(['start','pause','resume','advance','complete'])}),req,res);if(!v)return;const c=await db.connect();try{await c.query('BEGIN');const r=await c.query('SELECT o.*,p.steps,p.camera_id process_camera_id,p.step_cameras FROM orders o JOIN processes p ON p.id=o.process_id WHERE o.id=$1 AND o.tenant_id=$2 FOR UPDATE OF o',[req.params.id,tid(req)]);const o=r.rows[0];if(!o){await c.query('ROLLBACK');return bad(res,404,'Pedido não encontrado');}const steps=o.steps;let status=o.status,index=o.step_index;if(v.action==='start'&&status==='queued')status='live';else if(v.action==='pause'&&status==='live')status='paused';else if(v.action==='resume'&&status==='paused')status='live';else if(v.action==='advance'&&status==='live'&&index<steps.length-1)index++;else if(v.action==='complete'&&status==='live'&&index===steps.length-1)status='completed';else{await c.query('ROLLBACK');return bad(res,409,'Transição inválida');}const mappedCamera=o.step_cameras?.[String(index)]||o.process_camera_id||null;const upd=await c.query("UPDATE orders SET camera_id=$4,status=$1,step_index=$2,started_at=CASE WHEN $1='live' AND started_at IS NULL THEN now() ELSE started_at END,completed_at=CASE WHEN $1='completed' THEN now() ELSE completed_at END WHERE id=$3 RETURNING id,status,step_index",[status,index,o.id,mappedCamera]);if(v.action==='complete'&&o.customer_id){await c.query('INSERT INTO loyalty_checkins(tenant_id,customer_id,order_id) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM tenants WHERE id=$1 AND loyalty_enabled=true) ON CONFLICT(order_id) DO NOTHING',[tid(req),o.customer_id,o.id]);}await c.query('INSERT INTO audit_events(tenant_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',[tid(req),req.user.id,v.action,'order',o.id]);await c.query('COMMIT');void notifyOrder(o.id,v.action).catch(e=>console.error('Falha no e-mail:',e.message));res.json(upd.rows[0]);}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}));
app.get('/api/public/orders/:token',rateLimit({windowMs:60000,limit:90}),route(async(req,res)=>{if(!/^[\w-]{16,100}$/.test(req.params.token))return bad(res,404,'Não encontrado');const hash=crypto.createHash('sha256').update(req.params.token).digest('hex');const r=await q("SELECT o.id,o.status,o.step_index,o.external_reference,p.name process,p.steps,t.name store,t.logo_url,t.loyalty_enabled,t.loyalty_target,t.loyalty_reward,CASE WHEN o.customer_id IS NOT NULL AND t.loyalty_enabled THEN (SELECT count(*)::int FROM loyalty_checkins l WHERE l.tenant_id=o.tenant_id AND l.customer_id=o.customer_id AND l.redemption_id IS NULL) ELSE NULL END loyalty_checkins,CASE WHEN o.customer_id IS NOT NULL AND t.loyalty_enabled THEN (SELECT coalesce(json_agg(json_build_object('status',lr.status,'reward',lr.reward_snapshot,'issued_at',lr.issued_at,'redeemed_at',lr.redeemed_at) ORDER BY lr.issued_at DESC),'[]'::json) FROM loyalty_redemptions lr WHERE lr.tenant_id=o.tenant_id AND lr.customer_id=o.customer_id) ELSE '[]'::json END loyalty_history,(SELECT count(*)::int FROM orders x WHERE x.tenant_id=o.tenant_id AND x.camera_id IS NOT DISTINCT FROM o.camera_id AND x.status='queued' AND x.created_at<o.created_at)+1 queue_position FROM orders o JOIN processes p ON p.id=o.process_id JOIN tenants t ON t.id=o.tenant_id WHERE (o.public_token_hash=$1 OR o.share_code=$2) AND t.status IN ('trial','active')",[hash,req.params.token]);if(!r.rowCount)return bad(res,404,'Pedido não encontrado');res.set('Cache-Control','no-store');res.json(r.rows[0]);}));
// Rota explícita da prévia, independente da resolução do diretório de trabalho.
app.get('/loja-preview.html',(_req,res)=>res.sendFile('loja-preview.html',{root:new URL('../public/',import.meta.url).pathname}));
app.use(express.static('public'));app.get('/p/:token',(_req,res)=>res.sendFile('tracking.html',{root:'public'}));
app.use((err,req,res,next)=>{console.error(err.code||err.name);if(err.code==='23505'){console.error('Violação de unicidade:',err.constraint||'desconhecida');return bad(res,409,err.constraint==='users_email_key'?'Este e-mail já está cadastrado':err.constraint==='tenants_slug_key'?'Este identificador de loja já existe':'Já existe um registro com esses dados');}if(err.code==='23503')return bad(res,400,'Referência inválida');return bad(res,500,'Erro interno');});
app.listen(Number(process.env.PORT||3000),async()=>{console.log('NextVision API pronta');try{const r=await q("SELECT current_database() AS database,(SELECT count(*)::int FROM users) AS users_count,(SELECT count(*)::int FROM tenants) AS tenants_count");console.log('Diagnóstico de conexão:',JSON.stringify(r.rows[0]));}catch(e){console.error('Diagnóstico de conexão falhou:',e.code||e.message)}});
