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
    assert.ok((await api('/store/stock/restock?kind=product')).every(r => r.kind === 'product'));

    // Serviço com aparelho e sem peça escolhida: uma só tela serve → ela é usada (baixa 1, reposição +1).
    const before = (await api('/store/products?kind=part&q=note 8'))[0];
    const s3 = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ service: 'Troca de tela', unit_price_cents: 19000, device_model: 'Note 8' }] } }, 201);
    assert.equal(s3.sale.items[0].unit_cost_cents, 7000);
    let after = (await api('/store/products?kind=part&q=note 8'))[0];
    assert.deepEqual([after.stock_qty, after.restock_pending], [before.stock_qty - 1, before.restock_pending + 1]);
    // G9 Power tem duas (com/sem aro): não escolhe sozinho; conector não puxa tela.
    await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ service: 'Troca de tela', unit_price_cents: 20500, device_model: 'G9 Power' }] } }, 201);
    const s5 = await api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ service: 'Troca de conector', unit_price_cents: 7000, device_model: 'Note 8' }] } }, 201);
    assert.equal((await api('/store/products?kind=part&q=note 8'))[0].stock_qty, after.stock_qty);
    let rs = await api('/store/stock/restock/services');
    assert.deepEqual(rs.unidentified.map(x => [x.device_model, x.suggestions.length]), [['G9 Power', 2]], 'conector não entra; G9 Power para escolher');
    assert.match(rs.parts.find(p => p.device_model === 'Redmi Note 8').uses.map(u => u.device_model).join(), /Note 8/);
    // Liga o serviço à peça: reposição +1, estoque igual; não dá para ligar duas vezes; cancelar a venda tira da reposição.
    const g9 = rs.unidentified[0], sem = g9.suggestions.find(p => p.name === 'Tela sem aro');
    await api(`/store/sale-items/${g9.id}/part`, { method: 'POST', body: { part_id: sem.id } });
    let semNow = (await api('/store/products?kind=part&q=g9 power')).find(p => p.id === sem.id);
    assert.deepEqual([semNow.stock_qty, semNow.restock_pending], [sem.stock_qty, sem.restock_pending + 1]);
    assert.equal((await request(`/store/sale-items/${g9.id}/part`, { method: 'POST', body: { none: true } })).status, 409);
    assert.equal((await api('/store/stock/restock/services')).unidentified.length, 0);
    const saleG9 = (await f.db.query('SELECT sale_id FROM sale_items WHERE id=$1', [g9.id])).rows[0].sale_id;
    await api(`/store/sales/${saleG9}/cancel`, { method: 'POST', body: { reason: 'teste' } });
    semNow = (await api('/store/products?kind=part&q=g9 power')).find(p => p.id === sem.id);
    assert.deepEqual([semNow.stock_qty, semNow.restock_pending], [sem.stock_qty, sem.restock_pending]);
    assert.ok(s5.sale.id);

    // A receber (OS / pagar depois): já conta para repor; a peça baixa do estoque só ao receber.
    const cli = await api('/customers', { method: 'POST', body: { name: 'Eliseu', phone: '85977770000' } }, 201);
    const a12now = (await api('/store/products?kind=part&q=a12'))[0];
    const pa = await api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, items: [{ service: 'OS 7 · Troca de tela', unit_price_cents: 19500, device_model: 'Samsung A12' }] } }, 201);
    const pb = await api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, description: 'cliente pediu urgência', items: [{ service: 'OS 8 · Troca de tela', unit_price_cents: 20500, device_model: 'Motorola G9 Power' }] } }, 201);
    rs = await api('/store/stock/restock/services');
    let rowA12 = rs.parts.find(p => p.id === a12.id);
    assert.equal(rowA12.due_count, 1); assert.equal(rowA12.uses[0].pending_number, pa.number); assert.equal(rowA12.uses[0].customer_name, 'Eliseu');
    const dueG9 = rs.unidentified.find(x => x.pending_id === pb.id);
    assert.equal(dueG9.suggestions.length, 2); assert.equal(dueG9.description, 'cliente pediu urgência'); assert.equal(dueG9.total_cents, 20500);
    assert.equal((await api('/store/products?kind=part&q=a12'))[0].stock_qty, a12now.stock_qty, 'a receber não baixa o estoque');
    await api(`/store/sales/pending/${pb.id}/items/0/part`, { method: 'POST', body: { part_id: sem.id } });
    rs = await api('/store/stock/restock/services');
    assert.equal(rs.parts.find(p => p.id === sem.id).due_count, 1); assert.ok(!rs.unidentified.some(x => x.pending_id === pb.id));
    assert.equal((await request(`/store/sales/pending/${pb.id}/items/3/part`, { method: 'POST', body: { none: true } })).status, 409);
    // Recebeu: baixa 1 da peça e passa de "a receber" para reposição normal (sem contar duas vezes).
    await api(`/store/sales/pending/${pa.id}/pay`, { method: 'POST', body: { payment_method: 'pix' } }, 201);
    await api(`/store/sales/pending/${pb.id}/pay`, { method: 'POST', body: { payment_method: 'pix' } }, 201);
    rs = await api('/store/stock/restock/services');
    rowA12 = rs.parts.find(p => p.id === a12.id);
    assert.equal(rowA12.due_count, 0); assert.equal(rowA12.stock_qty, a12now.stock_qty - 1); assert.equal(rowA12.restock_pending, a12now.restock_pending + 1);
    const semRow = rs.parts.find(p => p.id === sem.id);
    assert.deepEqual([semRow.due_count, semRow.stock_qty, semRow.restock_pending], [0, sem.stock_qty - 1, sem.restock_pending + 1]);
    // "Não usou peça" num a receber: ao receber, não puxa a tela sozinho.
    const pc = await api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, items: [{ service: 'Troca de tela', unit_price_cents: 100, device_model: 'Note 8' }] } }, 201);
    const n8 = (await api('/store/products?kind=part&q=note 8'))[0];
    assert.equal((await api('/store/stock/restock/services')).parts.find(p => p.id === n8.id).due_count, 1, 'Note 8: única tela, conta sozinho');
    await api(`/store/sales/pending/${pc.id}/items/0/part`, { method: 'POST', body: { none: true } });
    assert.equal((await api('/store/stock/restock/services')).parts.find(p => p.id === n8.id)?.due_count || 0, 0);
    await api(`/store/sales/pending/${pc.id}/pay`, { method: 'POST', body: { payment_method: 'pix' } }, 201);
    assert.equal((await api('/store/products?kind=part&q=note 8'))[0].stock_qty, n8.stock_qty);
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
    // Imprimir relação: todas as peças por caixa, com a quantidade, inclusive as zeradas (ignora busca e filtro).
    await mk('Tela', 'LG K41S', 'Caixa 03', 6000, 15000, 0);
    await page.locator('#fsPartSearch').fill('a14'); await page.waitForTimeout(400);
    await page.locator('#fsPartPrint').click();
    await page.waitForFunction(() => !!window.FPSales.lastPartsListHtml);
    const listHtml = await page.evaluate(() => window.FPSales.lastPartsListHtml);
    if (process.env.SHOT_DIR) { const lp = await browser.newPage(); await lp.setContent(listHtml); await lp.screenshot({ path: process.env.SHOT_DIR + '/relacao-pecas.png', fullPage: true }); await lp.close(); }
    const all = await f.api('/store/products?kind=part');
    for (const p of all) assert.ok(listHtml.includes(p.device_model), 'relação tem ' + p.device_model);
    assert.match(listHtml, /Caixa 01[\s\S]*Caixa 05/);
    assert.match(listHtml, /<tr class="zero"><td>Tela · LG K41S<\/td><td class="n"><b>0<\/b>/, 'zerada entra na relação');
    assert.match(listHtml, /5 peça\(s\) · 7 unidade\(s\) · 1 zerada\(s\)/);
    await page.locator('#fsPartSearch').fill('');
    // Reposição: botões Produtos e Serviços; serviço antigo sem peça aparece com a tela sugerida.
    await f.api('/store/sales', { method: 'POST', body: { anonymous: true, payment_method: 'pix', items: [{ service: 'Troca de tela', unit_price_cents: 18000, device_model: 'Galaxy A14 5G' }] } }, 201);
    await f.api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Carla Lima', phone: '85988887777' }, payment_method: 'pix', description: 'tela do iPhone da filha', items: [{ service: 'Troca de tela', unit_price_cents: 18000 }] } }, 201);
    await f.api('/store/sales/pending', { method: 'POST', body: { new_customer: { name: 'Eliseu', phone: '85977770000' }, items: [{ service: 'OS 7 · Troca de tela', unit_price_cents: 19000, device_model: 'XIAOMI Note 8' }] } }, 201);
    await page.locator('[data-ptab=restock]').click(); await page.waitForSelector('[data-rv]');
    assert.deepEqual(await page.locator('[data-rv]').allInnerTexts(), ['Produtos', 'Serviços', 'Cotação']);
    await page.locator('[data-rv=part]').click();
    await page.waitForSelector('.fs-sale:has-text("a receber nº 1")');
    assert.match(await page.locator('.fs-sale', { hasText: 'Tela · Redmi Note 8' }).first().innerText(), /a receber nº 1 · Eliseu · XIAOMI Note 8[\s\S]*saiu 1 · repor[\s\S]*1 a receber/);
    await page.locator('.fs-sale', { hasText: 'Tela · Redmi Note 8' }).first().locator('[data-peek-btn]').click();
    assert.match(await page.locator('.fs-sale-peek:not([hidden])').innerText(), /A receber nº 1[\s\S]*ainda não pago[\s\S]*Eliseu[\s\S]*Total a receber\s*R\$\s?190,00/);
    await page.waitForSelector('.fs-sale:has-text("Tela · Samsung A14 5G")');
    assert.match(await page.locator('#fsRsSvc').innerText(), /Tela · Samsung A14 5G[\s\S]*Saiu em: .*Galaxy A14 5G[\s\S]*saiu 1 · repor/, 'serviço com aparelho já baixou a tela sozinho');
    assert.match(await page.locator('#fsRsSvc').innerText(), /Serviços sem peça identificada \(1\)[\s\S]*não informado/);
    // Ver a venda sem sair da reposição: cliente, o que foi escrito, itens, total e pagamento.
    assert.match(await page.locator('.fs-rs-open').innerText(), /Cliente: Carla Lima[\s\S]*Escrito na venda: Troca de tela · tela do iPhone da filha/);
    await page.locator('.fs-rs-open [data-peek-btn]').click();
    await page.waitForSelector('.fs-rs-open .fs-sale-peek:not([hidden])');
    assert.match(await page.locator('.fs-rs-open .fs-sale-peek').innerText(), /Venda nº 2[\s\S]*Carla Lima · 85988887777[\s\S]*Troca de tela[\s\S]*Total pago\s*R\$\s?180,00[\s\S]*Pagamento: Pix/);
    await page.screenshot(shot('reposicao-ver-venda'));
    await page.locator('.fs-rs-open [data-peek-btn]').click();
    assert.equal(await page.locator('.fs-rs-open .fs-sale-peek').isHidden(), true);
    await page.locator('[data-pick]').click(); await page.locator('[data-pickbox] input').fill('note 8');
    await page.locator('[data-pickbox] button', { hasText: 'Redmi Note 8' }).click();
    await page.waitForFunction(() => !document.querySelector('.fs-rs-open') && /saiu 2 · repor/.test(document.getElementById('fsRsSvc')?.innerText || ''));
    await page.screenshot(shot('reposicao-servicos'));
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
