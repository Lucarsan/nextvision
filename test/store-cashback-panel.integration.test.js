import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Painel: configurar cashback, usar o saldo na venda (com limite e troco), mensagem do dia e aba de vencimentos.
test('painel do caixa usa cashback e avisa vencimento', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async () => {
  const f = await createStoreFixture(); let browser;
  const shot = name => process.env.SHOT_DIR ? { path: process.env.SHOT_DIR + '/' + name + '.png', fullPage: true } : {};
  try {
    const require = createRequire(import.meta.url);
    let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
    browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { window.open = (url) => { window.__opened = (window.__opened || []).concat(url); return null; }; });
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });

    // Configurar: liga o cashback pelo painel (5%, até 30% da compra, 90 dias).
    await page.goto(f.base + '/loja.html');
    await page.locator('.nv-sidebar [data-view="messages"]').click();
    await page.getByRole('tab', { name: 'Cashback' }).click();
    await page.waitForSelector('text=O cashback está desligado');
    await page.getByRole('tab', { name: 'Configurar' }).click();
    await page.waitForSelector('#fsCfg [name="cashback_enabled"]');
    await page.locator('#fsCfg [name="cashback_enabled"]').check();
    assert.match(await page.locator('#fsCbPreview').innerText(), /R\$\s4,50 de cashback na Loja de teste que vence em 5 dias/);
    assert.match(await page.locator('#fsPreview').innerText(), /Você ganhou R\$\s5,00 de cashback nesta compra\. Seu saldo de cashback é R\$\s12,50[\s\S]*5% do valor de cada compra volta[\s\S]*3 meses[\s\S]*até 30%/);
    await page.screenshot(shot('cashback-configurar'));
    await page.getByRole('button', { name: 'Salvar' }).click();
    await page.waitForSelector('#fsCfgStatus:text("Salvo.")');
    assert.equal((await f.api('/store/sales/config')).cashback_enabled, true);

    // Cliente com saldo: primeira compra de R$ 100 gera R$ 5.
    await f.api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const first = await f.api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Maria Souza', phone: '85 98888-1234' }, total_cents: 10000, payment_method: 'pix' } }, 201);
    assert.equal(first.cashback.balance_cents, 500);

    await page.reload();
    await page.locator('.nv-sidebar [data-view="cash"]').click();
    await page.waitForSelector('#fsSale');
    await page.locator('#fsSearch').fill('maria');
    await page.locator('[data-fs-pick]').first().click();
    await page.waitForSelector('#fsCbBox .fs-cb');
    assert.match(await page.locator('#fsCustomerBox').innerText(), /R\$\s5,00/);
    assert.equal(await page.locator('#fsCbUse').isDisabled(), true, 'sem valor ainda');
    await page.locator('#fsSale [name="total"]').fill('10,00');
    await page.waitForSelector('#fsCbUse:not([disabled])');
    assert.match(await page.locator('#fsCbBox').innerText(), /− R\$\s3,00/, 'limite de 30% de R$ 10');
    await page.locator('#fsCbUse').check();
    await page.waitForSelector('.fs-cb-pay');
    assert.match(await page.locator('.fs-cb-pay').innerText(), /A pagar: R\$\s7,00[\s\S]*fica R\$\s2,00 de saldo/);
    await page.locator('#fsSale label:has-text("Dinheiro")').click();
    await page.locator('#fsSale [name="received"]').fill('10,00');
    assert.match(await page.locator('#fsChangeOut').innerText(), /Troco: R\$\s3,00/, 'troco sobre o valor a pagar');
    await page.screenshot(shot('cashback-venda'));
    await page.getByRole('button', { name: 'Registrar venda' }).click();
    await page.waitForSelector('.fs-last .fs-cb-note');
    assert.match(await page.locator('.fs-last').innerText(), /Usou R\$\s3,00 de cashback\. Ganhou R\$\s0,35 de cashback\. Saldo: R\$\s2,35/);
    assert.match(await page.locator('.fs-col-report').innerText(), /cashback −R\$\s3,00/);
    await page.screenshot(shot('cashback-depois'));

    // Enviar status: a mensagem leva o cashback em reais.
    await page.locator('#fsSendNow').click();
    const sentUrl = (await page.evaluate(() => window.__opened || []))[0];
    const text = new URL(sentUrl).searchParams.get("text");
    assert.match(text, /Você ganhou R\$\s0,35 de cashback nesta compra\. Seu saldo de cashback é R\$\s2,35 para usar em compras aqui na loja/);

    // Aba Cashback: saldo vencendo em 5 dias aparece com aviso pronto.
    await f.db.query(`UPDATE cashback_lots SET expires_on=(now() AT TIME ZONE 'America/Fortaleza')::date+5 WHERE customer_id=$1`, [first.customer.id]);
    await page.locator('.nv-sidebar [data-view="messages"]').click();
    await page.getByRole('tab', { name: 'Cashback' }).click();
    await page.waitForSelector('[data-fs-cb]');
    assert.match(await page.locator('#fsTab').innerText(), /Maria Souza[\s\S]*R\$\s2,35 vence em 5 dias[\s\S]*aviso de 5 dias/);
    await page.screenshot(shot('cashback-avisos'));
    await page.locator('[data-fs-cb]').click();
    await page.waitForSelector('.fs-ok:has-text("Avisado")');
    const reminder = new URL((await page.evaluate(() => window.__opened))[1]).searchParams.get("text");
    assert.match(reminder, /^Olá, Maria! Você tem R\$\s2,35 de cashback na Loja de teste que vence em 5 dias/);
    await page.locator('#fsCbAll summary').click();
    await page.waitForSelector('#fsCbAllList table');
    assert.match(await page.locator('#fsCbAllList').innerText(), /Maria Souza[\s\S]*R\$\s2,35/);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
