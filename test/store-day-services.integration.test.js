import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());

test('busca pelo nome do pet mostra o tutor; serviços do dia lista pagos, a receber e pedidos sem venda', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { api, request, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Recebido', 'Pronto'] } }, 201);
    const afonso = await api('/customers', { method: 'POST', body: { name: 'Afonso Filho', phone: '85997106788' } }, 201);
    const dom = await api('/customers/' + afonso.id + '/pets', { method: 'POST', body: { name: 'Dom', breed: 'Yorkshire Terrier', size: 'Médio' } }, 201);
    const maria = await api('/customers', { method: 'POST', body: { name: 'Maria Dominga', phone: '85988881234' } }, 201);

    // "dom" acha a cliente pelo nome e o pet Dom com o tutor.
    const found = await api('/store/sales/customers?q=dom');
    assert.deepEqual(found.map(x => [x.name, x.pet?.name || null]), [['Maria Dominga', null], ['Afonso Filho', 'Dom']]);
    assert.equal(found[1].pet.id, dom.id); assert.equal(found[1].pet.breed, 'Yorkshire Terrier');

    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    await api('/store/sales', { method: 'POST', body: { customer_id: afonso.id, payment_method: 'pix', items: [{ service: 'Banho de cheiro', unit_price_cents: 5000, device_model: 'Dom' }, { name: 'Shampoo', quantity: 1, unit_price_cents: 3000 }] } }, 201);
    const canceled = await api('/store/sales', { method: 'POST', body: { customer_id: afonso.id, payment_method: 'cash', items: [{ service: 'Tosa', unit_price_cents: 4000 }] } }, 201);
    await api(`/store/sales/${canceled.sale.id}/cancel`, { method: 'POST', body: { reason: 'Lançado errado' } });
    await api('/store/sales/pending', { method: 'POST', body: { customer_id: maria.id, items: [{ service: 'Hidratação', unit_price_cents: 2000, device_model: 'Mel' }] } }, 201);
    await api('/store/sales/pending', { method: 'POST', body: { customer_id: maria.id, total_cents: 1500, description: 'Corte de unhas' } }, 201);
    const lonely = await api('/orders', { method: 'POST', body: { customer_id: maria.id, process_id: proc.id, details: { item_type: 'pet', pet_name: 'Mel', service: 'Banho' } } }, 201);
    await api('/store/sales', { method: 'POST', body: { customer_id: afonso.id, payment_method: 'pix', total_cents: 1000, live_order: { process_id: proc.id, details: { pet_name: 'Dom' } } } }, 201);

    const d = await api('/store/sales/day-services');
    assert.equal(d.day, today());
    assert.deepEqual(d.paid.map(x => [x.service, x.pet, x.total_cents, x.payment_method]), [['Banho de cheiro', 'Dom', 5000, 'pix']], 'só serviços, sem cancelada');
    assert.deepEqual(d.pending.map(x => [x.service, x.pet, x.total_cents]), [['Hidratação', 'Mel', 2000], ['Corte de unhas', null, 1500]]);
    assert.deepEqual(d.orders_without_sale.map(o => o.id), [lonely.id], 'pedido com venda não aparece');
    const old = await api('/store/sales/day-services?day=2020-01-01');
    assert.deepEqual([old.paid.length, old.pending.length, old.orders_without_sale.length], [0, 0, 0]);
    assert.equal((await request('/store/sales/day-services?day=ontem')).status, 400);

    // Período (de/até): inclui hoje; data final antes da inicial, data impossível ou mais de 1 ano dão 400.
    const monthAgo = new Date(Date.parse(today()) - 30 * 86400000).toISOString().slice(0, 10);
    const range = await api(`/store/sales/day-services?from=${monthAgo}&to=${today()}`);
    assert.equal(range.from, monthAgo); assert.equal(range.to, today());
    assert.equal(range.paid.length + range.pending.length, 3);
    const week = await api(`/store/sales/day-services?from=2020-01-01&to=2020-01-07`);
    assert.equal(week.paid.length + week.pending.length, 0);
    assert.equal((await request('/store/sales/day-services?from=2026-11-10&to=2026-11-01')).status, 400);
    assert.equal((await request('/store/sales/day-services?from=2026-02-30&to=2026-03-01')).status, 400);
    assert.equal((await request('/store/sales/day-services?from=2020-01-01&to=2022-01-01')).status, 400);
    // Comissão cadastrada de cada pessoa vem junto (o dono vê todos).
    assert.ok(Array.isArray(range.commissions) && range.commissions.length >= 1);
    assert.ok(range.commissions.every(c => typeof c.percent === 'number' && ['addons', 'services', 'all'].includes(c.base)));

    // "A receber" com serviço cadastrado como adicional sai marcado como adicional.
    const hig = await api('/store/sales/service-items', { method: 'POST', body: { name: 'Tosa Higiênica', price_cents: 2500, addon: true } }, 201);
    await api('/store/sales/pending', { method: 'POST', body: { customer_id: maria.id, items: [{ service: 'Tosa Higiênica', unit_price_cents: 2500, catalog_id: hig.id, device_model: 'Mel' }] } }, 201);
    const withAddon = await api('/store/sales/day-services');
    assert.deepEqual(withAddon.pending.map(x => [x.service, x.addon]), [['Hidratação', false], ['Corte de unhas', false], ['Tosa Higiênica', true]]);
  } finally { await f.cleanup(); }
});

