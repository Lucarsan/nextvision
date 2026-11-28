import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Tela "Entrar na unidade" com a trava ligada: sem o agente no PC aparece o aviso; com a ponte local
// (aqui simulada na mesma porta do agente, 47833) o caixa abre.
test('acesso: rede travada abre o caixa só com a ponte local do agente', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser, bridge;
  try {
    const { api, tenant, masterToken, base } = f;
    const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'audace', hostname: 'audace.example.test' } }, 201);
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api(`/master/tenants/${tenant}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: 'Benfica' } });
    await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-benfica' } });
    const code = await api(`/master/tenants/${tenant}/activation-codes`, { method: 'POST', token: masterToken }, 201);
    const pc = await api('/connect/activate', { method: 'POST', token: null, body: { activation_code: code.activation_code, device_name: 'PC Benfica' } }, 201);
    await api(`/master/tenants/${tenant}/device-lock`, { method: 'PATCH', token: masterToken, body: { enabled: true } });

    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox', '--host-resolver-rules=MAP audace.example.test 127.0.0.1'] });
    const page = await (await browser.newContext()).newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    const url = base.replace('127.0.0.1', 'audace.example.test') + '/acesso';
    const login = async () => { await page.goto(url); await page.waitForSelector('#unitForm:not([hidden])'); await page.fill('#unitPass', 'senha-benfica'); await page.click('#unitBtn'); };

    // Sem o agente: aviso claro, continua na tela.
    await login();
    await page.waitForFunction(() => /computador da unidade/.test(document.getElementById('unitError').textContent));
    assert.match(await page.textContent('#unitError'), /computador da unidade/);

    // Ponte local (como a do agente): CORS só para a página da rede; pede a prova à central com a credencial do PC.
    let asked = 0;
    bridge = http.createServer(async (req, res) => {
      const origin = req.headers.origin || '';
      const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Private-Network': 'true', Vary: 'Origin' };
      if (!origin.startsWith('http://audace.example.test')) { res.writeHead(403); return res.end(); }
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      asked++;
      const r = await fetch(base + '/api/connect/login-proof', { method: 'POST', headers: { Authorization: 'Bearer ' + pc.device_token } });
      res.writeHead(r.status, { ...cors, 'Content-Type': 'application/json' }); res.end(await r.text());
    });
    bridge.listen(47833, '127.0.0.1'); await once(bridge, 'listening');
    await login();
    await page.waitForURL(/\/caixa/, { timeout: 15000 });
    assert.equal(asked, 1);

    // Suporte da central: /caixa#sup= abre o caixa travado em outro PC, só naquela aba, e tira o token do endereço.
    const sup = await api(`/master/tenants/${tenant}/support-session`, { method: 'POST', token: masterToken });
    const tab = await (await browser.newContext()).newPage(); tab.on('pageerror', e => errors.push(e.message));
    await tab.goto(base + '/caixa#sup=' + encodeURIComponent(sup.token));
    await tab.waitForTimeout(2500);
    assert.match(tab.url(), /\/caixa$/); assert.match(await tab.title(), /Benfica/);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (bridge) await new Promise(r => bridge.close(r));
    await f.cleanup();
  }
});
