import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('OS: orçamento → fila → concluído → entregue, com "A receber" no caixa e garantia', { skip }, async () => {
  const f = await createStoreFixture(process.env.FP_DEBUG ? { env: { FP_DEBUG: '1' } } : {});
  try {
    const { api, request, tenant, masterToken } = f;
    // Pet shop não usa OS.
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true, niche: 'pet' } });
    assert.equal((await request('/store/service-orders?status=queue')).status, 403);
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { niche: 'electronics' } });
    assert.equal((await api('/store/sales/config')).niche, 'electronics');

    // Aparelho que chegou para orçar: sem valor, nada no caixa.
    const quote = await api('/store/service-orders', { method: 'POST', body: { new_customer: { name: 'João Lima', phone: '(85) 98888-1111' }, quote: true,
      device_type: 'Celular', brand: 'Samsung', model: 'A32', serial: '3567', problem: 'Não liga', accessories: 'Capinha' } }, 201);
    assert.equal(quote.number, 1); assert.equal(quote.status, 'quote'); assert.equal(quote.pay_state, 'none'); assert.equal(quote.warranty_days, 90);
    let list = await api('/store/service-orders?status=quote');
    assert.deepEqual(list.counts, { quote: 1, queue: 0, done: 0 }); assert.equal(list.rows[0].customer_name, 'João Lima');

    // Orçamento: custo e peça do estoque.
    const tela = await api('/store/products', { method: 'POST', body: { kind: 'part', name: 'Conector', device_model: 'A32', cost_cents: 4000, stock_qty: 3 } }, 201);
    const prod = await api('/store/products', { method: 'POST', body: { name: 'Capinha', price_cents: 2000 } }, 201);
    assert.equal((await request('/store/service-orders/' + quote.id, { method: 'PATCH', body: { part_id: prod.id } })).status, 400, 'produto comum não é peça');
    let os = await api('/store/service-orders/' + quote.id, { method: 'PATCH', body: { part_id: tela.id, cost_cents: 4500 } });
    assert.equal(os.part_name, 'Conector'); assert.equal(os.cost_cents, 4500); assert.equal(os.pay_state, 'none', 'orçamento não vai ao caixa');
    // Cliente aprovou R$ 250: vai para a fila e vira "A receber".
    os = await api(`/store/service-orders/${quote.id}/status`, { method: 'POST', body: { status: 'queue', price_cents: 25000, cost_cents: 5000 } });
    assert.equal(os.status, 'queue'); assert.equal(os.pay_state, 'open'); assert.equal(os.pending_total_cents, 25000);
    const pend = await api('/store/sales/pending'); assert.equal(pend.length, 1);
    assert.deepEqual(pend[0].payload.items, [{ service: 'OS 1 · Não liga', unit_price_cents: 25000, device_model: 'Samsung A32', warranty_days: 90, cost_cents: 5000, part_id: tela.id }]);

    // Empacado: aguardando peça. Muda o valor: a venda a receber acompanha.
    os = await api('/store/service-orders/' + os.id, { method: 'PATCH', body: { stage: 'Aguardando peça', stage_note: 'Tela chega sexta', service: 'Troca do conector', price_cents: 28000, due_on: '2030-01-10' } });
    assert.equal(os.stage, 'Aguardando peça'); assert.equal(os.due_on, '2030-01-10'); assert.equal(os.pending_total_cents, 28000);
    assert.equal((await api('/store/sales/pending'))[0].payload.items[0].service, 'OS 1 · Troca do conector');

    // OS que entra direto na fila, com valor zero: não vai para o caixa.
    const free = await api('/store/service-orders', { method: 'POST', body: { customer_id: os.customer_id, brand: 'Apple', model: 'iPhone 11', service: 'Limpeza', price_cents: 0, warranty_days: 30 } }, 201);
    assert.equal(free.status, 'queue'); assert.equal(free.pay_state, 'none'); assert.equal(free.warranty_days, 30);
    assert.equal((await request('/store/service-orders', { method: 'POST', body: { customer_id: os.customer_id } })).status, 400, 'fila sem serviço nem defeito');

    // Concluída: aparece em Concluídos; avisado pelo WhatsApp.
    os = await api(`/store/service-orders/${os.id}/status`, { method: 'POST', body: { status: 'done' } });
    assert.equal(os.status, 'done'); assert.ok(os.warranty_until);
    os = await api(`/store/service-orders/${os.id}/notified`, { method: 'POST' }); assert.ok(os.notified_at);
    list = await api('/store/service-orders?status=done&q=a32'); assert.deepEqual(list.rows.map(x => x.id), [os.id]);
    assert.equal((await request(`/store/service-orders/${os.id}/status`, { method: 'POST', body: { status: 'quote' } })).status, 409);

    // Caixa recebe a OS: fica paga e o valor não muda mais.
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const paid = await api(`/store/sales/pending/${os.pending_sale_id}/pay`, { method: 'POST', body: { payment_method: 'pix' } }, 201);
    os = await api('/store/service-orders/' + os.id); assert.equal(os.pay_state, 'paid'); assert.equal(os.sale_number, paid.sale.sale_number);
    assert.equal(os.part_stock, 2, 'a peça baixou 1 do estoque ao receber');
    assert.equal(paid.sale.items[0].unit_cost_cents, 5000); assert.equal(paid.sale.items[0].warranty_days, 90);
    assert.equal((await request('/store/service-orders/' + os.id, { method: 'PATCH', body: { price_cents: 1000 } })).status, 409);
    assert.equal((await request(`/store/service-orders/${os.id}/cancel`, { method: 'POST', body: { reason: 'teste' } })).status, 409);

    // Serviços do dia mostra a venda ligada à OS, com garantia e telefone.
    const day = await api('/store/sales/day-services');
    assert.deepEqual(day.paid.map(x => [x.os_number, x.warranty_days, x.pet, x.customer_phone]), [[1, 90, 'Samsung A32', '85988881111']]);

    // Atalhos do formulário: o que esta loja mais usa vem primeiro.
    const sg = await api('/store/service-orders/suggestions');
    assert.equal(sg.problems[0], 'Não liga'); assert.ok(sg.problems.includes('Tela quebrada'));
    assert.ok(sg.services.some(x => x.name === 'Troca do conector'));
    // Link da garantia: página pública com os dados do banco, telefone mascarado.
    const link = await api('/store/service-orders/warranty-link', { method: 'POST', body: { source: 'os', id: os.id, days: 180 } });
    assert.match(link.url, /\/g\/[A-Za-z0-9_-]{16,40}$/); assert.equal(link.data.days, 180); assert.equal(link.data.customer_phone, '••••-1111');
    const again = await api('/store/service-orders/warranty-link', { method: 'POST', body: { source: 'os', id: os.id } });
    assert.equal(again.url, link.url, 'mesmo link para a mesma OS');
    const page = await fetch(f.base + '/g/' + link.url.split('/g/')[1]); const pageHtml = await page.text();
    assert.equal(page.status, 200); assert.match(pageHtml, /TERMO DE GARANTIA[\s\S]*João Lima[\s\S]*Samsung A32[\s\S]*Troca do conector[\s\S]*Garantia de 3 meses \(90 dias\)/);
    assert.doesNotMatch(pageHtml, /98888/);
    assert.equal((await fetch(f.base + '/g/naoexiste1234567890')).status, 404);
    const itemLink = await api('/store/service-orders/warranty-link', { method: 'POST', body: { source: 'sale_item', id: day.paid[0].item_id } });
    assert.equal(itemLink.data.days, 90);
    assert.equal((await request('/store/service-orders/warranty-link', { method: 'POST', body: { source: 'os', id: os.id }, token: f.foreignToken })).status, 403);

    // Entregue: a garantia conta da entrega.
    os = await api(`/store/service-orders/${os.id}/status`, { method: 'POST', body: { status: 'delivered' } });
    assert.equal(os.status, 'delivered'); assert.ok(os.delivered_at);
    assert.equal((await api('/store/service-orders?status=delivered')).rows.length, 1);

    // Orçamento recusado: vai para Concluídos para devolver, sem caixa. Cancelar outra OS cancela o "A receber".
    const refused = await api('/store/service-orders', { method: 'POST', body: { customer_id: os.customer_id, quote: true, model: 'Moto G', problem: 'Tela' } }, 201);
    const r2 = await api(`/store/service-orders/${refused.id}/status`, { method: 'POST', body: { status: 'done', repaired: false } });
    assert.equal(r2.repaired, false); assert.equal(r2.pay_state, 'none');
    const wrong = await api('/store/service-orders', { method: 'POST', body: { customer_id: os.customer_id, model: 'X', service: 'Bateria', price_cents: 9000 } }, 201);
    assert.equal(wrong.pay_state, 'open');
    await api(`/store/service-orders/${wrong.id}/cancel`, { method: 'POST', body: { reason: 'Lançada errado' } });
    assert.equal((await api('/store/sales/pending')).length, 0);

    // Padrões da loja (só o dono muda).
    await api('/store/service-orders/settings', { method: 'PATCH', body: { os_warranty_days: 180, os_ready_message: 'Oi {cliente}, pronto!' } });
    const st = await api('/store/service-orders/settings'); assert.equal(st.os_warranty_days, 180); assert.equal(st.name, 'Loja de teste');
    assert.equal((await api('/store/service-orders', { method: 'POST', body: { customer_id: os.customer_id, quote: true } }, 201)).warranty_days, 180);
    // Outra loja não enxerga.
    assert.equal((await request('/store/service-orders/' + os.id, { token: f.foreignToken })).status, 403);
  } finally { await f.cleanup(); }
});

