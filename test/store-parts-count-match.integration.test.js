import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('peças: lugar, conferência, peça pelo aparelho e o que saiu', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true, niche: 'electronics' } });
    const a12 = await api('/store/products', { method: 'POST', body: { kind: 'part', name: 'Tela', device_model: 'Samsung A02/A12', location: 'Caixa 01', cost_cents: 8000, price_cents: 17000, stock_qty: 2 } }, 201);
    assert.equal(a12.location, 'Caixa 01'); assert.equal(a12.counted_at, null);
    const ca = await api('/store/products', { method: 'POST', body: { kind: 'part', name: 'Tela com aro', device_model: 'Moto G9 Power', location: 'Caixa 04', cost_cents: 8500, price_cents: 20500, stock_qty: 1 } }, 201);
    await api('/store/products', { method: 'POST', body: { kind: 'part', name: 'Tela sem aro', device_model: 'Moto G9 Power', location: 'Caixa 04', cost_cents: 8500, price_cents: 20500, stock_qty: 1 } }, 201);
    await api('/store/products', { method: 'POST', body: { kind: 'part', name: 'Tela', device_model: 'Redmi Note 8', location: 'Caixa 05', cost_cents: 7000, price_cents: 19000, stock_qty: 2 } }, 201);
    // Ordem: pelo lugar; busca acha pela caixa.
    assert.deepEqual((await api('/store/products?kind=part')).map(p => p.location), ['Caixa 01', 'Caixa 04', 'Caixa 04', 'Caixa 05']);
    assert.equal((await api('/store/products?kind=part&q=caixa 05'))[0].device_model, 'Redmi Note 8');
    // Lugar muda na edição (com senha do admin, como toda edição de peça).
    const edited = await api('/store/products/' + a12.id, { method: 'PATCH', admin: true, body: { location: 'Caixa 02' } });
    assert.equal(edited.location, 'Caixa 02');

    // Conferência: substitui a quantidade, marca conferido e registra a diferença no log.
    let p = await api(`/store/products/${a12.id}/count`, { method: 'POST', body: { qty: 5 } });
    assert.equal(p.stock_qty, 5); assert.ok(p.counted_at);
    p = await api(`/store/products/${a12.id}/count`, { method: 'POST', body: { qty: 5 } });
    const log = (await api('/store/stock/log?product_id=' + a12.id)).rows;
    assert.equal(log.filter(m => m.kind === 'adjust').length, 1, 'mesma quantidade: sem movimento novo');
    assert.equal(log[0].note, 'Conferência: contado 5 (sobrava 3 a mais)'); assert.equal(log[0].stock_before, 2); assert.equal(log[0].stock_after, 5);
    assert.equal((await request(`/store/products/${a12.id}/count`, { method: 'POST', body: { qty: -1 } })).status, 400);
    assert.ok([403, 404].includes((await request(`/store/products/${a12.id}/count`, { method: 'POST', body: { qty: 1 }, token: f.foreignToken })).status), 'outra loja não mexe');

    // Peça pelo aparelho digitado.
    let m = await api('/store/parts/match?model=' + encodeURIComponent('Galaxy A12') + '&service=' + encodeURIComponent('Troca de tela'));
    assert.deepEqual(m.map(x => [x.id, x.match, x.price_cents, x.cost_cents]), [[a12.id, 'exact', 17000, 8000]]);
    m = await api('/store/parts/match?model=G9%20Power');
    assert.deepEqual(m.map(x => x.name).sort(), ['Tela com aro', 'Tela sem aro']);
    assert.deepEqual(await api('/store/parts/match?model=A12&service=' + encodeURIComponent('Troca de conector')), []);
    { const r = await request('/store/parts/match?model=A12', { token: f.foreignToken }); assert.ok(r.status !== 200 || !r.data.length, 'outra loja não vê'); }

    // Usou a peça num serviço: baixa 1, entra em "O que saiu" e na reposição; cancelar devolve.
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const s1 = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ service: 'Troca de tela', unit_price_cents: 17000, part_id: a12.id, device_model: 'A12' }] } }, 201);
    await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ service: 'Troca de tela', unit_price_cents: 20500, part_id: ca.id }] } }, 201);
    let out = await api('/store/stock/outflow?kind=part');
    assert.deepEqual(out.rows.map(r => [r.device_model, r.qty, r.stock_qty, r.pending]).sort(), [['Moto G9 Power', 1, 0, 1], ['Samsung A02/A12', 1, 4, 1]]);
    assert.deepEqual(out.rows.find(r => r.product_id === a12.id).sales, [s1.sale.sale_number]);
    assert.equal(out.rows.find(r => r.product_id === a12.id).location, 'Caixa 02');
    assert.equal((await api('/store/stock/outflow?kind=product')).rows.length, 0);
    await api(`/store/sales/${s1.sale.id}/cancel`, { method: 'POST', body: { reason: 'lançado errado' } });
    out = await api('/store/stock/outflow?kind=part');
    assert.deepEqual(out.rows.map(r => r.device_model), ['Moto G9 Power'], 'cancelado não conta como saída');
    assert.equal((await api('/store/stock/restock')).find(r => r.product_id === ca.id).location, 'Caixa 04');
  } finally { await f.cleanup(); }
});