test('painel: achar pelo pet no caixa e conferir os serviços do dia', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const cli = await f.api('/customers', { method: 'POST', body: { name: 'Afonso Filho', phone: '85997106788' } }, 201);
    await f.api('/customers/' + cli.id + '/pets', { method: 'POST', body: { name: 'Thor', breed: 'Golden Retriever', size: 'Grande' } }, 201);
    await f.api('/customers/' + cli.id + '/pets', { method: 'POST', body: { name: 'Dom', breed: 'Yorkshire Terrier', size: 'Médio' } }, 201);
    await f.api('/store/sales/service-items', { method: 'POST', body: { name: 'Banho de cheiro', price_cents: 4300, price_rules: { size: [{ name: 'Médio', cents: 700 }] } } }, 201);

    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');
    assert.match(await page.locator('#fsSearch').getAttribute('placeholder'), /pet/);
    await page.locator('#fsSearch').fill('dom');
    await page.waitForSelector('[data-fs-pick-pet]');
    assert.match(await page.locator('[data-fs-pick-pet]').innerText(), /Dom\s*Yorkshire Terrier · tutor Afonso Filho/);
    await page.locator('[data-fs-pick-pet]').click();
    // O pet escolhido já vem marcado e os serviços abertos.
    await page.waitForSelector('#fsSvcQuick:has-text("preços para Dom")');
    assert.match(await page.locator('[data-fs-pet][aria-pressed="true"]').innerText(), /Dom/);
    await page.locator('[data-fs-svc]', { hasText: 'Banho de cheiro' }).click();
    await page.getByRole('button', { name: 'Registrar serviço' }).click();
    await page.waitForSelector('.fs-last');

    await page.locator('.nv-sidebar [data-view="dayservices"]').click();
    await page.waitForSelector('.fs-day-table');
    assert.match(await page.locator('.fs-day').innerText(), /1\s*serviços[\s\S]*1\s*banhos[\s\S]*R\$\s*50,00/);
    assert.ok(await page.locator('#fsDayFrom').isVisible() && await page.locator('#fsDayTo').isVisible(), 'período de/até');
    assert.match(await page.locator('.fs-day-table').innerText(), /Afonso Filho\s*Dom\s*Banho de cheiro\s*R\$\s*50,00\s*Pago · Pix/);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#fsDayCsv').click()]);
    const csv = await (await download.createReadStream()).toArray().then(b => Buffer.concat(b).toString('utf8'));
    assert.match(download.suggestedFilename(), /^servicos-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.match(csv, /"Afonso Filho";"Dom";"Banho de cheiro";"50,00";"Pago";"Pix R\$\s50,00"|"Afonso Filho";"Dom";"Banho de cheiro";"50,00";"Pago";"Pix"/);
    assert.match(csv, /"Total";"";"";"";"";"50,00"/);
    await page.screenshot(shot('servicos-do-dia'));

    // Período e filtros para a comissão: adicional lançado como "a receber" e comissão de 10%.
    const hig = await f.api('/store/sales/service-items', { method: 'POST', body: { name: 'Tosa Higiênica', price_cents: 2500, addon: true } }, 201);
    await f.api('/store/sales/pending', { method: 'POST', body: { customer_id: cli.id, items: [{ service: 'Tosa Higiênica', unit_price_cents: 2500, catalog_id: hig.id, device_model: 'Dom' }] } }, 201);
    await page.locator('[data-ds-quick="month"]').click();
    await page.waitForSelector('.fs-day h2:has-text("Serviços do período"), .fs-day h2:has-text("Serviços do dia")');
    await page.waitForSelector('.fs-day-table:has-text("Tosa Higiênica")');
    assert.match(await page.locator('.fs-goal-stats').innerText(), /2\s*serviços[\s\S]*1\s*adicionais[\s\S]*R\$\s*75,00\s*total/);
    // Resumo por serviço (padrão no período): quantidade (pets) e valor (média por pet), totais de banho e tosa.
    if (await page.locator('[data-ds-view="sum"][aria-selected="true"]').count() === 0) await page.locator('[data-ds-view="sum"]').click();
    await page.waitForSelector('.fs-ds-sum');
    const sum = await page.locator('.fs-ds-sum').innerText();
    assert.match(sum, /Banho de cheiro\s*1 \(1\)\s*R\$\s*50,00 \(R\$\s*50,00\)/);
    assert.match(sum, /Tosa Higiênica\s*adicional\s*1 \(1\)\s*R\$\s*25,00/);
    assert.match(sum, /Total\s*2 \(2\)\s*R\$\s*75,00 \(R\$\s*37,50\)/);
    assert.match(await page.locator('.fs-ds-groups').innerText(), /Banhos\s*1 \(1\)[\s\S]*Tosas\s*1 \(1\)/);
    const [dlSum] = await Promise.all([page.waitForEvent('download'), page.locator('#fsDayCsv').click()]);
    const csvSum = await (await dlSum.createReadStream()).toArray().then(b => Buffer.concat(b).toString('utf8'));
    assert.match(dlSum.suggestedFilename(), /^resumo-servicos-/);
    assert.match(csvSum, /"Banho de cheiro";"Não";"1";"1";"50,00";"50,00"/); assert.match(csvSum, /"Total";"";"2";"2";"75,00";"37,50"/);
    await page.screenshot(shot('servicos-resumo'));
    // Clicar no serviço do resumo abre a lista só dele.
    await page.locator('[data-ds-svc]', { hasText: 'Banho de cheiro' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.fs-day-table .fs-day-row:not(.fs-day-h)').length === 1);
    assert.match(await page.locator('.fs-day-table').innerText(), /Banho de cheiro/);
    await page.locator('#fsDsSvc').selectOption('');
    await page.waitForFunction(() => document.querySelectorAll('.fs-day-table .fs-day-row:not(.fs-day-h)').length === 2);
    await page.locator('#fsDsKind').selectOption('addon');
    await page.waitForFunction(() => document.querySelectorAll('.fs-day-table .fs-day-row:not(.fs-day-h)').length === 1);
    assert.match(await page.locator('.fs-day-table').innerText(), /Tosa Higiênica/);
    assert.doesNotMatch(await page.locator('.fs-day-table').innerText(), /Banho de cheiro/);
    await page.locator('#fsDsPct').fill('10');
    assert.match(await page.locator('#fsDsCommVal').innerText(), /R\$\s*2,50/);
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('#fsDayCsv').click()]);
    const csv2 = await (await dl2.createReadStream()).toArray().then(b => Buffer.concat(b).toString('utf8'));
    assert.match(csv2, /"Comissão 10%";"";"";"";"";"2,50"/); assert.match(csv2, /Filtros: Apenas adicionais/);
    await page.screenshot(shot('servicos-periodo-comissao'));
    // Situação "só pagos" com adicionais: nada; limpar filtros volta a mostrar tudo.
    await page.locator('#fsDsStatus').selectOption('paid');
    await page.waitForSelector('.fs-day:has-text("Nenhum serviço com estes filtros")');
    await page.locator('#fsDsClear').click();
    await page.waitForFunction(() => document.querySelectorAll('.fs-day-table .fs-day-row:not(.fs-day-h)').length === 2);
    await page.locator('[data-ds-quick="today"]').click();
    await page.waitForSelector('.fs-day h2:has-text("Serviços do dia")');
    await page.locator('#fsDayPrev').click();
    await page.waitForSelector('.fs-day:has-text("Nenhum serviço lançado")');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#fsDayNext').click();
    await page.waitForSelector('.fs-day-table');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'sem rolagem lateral no celular');
    await page.screenshot(shot('servicos-do-dia-celular'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