test('painel: nova OS, orçamento aprovado, concluir, avisar, entregar e garantia (impressa e WhatsApp)', {
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
    await context.addInitScript(value => { sessionStorage.setItem('nv_token', value); window.__opened = []; window.open = u => { window.__opened.push(u); return null; }; window.confirm = () => true; }, f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'electronics' } });
    await f.api('/customers', { method: 'POST', body: { name: 'Maria Souza', phone: '85977776666' } }, 201);
    // Serviço feito na hora, direto no caixa, com garantia de 30 dias.
    await f.api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    await f.api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Pedro Alves', phone: '85911112222' }, payment_method: 'cash', items: [{ service: 'Película 3D', unit_price_cents: 3000, device_model: 'Redmi 12', warranty_days: 30 }] } }, 201);

    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="dayservices"]').click();
    await page.waitForSelector('.so-tabs');
    assert.deepEqual(await page.locator('.so-tabs [role=tab]').allInnerTexts(), ['Do dia', 'Orçamentos pendentes', 'Fila de serviços', 'Concluídos', 'Entregues']);
    await page.waitForSelector('.fs-day-table');
    assert.match(await page.locator('.fs-day-h').innerText(), /Aparelho/);
    // Garantia do serviço feito na hora: volta ao dia e imprime / manda.
    await page.locator('[data-ds-warranty]').click();
    await page.waitForSelector('#soWPrint');
    assert.match(await page.frameLocator('#soWPrev').locator('body').innerText(), /TERMO DE GARANTIA[\s\S]*Pedro Alves[\s\S]*Garantia: 30 dias/);
    await page.locator('#soWPrint').click();
    await page.waitForFunction(() => window.FPServiceOrders.lastPrintHtml);
    let html = await page.evaluate(() => window.FPServiceOrders.lastPrintHtml);
    assert.match(html, /TERMO DE GARANTIA[\s\S]*Pedro Alves[\s\S]*Redmi 12[\s\S]*Película 3D[\s\S]*Garantia: 30 dias/);
    await page.waitForFunction(() => /\/g\//.test(document.getElementById('soWMsg')?.value || ''));
    await page.locator('#soWWa').click();
    let wa = decodeURIComponent((await page.evaluate(() => window.__opened.at(-1))).split('text=')[1]);
    assert.match((await page.evaluate(() => window.__opened.at(-1))), /^https:\/\/wa\.me\/5585911112222\?/);
    assert.match(wa, /Olá, Pedro! Segue a garantia[\s\S]*Película 3D[\s\S]*Garantia de 30 dias/);
    await page.keyboard.press('Escape');

    // Nova OS para orçar, com cliente já cadastrado.
    await page.locator('#soNew').click();
    await page.locator('#soCustQ').fill('mari');
    await page.locator('#soCustDrop button', { hasText: 'Maria Souza' }).click();
    await page.locator('#soForm [name=brand]').fill('Samsung');
    await page.locator('#soForm [name=model]').fill('A32');
    await page.locator('#soForm [name=serial]').fill('356789');
    await page.locator('#soForm [name=acc][value="Gaveta de chip"]').check();
    await page.locator('#soForm [name=acc][value="Capa"]').check();
    await page.locator('#soForm [name=accOtherText]').fill('fone');
    await page.locator('#soProbChips button', { hasText: 'Não carrega' }).click();
    assert.equal(await page.locator('#soForm [name=problem]').inputValue(), 'Não carrega');
    await page.locator('#soForm [name=quote]').check();
    await page.screenshot(shot('os-nova'));
    await page.getByRole('button', { name: 'Abrir OS' }).click();
    await page.waitForSelector('#soEPrint');
    await page.locator('#soEPrint').click();
    await page.waitForFunction(() => /ORDEM DE SERVIÇO Nº 1/.test(window.FPServiceOrders.lastPrintHtml));
    html = await page.evaluate(() => window.FPServiceOrders.lastPrintHtml);
    assert.match(html, /Maria Souza[\s\S]*Samsung A32[\s\S]*356789[\s\S]*Gaveta de chip, Capa, Outro: fone[\s\S]*Não carrega[\s\S]*a orçar/);
    // WhatsApp do comprovante: prévia com uma linha por dado.
    await page.locator('#soEWa').click();
    const entryMsg = await page.locator('#soMsg').inputValue();
    assert.equal(entryMsg.split('\n').slice(0, 5).join('|'), 'Olá, Maria! Recebemos seu aparelho na Loja de teste.||OS nº 1|Aparelho: Samsung A32|Defeito: Não carrega');
    await page.locator('#soMsgGo').click();
    assert.ok(decodeURIComponent(await page.evaluate(() => window.__opened.at(-1))).includes('Loja de teste.\n\nOS nº 1\nAparelho: Samsung A32'));
    await page.waitForSelector('[role=tab][aria-selected=true]:has-text("Orçamentos pendentes")');
    await page.waitForSelector('.so-card:has-text("OS 1")');
    await page.locator('[data-so=sendquote]').click();
    await page.locator('#soMsgGo').click();
    wa = decodeURIComponent((await page.evaluate(() => window.__opened.at(-1))).split('text=')[1]);
    assert.match(wa, /Olá, Maria! O orçamento do seu Samsung A32 \(OS 1\)/);

    // Aprovado R$ 180 → fila e A receber.
    await page.locator('[data-so=approve]').click();
    await page.locator('#soAp [name=price]').fill('180,00');
    await page.locator('#soAp [name=cost]').fill('60,00');
    await page.getByRole('button', { name: 'Mandar para a fila' }).click();
    await page.locator('[data-so-tab=queue]').click();
    await page.waitForSelector('.so-card:has-text("A receber R$")');
    await page.locator('[data-so=stage]').click();
    await page.locator('#soForm [name=stage]').selectOption('Aguardando peça');
    await page.locator('#soForm [name=stage_note]').fill('Conector chega sexta');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await page.waitForSelector('.so-card.so-stuck:has-text("Conector chega sexta")');
    await page.screenshot(shot('os-fila'));
    await page.locator('[data-so=done]').click();
    await page.locator('[data-so-tab=done]').click();
    await page.waitForSelector('.so-card [data-so=notify]');
    await page.locator('[data-so=notify]').click();
    await page.locator('#soMsgGo').click();
    wa = decodeURIComponent((await page.evaluate(() => window.__opened.at(-1))).split('text=')[1]);
    assert.match(wa, /Olá, Maria! Seu Samsung A32 \(OS 1\) está pronto[\s\S]*Valor: R\$\s180,00/);
    await page.waitForSelector('.so-card:has-text("avisado")');
    await page.screenshot(shot('os-concluidos'));

    // No caixa, o "A receber" da OS mostra o aparelho.
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.waitForSelector('#fsPending [data-pend-pay]');
    assert.match(await page.locator('#fsPending').innerText(), /OS 1 · Não carrega · Samsung A32/);
    await page.locator('.nv-sidebar [data-view="dayservices"]').click();
    await page.waitForSelector('.so-tabs');
    // Recebe no caixa pela venda a receber; a OS fica paga. Entregue → garantia.
    const os = (await f.api('/store/service-orders?status=done')).rows[0];
    await f.api(`/store/sales/pending/${os.pending_sale_id}/pay`, { method: 'POST', body: { payment_method: 'pix' } }, 201);
    await page.locator('[data-so-tab=done]').click();
    await page.waitForSelector('.so-card:has-text("Pago · venda")');
    await page.locator('[data-so=deliver]').click();
    await page.locator('[data-so-tab=delivered]').click();
    await page.waitForSelector('.so-card:has-text("garantia até")');
    await page.locator('.so-card [data-so=warranty]').click();
    await page.waitForFunction(() => /\/g\//.test(document.getElementById('soWMsg')?.value || ''));
    assert.match(await page.frameLocator('#soWPrev').locator('body').innerText(), /TERMO DE GARANTIA[\s\S]*Maria Souza/);
    await page.screenshot(shot('os-garantia-previa'));
    await page.locator('#soWWa').click();
    wa = decodeURIComponent((await page.evaluate(() => window.__opened.at(-1))).split('text=')[1]);
    assert.match(wa, /Termo da garantia \(abrir, imprimir ou salvar em PDF\):\n.*\/g\//);
    const gUrl = wa.match(/\S*\/g\/[A-Za-z0-9_-]+/)[0];
    const gp = await context.newPage(); await gp.setViewportSize({ width: 390, height: 844 }); await gp.goto(f.base + '/g/' + gUrl.split('/g/')[1]);
    assert.match(await gp.locator('body').innerText(), /TERMO DE GARANTIA[\s\S]*Maria Souza[\s\S]*Samsung A32/);
    await gp.screenshot(shot('garantia-link-celular')); await gp.close();
    await page.locator('#soWPrint').click();
    await page.waitForFunction(() => /OS nº <b>1/.test(window.FPServiceOrders.lastPrintHtml));
    html = await page.evaluate(() => window.FPServiceOrders.lastPrintHtml);
    assert.match(html, /Maria Souza[\s\S]*Samsung A32[\s\S]*356789[\s\S]*R\$\s180,00[\s\S]*90 dias/);
    await page.keyboard.press('Escape');
    // Celular: sem rolagem lateral.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-so-tab=queue]').click();
    await page.waitForSelector('.so-tabs');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'sem rolagem lateral no celular');
    await page.screenshot(shot('os-celular'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
