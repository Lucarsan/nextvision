import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Pet shop no caixa: escolhe o cliente, o pet vem da ficha e o preço do serviço sai pelas variáveis
// (raça no lugar do porte, pelagem soma). Cadastro das variáveis, dia sem cashback e tela de metas.
test('caixa do pet shop: preço por pet, variáveis, dia sem cashback e metas', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => ({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/' + name + '.png' : undefined });
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const taina = await f.addOperator(f.tenant, 'full', 'Tainá');
    const cli = await f.api('/customers', { method: 'POST', body: { name: 'Afonso Filho', phone: '85997106788' } }, 201);
    await f.api('/customers/' + cli.id + '/pets', { method: 'POST', body: { name: 'Thor', species: 'Cão', breed: 'Golden Retriever', size: 'Grande' } }, 201);
    await f.api('/customers/' + cli.id + '/pets', { method: 'POST', body: { name: 'Dom', species: 'Cão', breed: 'Yorkshire Terrier', size: 'Médio', coat: 'Longo' } }, 201);
    await f.api('/store/sales/service-items', { method: 'POST', body: { name: 'Banho de cheiro', price_cents: 4300,
      price_rules: { size: [{ name: 'Médio', cents: 700 }, { name: 'Grande', cents: 1500 }], coat: [{ name: 'Longo', cents: 1000 }], breed: [{ name: 'Golden Retriever', cents: 8000 }] } } }, 201);

    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.locator('#fsOpen [name="opening"]').fill('0');
    await page.getByRole('button', { name: 'Abrir caixa' }).click();
    await page.waitForSelector('#fsSale');

    // Cadastro do serviço adicional com variáveis pelo diálogo "Editar".
    await page.getByRole('button', { name: 'Serviço', exact: true }).click();
    assert.match(await page.locator('#fsSvcPetBox').innerText(), /Escolha o cliente/);
    assert.equal(await page.locator('#fsSvcSupplier').isVisible(), false, 'pet shop não vê fornecedor');
    assert.equal(await page.locator('#fsSvcWarranty').isVisible(), false, 'nem garantia');
    assert.equal(await page.locator('#fsSvcName').getAttribute('placeholder'), 'Ex.: Banho de cheiro, tosa higiênica', 'exemplo de pet shop');
    assert.doesNotMatch(await page.locator('#fsSvc').innerText(), /tela/i);
    await page.locator('#fsSvcManage').click();
    const dlg = page.locator('#editorDialog');
    await dlg.locator('[name="name"]').fill('Hidratação simples'); await dlg.locator('[name="price"]').fill('18');
    await dlg.locator('[name="addon"]').check();
    await dlg.locator('.fs-vars summary').click();
    await dlg.locator('[data-size="Médio"]').fill('3'); await dlg.locator('[data-size="Grande"]').fill('5');
    await dlg.locator('[name="breeds"]').fill('Chow Chow = 20,00\nPit Bull 25');
    await page.screenshot(shot('pet-servico-variaveis'));
    await dlg.getByRole('button', { name: 'Cadastrar' }).click();
    await page.waitForSelector('#fsSvcStatus:has-text("cadastrado")');
    const hidra = (await f.api('/store/sales/service-items')).find(i => i.name === 'Hidratação simples');
    assert.equal(hidra.addon, true); assert.equal(hidra.price_cents, 1800);
    assert.deepEqual(hidra.price_rules, { size: [{ name: 'Médio', cents: 300 }, { name: 'Grande', cents: 500 }], breed: [{ name: 'Chow Chow', cents: 2000 }, { name: 'Pit Bull', cents: 2500 }] });
    assert.match(await dlg.locator('#fsSvcList').innerText(), /Hidratação simples\s*adicional[\s\S]*porte Médio \+3,00, Grande \+5,00 · 2 raças/);
    // Raça escrita errado é recusada com a linha.
    await dlg.locator('[data-svc-edit]').first().click();
    await dlg.locator('[name="breeds"]').fill('Golden sem valor');
    await dlg.getByRole('button', { name: 'Salvar' }).click();
    assert.match(await dlg.locator('#fsSvcStatus').innerText(), /linha 1/);
    await dlg.locator('[data-close-dialog]').click();

    // O cliente vem antes de Produto/Serviço.
    const cliBox = await page.locator('#fsCustomerBox').boundingBox(), modeBox = await page.locator('.fs-mode').boundingBox();
    assert.ok(cliBox.y < modeBox.y, 'cliente antes de produto/serviço');
    // Cliente com dois pets: escolhe o Thor (Golden, Grande) → raça vale no lugar do porte.
    await page.locator('#fsSearch').fill('afonso');
    await page.locator('[data-fs-pick]').first().click();
    await page.waitForSelector('[data-fs-pet]');
    await page.locator('[data-fs-pet]', { hasText: 'Thor' }).click();
    await page.waitForSelector('#fsSvcQuick:has-text("preços para Thor")');
    assert.match(await page.locator('[data-fs-svc]', { hasText: 'Banho de cheiro' }).innerText(), /123,00/);
    // Tocar no serviço põe direto na venda, com a conta.
    await page.locator('[data-fs-svc]', { hasText: 'Banho de cheiro' }).click();
    await page.waitForSelector('[data-fs-svc-price="0"]');
    assert.equal(await page.locator('[data-fs-svc-price="0"]').inputValue(), '123,00');
    assert.match(await page.locator('#fsMix').innerText(), /Banho de cheiro · Thor[\s\S]*base R\$\s*43,00 \+ Golden Retriever R\$\s*80,00/);
    // Outro pet do mesmo cliente (Dom: Médio, pelo longo): principal + adicional juntos na mesma venda.
    await page.locator('[data-fs-pet]', { hasText: 'Dom' }).click();
    await page.waitForSelector('#fsSvcQuick:has-text("preços para Dom")');
    assert.match(await page.locator('[data-fs-svc]', { hasText: 'Banho de cheiro' }).innerText(), /60,00/);
    await page.locator('[data-fs-svc]', { hasText: 'Banho de cheiro' }).click();
    assert.match(await page.locator('#fsSvcQuick').innerText(), /ADICIONAIS|Adicionais/);
    await page.locator('[data-fs-svc]', { hasText: 'Hidratação simples' }).click();
    await page.waitForSelector('[data-fs-svc-price="2"]');
    assert.deepEqual(await page.locator('[data-fs-svc-price]').evaluateAll(n => n.map(x => x.value)), ['123,00', '60,00', '21,00']);
    assert.match(await page.locator('#fsMix').innerText(), /porte Médio R\$\s*7,00 \+ pelo Longo R\$\s*10,00/);
    assert.match(await page.locator('#fsMix .fs-pcart-total').innerText(), /204,00/);
    // Tocar de novo tira; tocar outra vez põe de novo.
    await page.locator('[data-fs-svc]', { hasText: 'Hidratação simples' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-fs-svc-price]').length === 2);
    await page.locator('[data-fs-svc]', { hasText: 'Hidratação simples' }).click();
    await page.waitForSelector('[data-fs-svc-price="2"]');
    // Preço mexido à mão vale e a conta some; o total acompanha.
    await page.locator('[data-fs-svc-price="2"]').fill('20,00');
    await page.waitForSelector('#fsMix .fs-pcart-total:has-text("203,00")');
    // Tirar o banho do Thor pelo X.
    await page.locator('[data-fs-svc-del="0"]').click();
    await page.waitForSelector('#fsMix .fs-pcart-total:has-text("80,00")');
    await page.locator('#fsSeller').selectOption({ label: 'Tainá' });
    await page.screenshot(shot('pet-caixa-preco'));
    await page.getByRole('button', { name: 'Registrar serviços' }).click();
    await page.waitForSelector('.fs-last');
    const items = (await f.db.query("SELECT i.name,i.total_cents,i.device_model,i.addon FROM sale_items i JOIN sales x ON x.id=i.sale_id WHERE x.tenant_id=$1 ORDER BY i.position", [f.tenant])).rows;
    assert.deepEqual(items.map(i => [i.name, i.total_cents, i.device_model, i.addon]), [['Banho de cheiro', 6000, 'Dom', false], ['Hidratação simples', 2000, 'Dom', true]]);

    // Configurar → Cashback: marcar a quarta como dia sem cashback.
    await page.locator('.nv-sidebar [data-view="messages"]').click();
    await page.getByRole('tab', { name: 'Configurar' }).click();
    await page.locator('[name="cashback_enabled"]').check();
    await page.locator('[name="cb_off"][value="3"]').check();
    await page.getByRole('button', { name: 'Salvar' }).click();
    await page.waitForSelector('#fsCfgStatus:has-text("Salvo")');
    assert.deepEqual((await f.api('/store/sales/config')).cashback_off_weekdays, [3]);
    assert.match(await page.locator('#fsPreview').innerText(), /Não gera cashback às quartas-feiras/);

    // Metas: meta da loja e comissão de 2% sobre adicionais para a Tainá.
    await page.locator('.nv-sidebar [data-view="goals"]').click();
    await page.waitForSelector('#fsGoalForm');
    assert.match(await page.locator('.fs-goal-store').innerText(), /R\$\s*80,00[\s\S]*1\s*banhos[\s\S]*1\s*adicionais/);
    await page.locator('#fsGoalForm [name="goal"]').fill('30.000');
    await page.getByRole('button', { name: 'Salvar meta' }).click();
    await page.waitForSelector('.fs-goal-store .fs-goal-bar');
    assert.match(await page.locator('.fs-goal-store').innerText(), /de R\$\s*30\.000,00/);
    const row = page.locator(`[data-user="${taina.id}"]`);
    await row.locator('[data-goal-edit]').click();
    await row.locator('[name="pct"]').fill('2'); await row.locator('[name="base"]').selectOption('addons');
    await row.getByRole('button', { name: 'Salvar' }).click();
    await page.waitForSelector(`[data-user="${taina.id}"] .fs-goal-comm:has-text("2% sobre adicionais")`);
    assert.match(await page.locator(`[data-user="${taina.id}"]`).innerText(), /Comissão:\s*R\$\s*0,40/);
    await page.screenshot(shot('pet-metas'));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
