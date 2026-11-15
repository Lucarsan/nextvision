import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';
import { isOpen, parseHours, parseDays } from '../src/quiet-hours.js';

const at = iso => new Date(iso); // horários em UTC; Fortaleza = UTC-3
const opts = { hours: parseHours('06:45-19:00'), days: parseDays('1-6'), tz: 'America/Fortaleza' };

test('expediente: seg a sáb 6h45-19h em Fortaleza, domingo fechado', () => {
  assert.equal(isOpen(at('2026-11-16T09:44:00Z'), opts), false); // seg 6h44
  assert.equal(isOpen(at('2026-11-16T09:45:00Z'), opts), true);  // seg 6h45
  assert.equal(isOpen(at('2026-11-16T21:59:00Z'), opts), true);  // seg 18h59
  assert.equal(isOpen(at('2026-11-16T22:00:00Z'), opts), false); // seg 19h00
  assert.equal(isOpen(at('2026-11-16T22:05:00Z'), { ...opts, graceMin: 10 }), true); // 19h05 com folga das rotinas
  assert.equal(isOpen(at('2026-11-21T15:00:00Z'), opts), true);  // sáb 12h
  assert.equal(isOpen(at('2026-11-15T15:00:00Z'), opts), false); // dom 12h
  assert.equal(isOpen(at('2026-11-17T03:00:00Z'), opts), false); // ter 0h
});

test('fora do expediente: computador da loja não acorda o banco; uso humano acorda', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 60000
}, async () => {
  const f = await createStoreFixture({ env: { QUIET_HOURS: 'force', QUIET_IDLE_MINUTES: '0.01' } }); // ocioso após 0,6 s
  const { api, db } = f;
  const idle = () => new Promise(r => setTimeout(r, 900));
  try {
    const code = await api('/master/tenants/' + f.tenant + '/activation-codes', { method: 'POST', token: f.masterToken }, 201);
    const device = (await api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: 'PC' } }, 201)).device_token;
    const beat = v => api('/connect/heartbeat', { method: 'POST', token: device, body: { agent_version: v, components: { service: { state: 'ok' } }, cameras: [] } });
    const seen = async () => (await db.query('SELECT agent_version FROM shop_devices WHERE tenant_id=$1', [f.tenant])).rows[0].agent_version;

    await idle();
    // Primeiro contato depois de reiniciar: confere no banco (e guarda o computador).
    assert.equal((await beat('0.5.1')).quiet, undefined);
    assert.equal(await seen(), '0.5.1');
    const jobs1 = await api('/connect/recording-jobs', { token: device });
    // Já conhecido e ninguém usando: responde sem gravar nada.
    assert.equal((await beat('0.5.2')).quiet, true);
    assert.equal(await seen(), '0.5.1');
    await db.query("UPDATE shop_devices SET enabled=false WHERE tenant_id=$1", [f.tenant]);
    assert.deepEqual(await api('/connect/recording-jobs', { token: device }), jobs1, 'lista guardada, sem consulta');

    // Alguém abre a central/loja: volta ao normal na hora (e o bloqueio passa a valer).
    await api('/me', { token: f.ownerToken });
    assert.equal((await f.request('/connect/heartbeat', { method: 'POST', token: device, body: { agent_version: '0.5.3', components: {}, cameras: [] } })).status, 403);
    await db.query("UPDATE shop_devices SET enabled=true WHERE tenant_id=$1", [f.tenant]);
    assert.equal((await beat('0.5.3')).quiet, undefined);
    assert.equal(await seen(), '0.5.3');
  } finally { await f.cleanup(); }
});
