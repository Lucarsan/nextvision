import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createStoreFixture } from './helpers/store-fixture.js';

// Sem rede nos testes: nenhum domínio, host ou chave de API.
Object.assign(process.env, { MONITOR_DOMAINS: '', MONITOR_HOSTS: '', PUBLIC_BASE_URL: '', NEON_API_KEY: '', RENDER_API_KEY: '', TELEGRAM_BOT_TOKEN: '', QUIET_HOURS: 'off' });
const { dbChecks, runMonitoring } = await import('../src/monitoring.js');

const skip = process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL';
const MONDAY_10H = new Date('2026-11-16T13:00:00Z'); // segunda 10h em Fortaleza

test('monitoramento: lojas, alertas, resolução e rotas da central', { skip, timeout: 60000 }, async () => {
  const f = await createStoreFixture({ env: { MONITOR_DOMAINS: '', MONITOR_HOSTS: '', PUBLIC_BASE_URL: '' } });
  const q = (sql, v) => f.db.query(sql, v);
  try {
    const dev = crypto.randomUUID();
    await q(`INSERT INTO shop_devices(id,tenant_id,name,credential_hash,enabled,last_seen_at,health,health_at,agent_version)
      VALUES($1,$2,'PC balcão',$3,true,$4,$5,$6,'0.5.1')`, [dev, f.tenant, crypto.randomBytes(32).toString('hex'), new Date(MONDAY_10H - 60 * 60000),
      { components: { disk: { state: 'degraded', detail: '1,5 GB livres' }, tunnel: { state: 'ok' }, publisher: { state: 'down', detail: 'sem imagem' } }, cameras: [{ id: 'c1', state: 'down', detail: 'senha errada' }] }, MONDAY_10H]);

    // Segunda 10h, servidor acordado há 1 h: PC sem sinal há 1 h é crítico; disco e câmera também aparecem.
    const r = await dbChecks(q, MONDAY_10H, { awakeMinutes: 60 });
    const by = Object.fromEntries(r.items.map(x => [x.key, x]));
    assert.equal(by['device.offline.' + dev].severity, 'critical');
    assert.equal(by['device.disk.' + dev].severity, 'critical');
    assert.equal(by['device.publisher.' + dev].severity, 'critical');
    assert.equal(by['camera.c1'].severity, 'warn');
    // PC que não ligou hoje (último sinal ontem): atenção, só 3 h depois da abertura; parado há dias: só informação.
    const dev2 = crypto.randomUUID(), dev3 = crypto.randomUUID();
    await q(`INSERT INTO shop_devices(id,tenant_id,name,credential_hash,enabled,last_seen_at) VALUES($1,$2,'PC ontem',$3,true,'2026-11-14T21:00:00Z'),($4,$2,'PC teste',$5,true,'2026-10-28T23:44:00Z')`,
      [dev2, f.tenant, crypto.randomBytes(32).toString('hex'), dev3, crypto.randomBytes(32).toString('hex')]);
    const r2 = Object.fromEntries((await dbChecks(q, MONDAY_10H, { awakeMinutes: 60 })).items.map(x => [x.key, x]));
    assert.equal(r2['device.notstarted.' + dev2 + '.2026-11-16'].severity, 'warn');
    assert.equal(r2['device.inactive.' + dev3].severity, 'info');
    assert.equal(r2['device.offline.' + dev2], undefined);
    const early = (await dbChecks(q, new Date('2026-11-16T11:00:00Z'), { awakeMinutes: 60 })).items.map(x => x.key); // 8h: cedo para "não ligou"
    assert.equal(early.some(k => k.startsWith('device.notstarted.' + dev2)), false);
    await q('DELETE FROM shop_devices WHERE id = ANY($1)', [[dev2, dev3]]);
    // De manhã cedo (acordado há 5 min) o "visto por último" é da véspera: não alarma.
    assert.equal((await dbChecks(q, MONDAY_10H, { awakeMinutes: 5 })).items.some(x => x.key.startsWith('device.offline')), false);
    // Domingo: loja fechada, sem alarme de PC desligado.
    assert.equal((await dbChecks(q, new Date('2026-11-15T13:00:00Z'), { awakeMinutes: 60 })).items.some(x => x.key.startsWith('device.offline')), false);

    // Rodada completa grava os alertas; quando o problema some, o alerta é resolvido.
    await q('UPDATE shop_devices SET last_seen_at=now(),health_at=now() WHERE id=$1', [dev]);
    await runMonitoring(q, { notify: false, forceExternal: true });
    const open = (await q("SELECT key,severity FROM platform_alerts WHERE status='open'")).rows.map(x => x.key);
    assert.ok(open.includes('device.disk.' + dev) && open.includes('alerts.telegram'), open.join());
    await q("UPDATE shop_devices SET health=jsonb_set(health,'{components,disk}','{\"state\":\"ok\",\"detail\":\"80 GB livres\"}') WHERE id=$1", [dev]);
    await runMonitoring(q, { notify: false });
    assert.equal((await q("SELECT status FROM platform_alerts WHERE key=$1", ['device.disk.' + dev])).rows[0].status, 'resolved');

    // Aviso é anotado: a rodada seguinte não repete (antes repetia a cada 10 min).
    await q("UPDATE shop_devices SET health=jsonb_set(health,'{components,disk}','{\"state\":\"degraded\",\"detail\":\"1 GB livres\"}'),health_at=now() WHERE id=$1", [dev]);
    await runMonitoring(q, { notify: true });
    const first = (await q('SELECT notified_at,notified_severity FROM platform_alerts WHERE key=$1', ['device.disk.' + dev])).rows[0];
    assert.ok(first.notified_at, 'anotou o aviso'); assert.equal(first.notified_severity, 'critical');
    await runMonitoring(q, { notify: true });
    assert.equal((await q('SELECT notified_at FROM platform_alerts WHERE key=$1', ['device.disk.' + dev])).rows[0].notified_at.getTime(), first.notified_at.getTime());
    // Rotas da central (o servidor de teste roda sem rede e sem chaves).
    const view = await f.api('/master/monitoring', { token: f.masterToken });
    assert.equal(view.channels.telegram.token, false);
    assert.ok(view.alerts.some(a => a.key === 'alerts.telegram'));
    const sum = await f.api('/master/monitoring/summary', { token: f.masterToken });
    assert.ok(sum.warn >= 1);
    await f.api('/master/monitoring/ack', { method: 'POST', token: f.masterToken, body: { key: 'alerts.telegram' } });
    assert.equal((await f.api('/master/monitoring/summary', { token: f.masterToken })).warn, sum.warn - 1);
    await f.api('/master/monitoring/settings', { method: 'PATCH', token: f.masterToken, body: { alert_email: 'dono@example.test' } });
    assert.equal((await f.api('/master/monitoring', { token: f.masterToken })).channels.email.to, 'dono@example.test');
    assert.equal((await f.request('/master/monitoring', { token: f.ownerToken })).status, 403);
    assert.equal((await f.request('/master/monitoring/telegram/link', { method: 'POST', token: f.masterToken })).status, 400);
  } finally { await f.cleanup(); }
});
