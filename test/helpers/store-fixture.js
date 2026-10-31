import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import pg from 'pg';
import jwt from 'jsonwebtoken';

export async function createStoreFixture() {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Use a local test database');
  const schema = 'nv_panel_' + crypto.randomBytes(8).toString('hex');
  const db = new pg.Client({ connectionString: url.toString(), ssl: false });
  let server;
  await db.connect();
  const cleanup = async () => {
    if (server && server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end();
  };
  try {
    await db.query(`CREATE SCHEMA ${schema}`); await db.query(`SET search_path TO ${schema},public`);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    const env = { ...process.env, DATABASE_URL: url.toString(), DB_SSL: 'disable' };
    const migrate = () => { const run = spawnSync(process.execPath, ['src/migrate.js'], { env, encoding: 'utf8' }); assert.equal(run.status, 0, run.stderr); };
    migrate();
    const [tenant, foreignTenant, masterId] = Array.from({ length: 3 }, () => crypto.randomUUID());
    await db.query("INSERT INTO tenants(id,name,slug,status) VALUES($1,'Loja de teste',$2,'active'),($3,'Outra loja',$4,'active')", [tenant, schema, foreignTenant, schema + '-foreign']);
    await db.query("INSERT INTO users(id,name,email,password_hash,role) VALUES($1,'Master',$2,'unused','master')", [masterId, schema + '-master@example.test']);
    const secret = crypto.randomBytes(32).toString('hex');
    const masterToken = jwt.sign({ id: masterId, tenant_id: null, role: 'master' }, secret, { algorithm: 'HS256' });
    const addOwner = async tenantId => {
      const id = crypto.randomUUID(); await db.query("INSERT INTO users(id,tenant_id,name,email,password_hash,role) VALUES($1,$2,'Owner',$3,'unused','owner')", [id, tenantId, id + '@example.test']);
      return jwt.sign({ id, tenant_id: tenantId, role: 'owner' }, secret, { algorithm: 'HS256' });
    };
    const ownerToken = await addOwner(tenant), foreignToken = await addOwner(foreignTenant);
    const addOperator = async (tenantId, accessLevel = 'full', name = 'Operador') => {
      const id = crypto.randomUUID(); await db.query("INSERT INTO users(id,tenant_id,name,email,password_hash,role,access_level) VALUES($1,$2,$3,$4,'unused','operator',$5)", [id, tenantId, name, id + '@example.test', accessLevel]);
      return { id, token: jwt.sign({ id, tenant_id: tenantId, role: 'operator' }, secret, { algorithm: 'HS256' }) };
    };
    const addTechnician = async () => {
      const id=crypto.randomUUID();await db.query("INSERT INTO users(id,name,email,password_hash,role) VALUES($1,'Technician',$2,'unused','technician')",[id,id+'@example.test']);
      return {id,token:jwt.sign({id,tenant_id:null,role:'technician'},secret,{algorithm:'HS256'})};
    };
    const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const { port } = listener.address(); await new Promise(resolve => listener.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['src/server.js'], { env: { ...env, JWT_SECRET: secret, PORT: String(port), RESEND_API_KEY: '', EMAIL_FROM: '' }, stdio: ['ignore', 'ignore', 'pipe'] }); if (process.env.FP_DEBUG) server.stderr.pipe(process.stderr); else server.stderr.resume();
    const request = async (path, { method = 'GET', body, token = ownerToken } = {}) => {
      const response = await fetch(base + '/api' + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
      return { status: response.status, data: await response.json() };
    };
    const api = async (path, options, status = 200) => { const result = await request(path, options); assert.equal(result.status, status, result.data.error); return result.data; };
    for (let i = 0; ; i++) { try { const response=await fetch(base+'/health');assert.equal(response.status,200);break; } catch { assert.ok(i < 40, 'API must start'); await new Promise(resolve => setTimeout(resolve, 100)); } }
    return { db, tenant, foreignTenant, masterToken, ownerToken, foreignToken, base, request, api, addOwner, addOperator, addTechnician, migrate, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