test('painel: conferir peças, tela pelo aparelho no caixa e na OS, o que saiu', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const { createRequire } = await import('node:module');
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    await context.addInitScript(value => { sessionStorage.setItem('nv_token', value); window.__opened = []; window.open = () => null; window.confirm = () => true; }, f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'electronics' } });
    const mk = (name, model, loc, cost, price, qty) => f.api('/store/products', { method: 'POST', body: { kind: 'part', name, device_model: model, location: loc, cost_cents: cost, price_cents: price, stock_qty: qty } }, 201);
    const a12 = await mk('Tela', 'Samsung A02/A12', 'Caixa 01', 8000, 17000, 2);
    await mk('Tela', 'Samsung A14 4G', 'Caixa 01', 10000, 16000, 1);
    await mk('Tela', 'Samsung A14 5G', 'Caixa 01', 8000, 19000, 1);
    await mk('Tela', 'Redmi Note 8', 'Caixa 05', 7000, 19000, 2);
    await f.api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);

    await page.goto(f.base + '/loja.html');
    // Estoque → Peças: agrupado por caixa, conferir com Enter vai para a próxima.
    await page.locator('.nv-sidebar [data-view="cash"]').click(); await page.waitForSelector('#fsSale');
    await page.locator('#fsProducts').click(); await page.locator('[data-ptab=parts]').click();
    await page.waitForSelector('[data-p-count]');
    assert.deepEqual(await page.locator('.fs-part-loc').allInnerTexts(), ['CAIXA 01', 'CAIXA 05']);
    assert.match(await page.locator('#fsPartFilter').innerText(), /A conferir \(4\)/);
    const first = page.locator(`[data-p-count="${a12.id}"]`);
    await first.fill('3'); await first.press('Enter');
    await page.waitForFunction(() => document.activeElement?.dataset?.pCount && document.activeElement.closest('.fs-part').innerText.includes('A14 4G'));
    assert.match(await page.locator(`[data-part="${a12.id}"]`).innerText(), /conferido/);
    assert.match(await page.locator('#fsPartFilter').innerText(), /A conferir \(3\)/);
    await page.screenshot(shot('pecas-conferir'));
    // Reposição → O que saiu (ainda nada).
    await page.locator('[data-ptab=restock]').click(); await page.locator('[data-rv=out]').click();
    await page.waitForSelector('#fsOutList:has-text("Nada saiu")');
    await page.locator('[data-close-dialog]').first().click();

    // Caixa → Serviço: digitar o aparelho já põe a tela com preço e custo.
    await page.getByRole('button', { name: 'Serviço', exact: true }).click();
    await page.locator('#fsSvcModel').fill('A12'); await page.locator('#fsSvcModel').press('Tab');
    await page.waitForFunction(() => document.querySelector('#fsSvcPart .fs-picked'));
    assert.match(await page.locator('#fsSvcPart').innerText(), /Tela · Samsung A02\/A12[\s\S]*custo R\$\s?80,00[\s\S]*estoque 3/);
    assert.equal(await page.locator('#fsSvcPrice').inputValue(), '170,00');
    assert.equal(await page.locator('#fsSvcCost').inputValue(), '80,00');
    assert.equal(await page.locator('#fsSvcModel').inputValue(), 'A12', 'o aparelho fica como foi digitado');
    assert.equal(await page.locator('#fsSvcName').inputValue(), 'Troca de tela');
    // Trocou o aparelho: a tela sai; A14 tem duas, escolhe com um toque.
    await page.locator('#fsSvcModel').fill('A14'); await page.locator('#fsSvcModel').press('Tab');
    await page.waitForFunction(() => document.querySelectorAll('#fsSvcModelHit [data-hit]').length === 2);
    assert.equal(await page.locator('#fsSvcPrice').inputValue(), '');
    await page.screenshot(shot('caixa-tela-pelo-aparelho'));
    await page.locator('#fsSvcModelHit [data-hit]', { hasText: '5G' }).click();
    assert.equal(await page.locator('#fsSvcPrice').inputValue(), '190,00');
    assert.equal(await page.locator('#fsSvcModel').inputValue(), 'A14');

    // OS: marca + modelo → tela, valor e custo; trocar o modelo troca a tela.
    await page.locator('.nv-sidebar [data-view="dayservices"]').click();
    await page.locator('#soNew').click();
    await page.locator('#soForm [name=brand]').fill('Xiaomi');
    await page.locator('#soForm [name=model]').fill('Note 8');
    await page.waitForFunction(() => /Redmi Note 8/.test(document.getElementById('soPart')?.innerText || ''));
    assert.equal(await page.locator('#soForm [name=price]').inputValue(), '190,00');
    assert.equal(await page.locator('#soForm [name=cost]').inputValue(), '70,00');
    assert.equal(await page.locator('#soForm [name=service]').inputValue(), 'Troca de tela');
    await page.locator('#soForm [name=brand]').fill('Samsung');
    await page.locator('#soForm [name=model]').fill('A12');
    await page.waitForFunction(() => /A02\/A12/.test(document.getElementById('soPart')?.innerText || ''));
    assert.equal(await page.locator('#soForm [name=price]').inputValue(), '170,00');
    await page.locator('#soForm [name=price]').fill('180,00');
    await page.locator('#soForm [name=model]').fill('A14');
    await page.waitForFunction(() => document.querySelectorAll('#soModelHit [data-hit]').length === 2 && !document.querySelector('#soPart .fs-picked'));
    assert.equal(await page.locator('#soForm [name=price]').inputValue(), '180,00', 'valor digitado à mão fica');
    await page.screenshot(shot('os-tela-pelo-aparelho'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
