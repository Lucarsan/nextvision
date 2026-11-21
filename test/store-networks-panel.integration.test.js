import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Painéis da rede: a central monta a rede pela aba "Redes" e o dono da rede vê o faturamento por unidade em /rede.html.
test('central monta a rede e o dono da rede vê o painel', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => process.env.SHOT_DIR ? { path: process.env.SHOT_DIR + '/' + name + '.png', fullPage: true } : {};
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    // O endereço próprio da rede aponta para o servidor de teste.
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox', '--host-resolver-rules=MAP audace.ficoupronto.com 127.0.0.1'] });
    const { api, tenant, masterToken, base } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });

    // Central: cria a rede e liga a loja de teste pela aba Redes.
    const central = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await central.addInitScript(v => sessionStorage.setItem('nv_token', v), masterToken);
    const cp = await central.newPage(); const errors = []; cp.on('pageerror', e => errors.push(e.message));
    await cp.goto(base + '/central.html');
    await cp.getByRole('button', { name: 'Redes' }).click();
    await cp.fill('#netName', 'Audace Joias'); await cp.fill('#netSlug', 'audace'); await cp.fill('#netHost', 'audace.ficoupronto.com');
    await cp.click('#netCreate');
    await cp.waitForSelector('#unAddBtn');
    await cp.selectOption('#unAdd', tenant); await cp.click('#unAddBtn');
    await cp.waitForSelector('.unLabel');
    await cp.fill('.unLabel', 'Maracanaú'); await cp.fill('.unCnpj', '11.222.333/0001-81'); await cp.click('.unSave');
    await cp.waitForFunction(() => document.getElementById('feedback').textContent.includes('Unidade salva')).catch(async e => { console.error('FEEDBACK', await cp.textContent('#feedback'), await cp.inputValue('.unCnpj')); throw e; });
    // Pessoas: o dono (senha temporária mostrada uma vez) e uma consultora da unidade.
    await cp.fill('.pNew .pName', 'Gabriel Mota'); await cp.fill('.pNew .pEmail', 'gabriel@audace.test'); await cp.selectOption('.pNew .pFunc', 'dono');
    assert.equal(await cp.isVisible('.pNew .pUnit'), false);
    await cp.click('.pNew .pAdd');
    await cp.waitForFunction(() => document.getElementById('feedback').textContent.includes('Senha temporária'));
    const gabrielPass = /Senha temporária \(aparece só agora\): (\S+)/.exec(await cp.textContent('#feedback'))[1];
    await cp.fill('.pNew .pName', 'Consultora Maracanaú 1'); await cp.fill('.pNew .pEmail', 'c1@audace.test'); await cp.selectOption('.pNew .pFunc', 'consultora');
    await cp.selectOption('.pNew .pUnit', tenant); await cp.click('.pNew .pAdd');
    await cp.waitForFunction(() => document.body.innerHTML.includes('c1@audace.test') && document.getElementById('feedback').textContent.includes('Senha temporária'));
    // Supervisor: as unidades aparecem como caixas de marcar.
    await cp.selectOption('.pNew .pFunc', 'supervisor');
    assert.equal(await cp.isVisible('.pNew .pUnits'), true); assert.equal(await cp.isVisible('.pNew .pUnit'), false);
    await cp.screenshot(shot('central-redes'));
    assert.deepEqual(errors, []);
    const net = (await api('/master/networks', { token: masterToken }))[0];
    assert.equal(net.units_count, 1);

    // Mais duas unidades, meta do mês, vendas (uma repetida e uma cancelada) e uma peça acabando.
    const { db } = f;
    const solares = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Solares', slug: 'audace-solares-' + Date.now() } }, 201);
    const benfica = await api('/master/tenants', { method: 'POST', token: masterToken, body: { name: 'Audace Benfica', slug: 'audace-benfica-' + Date.now() } }, 201);
    for (const [id, label] of [[solares.id, 'Solares'], [benfica.id, 'Benfica']]) {
      await api('/master/tenants/' + id, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
      await api(`/master/tenants/${id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: label } });
    }
    const solaresOwner = await f.addOwner(solares.id);
    for (const [id, cents] of [[tenant, 80000], [solares.id, 120000]]) await db.query("INSERT INTO store_goals(tenant_id, month, target_cents) VALUES($1, date_trunc('month', now() AT TIME ZONE 'America/Fortaleza')::date, $2)", [id, cents]);
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 18990, payment_method: 'credit' } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 7990, payments: [{ method: 'cash', amount_cents: 2990 }, { method: 'pix', amount_cents: 5000 }] } }, 201);
    const rep = await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 21900, payment_method: 'credit' } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 21900, payment_method: 'credit' } }, 201);
    const prod = (await db.query("INSERT INTO products(tenant_id, name, price_cents, stock_qty) VALUES($1, 'Argola prata 925 média', 21900, 1) RETURNING id", [tenant])).rows[0].id;
    await db.query("INSERT INTO sale_items(tenant_id, sale_id, product_id, name, quantity, unit_price_cents, total_cents) VALUES($1, $2, $3, 'Argola prata 925 média', 1, 21900, 21900)", [tenant, rep.sale.id, prod]);
    await api('/store/cash/open', { method: 'POST', token: solaresOwner, body: { opening_cents: 0 } }, 201);
    for (const c of [14990, 12900, 9900]) await api('/store/sales', { method: 'POST', token: solaresOwner, body: { anonymous: true, total_cents: c, payment_method: 'pix' } }, 201);
    const can = await api('/store/sales', { method: 'POST', token: solaresOwner, body: { anonymous: true, total_cents: 12900, payment_method: 'debit' } }, 201);
    await api(`/store/sales/${can.sale.id}/cancel`, { method: 'POST', token: solaresOwner, body: { reason: 'Cliente desistiu da troca' } });

    // Dono da rede: entra pelo endereço da Audace (tela de acesso com a marca) e vê o painel.
    const origin = base.replace('127.0.0.1', 'audace.ficoupronto.com');
    const rede = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const rp = await rede.newPage(); rp.on('pageerror', e => errors.push(e.message));
    await rp.goto(origin + '/');
    await rp.waitForURL(/\/acesso$/);
    await rp.waitForFunction(() => document.getElementById('wmName').textContent === 'AUDACE');
    assert.equal(await rp.textContent('#wmSub'), 'JOIAS');
    await rp.screenshot(shot('acesso-rede'));
    await rp.fill('#email', 'gabriel@audace.test'); await rp.fill('#password', gabrielPass); await rp.click('#loginBtn');
    await rp.waitForURL(/\/rede\.html$/);
    await rp.waitForFunction(() => document.getElementById('rows').textContent.includes('Solares'));
    await rp.waitForFunction(() => document.getElementById('who').textContent.includes('Gabriel'));
    const kpis = await rp.textContent('#kpis');
    assert.match(kpis, /Faturamento hoje/); assert.match(kpis, /R\$\s?1\.085,70/); assert.match(kpis, /Vendas\s*7/); assert.match(kpis, /1 cancelada/);
    const rows = await rp.textContent('#rows');
    assert.match(rows, /Maracanaú/); assert.match(rows, /88%/); assert.match(rows, /Aberto/); assert.match(rows, /Fechado/); assert.match(rows, /sem meta/);
    const alerts = await rp.textContent('#alerts');
    assert.match(alerts, /Possível venda duplicada/); assert.match(alerts, /1 venda cancelada hoje/); assert.match(alerts, /Estoque baixo em Maracanaú/);
    await rp.screenshot(shot('painel-rede'));
    // Filtro por unidade.
    await rp.selectOption('#unitSel', { label: 'Solares' });
    assert.match(await rp.textContent('#sub'), /Solares/);
    assert.doesNotMatch(await rp.textContent('#alerts'), /Maracanaú/);
    await rp.selectOption('#unitSel', '');
    await rp.setViewportSize({ width: 390, height: 844 }); await rp.screenshot(shot('painel-rede-celular'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
