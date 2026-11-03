import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStoreFixture } from './helpers/store-fixture.js';

// Mensagens → Status do dia: as não enviadas de dias anteriores (até 30 dias) continuam aparecendo até enviar ou dispensar.
test('mensagens: pendentes de dias anteriores acumulam até enviar ou dispensar', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 180000
}, async () => {
  const f = await createStoreFixture(); let browser;
  try {
    const { api, db } = f;
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });
    await api('/store/cash/open', { method: 'POST', body: { opening_cents: 0 } }, 201);
    const sale = async (name, phone, daysAgo) => {
      const r = await api('/store/sales', { method: 'POST', body: { new_customer: { name, ...(phone ? { phone } : {}) }, total_cents: 1000, payment_method: 'pix' } }, 201);
      if (daysAgo) await db.query(`UPDATE sales SET created_at=now()-($2||' days')::interval WHERE id=$1`, [r.sale.id, daysAgo]);
      return r;
    };
    const ana = (await sale('Ana Ontem', '85999990001', 1)).customer.id;
    const bia = (await sale('Bia Semana', '85999990002', 6)).customer.id;
    await sale('Caio Sem Fone', null, 2);
    await sale('Davi Antigo', '85999990004', 45);
    const eva = (await sale('Eva Duas', '85999990005', 3)).customer.id;
    await api('/store/sales', { method: 'POST', body: { customer_id: eva, total_cents: 500, payment_method: 'cash' } }, 201); // comprou hoje também
    const hoje = (await sale('Hugo Hoje', '85999990006', 0)).customer.id;

    let st = await api('/store/messages/status');
    assert.deepEqual(st.customers.map(c => c.name).sort(), ['Eva Duas', 'Hugo Hoje']);
    assert.deepEqual(st.pending.map(c => c.name), ['Bia Semana', 'Ana Ontem'], 'mais antiga primeiro; sem telefone e com mais de 30 dias ficam fora; quem comprou hoje fica só em hoje');
    assert.equal(st.pending[0].purchases.length, 1); assert.equal(st.pending[0].sent, false);

    // Ver o dia de ontem: Ana aparece como compra do dia; a lista de pendentes só existe na visão de hoje.
    const ontem = (await db.query(`SELECT to_char((now() AT TIME ZONE 'America/Fortaleza')::date-1,'YYYY-MM-DD') d`)).rows[0].d;
    st = await api('/store/messages/status?day=' + ontem);
    assert.deepEqual(st.customers.map(c => c.name), ['Ana Ontem']); assert.deepEqual(st.pending, []);

    // Enviar tira da lista; dispensar também. Uma compra nova depois volta a pedir mensagem.
    await api('/store/messages/sent', { method: 'POST', body: { customer_id: ana, kind: 'status' } }, 201);
    st = await api('/store/messages/status');
    assert.deepEqual(st.pending.map(c => c.name), ['Bia Semana']);
    assert.ok(hoje);

    // Tela: bloco de pendentes, "Dispensar" e "Enviar próximo" começa pelos pendentes.
    if (process.env.BROWSER_EXECUTABLE) {
      const require = createRequire(import.meta.url);
      let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
      browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
      const context = await browser.newContext({ viewport: { width: 1400, height: 950 } }); await context.addInitScript(v => sessionStorage.setItem('nv_token', v), f.ownerToken);
      const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
      await page.goto(f.base + '/loja.html');
      await page.locator('.nv-menu [data-view="messages"]').click();
      await page.waitForSelector('.fs-pend [data-fs-skip]');
      assert.match(await page.locator('.fs-pend h3').textContent(), /Pendentes de dias anteriores \(1\)/);
      assert.match(await page.locator('.fs-pend').textContent(), /Bia Semana[\s\S]*comprou \d\d\/\d\d/);
      if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + '/mensagens-pendentes.png' });
      await page.locator(`[data-fs-skip="${bia}"]`).click();
      await page.waitForFunction(() => !document.querySelector('.fs-pend'));
      assert.deepEqual(errors, []);
    } else {
      await api('/store/messages/sent', { method: 'POST', body: { customer_id: bia, kind: 'status', campaign: 'dispensada' } }, 201);
    }
    st = await api('/store/messages/status');
    assert.deepEqual(st.pending, []);
    // Dispensada há 2 dias; comprou de novo ontem → volta a pedir mensagem.
    await db.query(`UPDATE customer_messages SET created_at=now()-interval '2 days' WHERE customer_id=$1`, [bia]);
    const nova = await api('/store/sales', { method: 'POST', body: { customer_id: bia, total_cents: 700, payment_method: 'pix' } }, 201);
    await db.query(`UPDATE sales SET created_at=now()-interval '1 day' WHERE id=$1`, [nova.sale.id]);
    st = await api('/store/messages/status');
    assert.deepEqual(st.pending.map(c => c.name), ['Bia Semana'], 'compra nova depois de dispensar volta a pedir mensagem');
  } finally { await browser?.close(); await f.cleanup(); }
});
