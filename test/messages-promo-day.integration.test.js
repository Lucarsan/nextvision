import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const todayDow = () => WD[new Intl.DateTimeFormat('en-US', { timeZone: 'America/Fortaleza', weekday: 'short' }).format(new Date())];
const DAY = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

// Alê Pet's (13/11/2026): no dia de promoção o banho não soma ponto; a mensagem só agradece, convida a voltar e pede avaliação (sem cartão);
// e o cartão fala em "banhos" ("0 de 10 banhos. Faltam 10 banhos para ganhar 1 (uma) hidratação grátis.").
test('mensagens: dia de promoção agradece sem falar do cartão e o cartão usa o nome do serviço', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  try {
    const { api, tenant, masterToken } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true, niche: 'pet' } });
    const banhoP = await api('/store/sales/service-items', { method: 'POST', body: { name: 'BANHO P', price_cents: 4000 } }, 201);
    const banhoG = await api('/store/sales/service-items', { method: 'POST', body: { name: 'Banho e tosa G', price_cents: 9000 } }, 201);
    const base = { loyalty_enabled: true, loyalty_target: 10, loyalty_reward: '1 (uma) hidratação grátis' };
    await api('/store/loyalty', { method: 'PATCH', body: { ...base, loyalty_off_weekdays: [], loyalty_service_ids: [banhoP.id, banhoG.id] } });
    await api('/store/sales/config', { method: 'PATCH', body: { google_review_url: 'https://g.page/r/teste' } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const buy = name => api('/store/sales', { method: 'POST', body: { new_customer: { name, phone: '8599999' + String(Math.floor(Math.random() * 1e4)).padStart(4, '0') }, payment_method: 'pix', items: [{ service: 'BANHO P', unit_price_cents: 4000, catalog_id: banhoP.id }] } }, 201);
    const normal = await buy('Bruna Normal');
    assert.equal(normal.loyalty_counted, true);
    // Compra que não somou ponto num dia comum (ex.: antes da fidelidade começar, ou sem serviço que conta).
    const semPonto = await api('/store/sales', { method: 'POST', body: { new_customer: { name: 'Carla Sem Ponto', phone: '85988887777' }, payment_method: 'pix', total_cents: 3000 } }, 201);
    assert.equal(semPonto.loyalty_counted, false);
    await f.db.query(`UPDATE sales SET created_at=now()-interval '1 day' WHERE id=$1`, [semPonto.sale.id]); // ontem: não é dia de promoção
    // Hoje vira dia de promoção: o banho de agora não soma.
    const today = todayDow();
    await api('/store/loyalty', { method: 'PATCH', body: { ...base, loyalty_off_weekdays: [today] } });
    const promo = await buy('Alexsandra Promo');
    assert.equal(promo.loyalty_counted, false); assert.equal(promo.sale.loyalty_skip, 'weekday');

    const cfg = await api('/store/sales/config');
    assert.deepEqual(cfg.loyalty_unit, { one: 'banho', many: 'banhos' }, 'todos os serviços que contam começam com "banho"');
    const st = await api('/store/messages/status');
    const row = n => st.customers.find(c => c.name === n);
    assert.equal(row('Alexsandra Promo').loyalty_promo_dow, today);
    assert.equal(row('Bruna Normal').loyalty_promo_dow, null); assert.equal(row('Bruna Normal').loyalty_not_counted, false);
    assert.equal(row('Alexsandra Promo').loyalty_not_counted, true); const carla = st.pending.find(c => c.name === 'Carla Sem Ponto');
    assert.equal(carla.loyalty_not_counted, true); assert.equal(carla.loyalty_promo_dow, null);

    if (process.env.BROWSER_EXECUTABLE) {
      const require = createRequire(import.meta.url);
      let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
      browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
      const context = await browser.newContext({ viewport: { width: 1400, height: 950 } }); await context.addInitScript(v => sessionStorage.setItem('nv_token', v), f.ownerToken);
      const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto(f.base + '/loja.html');
      await page.locator('.nv-menu [data-view="messages"]').click();
      await page.waitForSelector('[data-fs-send]');
      const msg = async id => page.locator(`[data-fs-row="${id}"] .fs-pre`).textContent();
      const promoText = await msg(promo.customer.id);
      assert.match(promoText, /^Olá, Alexsandra! Obrigado pela preferência/);
      assert.match(promoText, new RegExp(`Foi um prazer cuidar do seu pet na promoção de ${DAY[today]}\\. Esperamos vocês de volta em breve!`));
      assert.match(promoText, /avaliar no Google\? Leva 1 minutinho: https:\/\/g\.page\/r\/teste/);
      assert.doesNotMatch(promoText, /cartão|fidelidade|Regras:|de 10/i);
      const semPontoText = await msg(semPonto.customer.id);
      assert.match(semPontoText, /Foi um prazer cuidar do seu pet\. Esperamos vocês de volta em breve!/);
      assert.doesNotMatch(semPontoText, /cartão|fidelidade|Regras:|de 10|promoção/i);
      const normalText = await msg(normal.customer.id);
      assert.match(normalText, /Cartão fidelidade: 1 de 10 banhos\. Faltam 9 banhos para ganhar 1 \(uma\) hidratação grátis\./);
      assert.match(await page.locator('.fs-daybar').first().textContent(), /0 de 3 enviados/);
      if (process.env.SHOT_DIR) { await page.locator(`[data-fs-row="${promo.customer.id}"] summary`).click(); await page.screenshot({ path: process.env.SHOT_DIR + '/mensagem-promocao.png' }); }
      assert.deepEqual(errors, []);
    }
  } finally { await browser?.close(); await f.cleanup(); }
});
