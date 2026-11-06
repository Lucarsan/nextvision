import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';
import { reportData, reportHtml } from '../src/reports.js';

// Pagamento dividido: parte em dinheiro, parte no Pix (ou cartão). Cada parte entra na sua forma no caixa,
// na gaveta só entra o dinheiro, e comprovante, relatórios e histórico mostram as partes.
test('pagamento dividido: dinheiro + Pix na mesma venda', { skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL', timeout: 180000 }, async () => {
  const f = await createStoreFixture(); let browser;
  try {
    const { api, request, tenant, masterToken, db } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 5000 } }, 201);

    // Valor digitado: R$ 100,00 = R$ 60,00 em dinheiro + R$ 40,00 no Pix.
    const s1 = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Dorys Lima', phone: '85996762945' }, total_cents: 10000, payments: [{ method: 'cash', amount_cents: 6000 }, { method: 'pix', amount_cents: 4000 }] } }, 201);
    assert.equal(s1.sale.payment_method, 'mixed');
    assert.deepEqual(s1.sale.payments, [{ method: 'cash', amount_cents: 6000 }, { method: 'pix', amount_cents: 4000 }]);
    const dorys = s1.customer.id;

    // Erros: soma diferente, forma repetida, sem forma, as duas coisas juntas, uma parte só.
    const e1 = await request('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 10000, payments: [{ method: 'cash', amount_cents: 6000 }, { method: 'pix', amount_cents: 3000 }] } });
    assert.equal(e1.status, 400); assert.match(e1.data.error, /somam R\$ 90,00.*R\$ 100,00/);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 1000, payments: [{ method: 'pix', amount_cents: 500 }, { method: 'pix', amount_cents: 500 }] } })).status, 400);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 1000 } })).status, 400);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 1000, payment_method: 'pix', payments: [{ method: 'cash', amount_cents: 500 }, { method: 'pix', amount_cents: 500 }] } })).status, 400);
    assert.equal((await request('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 1000, payments: [{ method: 'cash', amount_cents: 1000 }] } })).status, 400);

    // Com produtos e desconto: as partes somam o total calculado pelo servidor (2 x 30,00 − 5,00 = 55,00).
    const capa = await api('/store/products', { method: 'POST', body: { name: 'Capa A12', barcode: '7890000000011', price_cents: 3000, cost_cents: 800, stock_qty: 10 } }, 201);
    const s2 = await api('/store/sales', { method: 'POST', body: { anonymous: true, items: [{ product_id: capa.id, quantity: 2 }], discount_cents: 500, payments: [{ method: 'debit', amount_cents: 5000 }, { method: 'cash', amount_cents: 500 }] } }, 201);
    assert.equal(s2.sale.total_cents, 5500);
    // Venda comum continua igual.
    await api('/store/sales', { method: 'POST', body: { anonymous: true, total_cents: 2000, payment_method: 'pix' } }, 201);

    // Caixa: cada parte na sua forma; vendas contadas uma vez; gaveta só com o dinheiro.
    let cash = await api('/store/cash');
    assert.equal(cash.summary.sales_count, 3);
    assert.equal(cash.summary.sales_total_cents, 10000 + 5500 + 2000);
    assert.equal(cash.summary.by_method.cash.total_cents, 6000 + 500);
    assert.equal(cash.summary.by_method.pix.total_cents, 4000 + 2000);
    assert.equal(cash.summary.by_method.debit.total_cents, 5000);
    assert.equal(cash.summary.expected_cash_cents, 5000 + 6500);
    assert.deepEqual(cash.sales.find(x => x.id === s1.sale.id).payments, s1.sale.payments);

    // Comprovante, histórico do cliente e relatório do dia.
    const rc = await api(`/store/sales/${s1.sale.id}/receipt`);
    assert.deepEqual(rc.payments, s1.sale.payments);
    const hist = await api(`/store/customers/${dorys}/history`);
    assert.equal(hist.totals.by_method.cash.total_cents, 6000); assert.equal(hist.totals.by_method.pix.total_cents, 4000);
    const day = (await db.query("SELECT to_char(now() AT TIME ZONE 'America/Fortaleza','YYYY-MM-DD') d")).rows[0].d;
    const rep = await reportData((sql, params) => db.query(sql, params), tenant, 'daily', day);
    assert.equal(rep.by_method.cash.total, 6500); assert.equal(rep.by_method.pix.total, 6000); assert.equal(rep.by_method.debit.total, 5000);
    assert.match(reportHtml(rep), /Dinheiro R\$ 60,00 \+ Pix R\$ 40,00/);

    // Cancelar tira as duas partes.
    await api(`/store/sales/${s1.sale.id}/cancel`, { method: 'POST', body: { reason: 'teste de cancelamento' } });
    cash = await api('/store/cash');
    assert.equal(cash.summary.by_method.cash.total_cents, 500); assert.equal(cash.summary.by_method.pix.total_cents, 2000);
    assert.equal(cash.summary.expected_cash_cents, 5000 + 500);

    // Tela: "Dividir", a última forma fica com o que falta, troco sobre a parte em dinheiro.
    if (process.env.BROWSER_EXECUTABLE) {
      const require = createRequire(import.meta.url);
      let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
      browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
      const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } }); await context.addInitScript(v => sessionStorage.setItem('nv_token', v), f.ownerToken);
      const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(f.base + '/loja.html');
      await page.locator('.nv-sidebar [data-view="cash"]').click();
      await page.waitForSelector('#fsSale');
      await page.locator('#fsSale [name=total]').fill('100');
      await page.locator('#fsSale [name=method][value=split]').check({ force: true });
      await page.waitForSelector('#fsSplit:not([hidden]) [data-split-v="0"]');
      assert.equal(await page.locator('[data-split-m="0"]').inputValue(), 'cash'); assert.equal(await page.locator('[data-split-m="1"]').inputValue(), 'pix');
      await page.locator('[data-split-v="0"]').fill('60');
      await page.waitForFunction(() => /R\$\s?40,00/.test(document.getElementById('fsSplitRest').textContent));
      assert.equal(await page.locator('#fsReceivedLabel').textContent(), 'Recebido em dinheiro');
      await page.locator('#fsSale [name=received]').fill('100');
      await page.waitForFunction(() => /Troco:\s*R\$\s?40,00/.test(document.getElementById('fsChangeOut').textContent));
      // Três formas: + outra forma (débito) 10,00 → Pix fica com 30,00.
      await page.locator('#fsSplitAdd').click();
      await page.locator('[data-split-v="1"]').fill('10');
      await page.waitForFunction(() => /R\$\s?30,00/.test(document.getElementById('fsSplitRest').textContent));
      await page.getByRole('button', { name: 'Não quis se identificar' }).click();
      if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/pagamento-dividido.png' });
      await page.locator('#fsSaleBtn').click();
      await page.waitForFunction(() => /registrada: R\$\s?100,00\. Troco: R\$\s?40,00/.test(document.getElementById('panelFeedback')?.textContent || ''));
      await page.waitForFunction(() => /Dinheiro R\$\s?60,00 \+ Débito R\$\s?10,00 \+ Pix R\$\s?30,00/.test(document.querySelector('.fs-col-report').textContent));
      const last = (await api('/store/cash')).sales[0];
      assert.deepEqual(last.payments, [{ method: 'cash', amount_cents: 6000 }, { method: 'debit', amount_cents: 1000 }, { method: 'pix', amount_cents: 3000 }]);
      // Valores que passam do total não deixam registrar.
      await page.locator('#fsSale [name=total]').fill('50');
      await page.locator('#fsSale [name=method][value=split]').check({ force: true });
      await page.locator('[data-split-v="0"]').fill('80');
      await page.getByRole('button', { name: 'Não quis se identificar' }).click();
      await page.locator('#fsSaleBtn').click();
      await page.waitForFunction(() => /já cobrem o total/.test(document.getElementById('fsSaleStatus').textContent));
      assert.deepEqual(errors, []);
    }
  } finally { await browser?.close(); await f.cleanup(); }
});
