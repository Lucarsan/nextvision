import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createStoreFixture } from './helpers/store-fixture.js';

test('store panel daily workflows in Chromium', {
  skip: process.env.TEST_DATABASE_URL && process.env.BROWSER_EXECUTABLE ? false : 'Set TEST_DATABASE_URL and BROWSER_EXECUTABLE', timeout: 120000
}, async t => {
  const f = await createStoreFixture(); let browser;
  try {
    const { chromium } = createRequire(import.meta.url)('playwright');
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext(); await context.addInitScript(value => sessionStorage.setItem('nv_token', value), f.ownerToken);
    const page = await context.newPage(); const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    const camera = await f.api('/cameras', { method: 'POST', token: f.masterToken, body: { tenant_id: f.tenant, name: 'Camera aprovada' } }, 201);
    const workflow = await f.api('/processes', { method: 'POST', body: { name: 'Processo da oficina', steps: ['Recepção', 'Reparo', 'Inspeção'], camera_id: camera.id } }, 201);
    const makeQuick = reference => f.api('/orders/quick', { method: 'POST', body: { reference, process_id: workflow.id } }, 201);
    for (let i = 0; i < 15; i++) await makeQuick('BASE-' + String(i).padStart(2, '0'));
    await page.goto(f.base + '/loja.html');
    const view = name => page.locator('.nv-sidebar [data-view="' + name + '"]').click();
    let orderId, orderPath;
    await t.test('overview displays every order and filters status without a twelve-item limit', async () => {
      await page.waitForFunction(() => document.querySelectorAll('#ordersList > [data-order-id]').length === 15);
      assert.match(await page.locator('#ordersList > article').first().innerText(), /BASE-14/);
      await page.getByRole('combobox', { name: 'Exibir pedidos na visão geral' }).selectOption('live');
      assert.equal(await page.locator('#ordersList > article').count(), 0);
      await page.getByRole('combobox', { name: 'Exibir pedidos na visão geral' }).selectOption('');
      assert.equal(await page.locator('#ordersList > article').count(), 15);
      await page.getByRole('searchbox', { name: 'Buscar pedidos na visão geral' }).fill('BASE-03');
      assert.equal(await page.locator('#ordersList > article').count(), 1);
      await page.getByRole('searchbox', { name: 'Buscar pedidos na visão geral' }).fill('');
    });
    await t.test('an order creates its customer inline, persists vehicle details and appears immediately', async () => {
      await view('orders'); const form = page.locator('#completeForm');
      await page.getByRole('button', { name: '+ Cadastrar cliente', exact: true }).click();
      await form.locator('[name="inline_name"]').fill('Cliente cadastrado no pedido');
      await form.locator('[name="inline_phone"]').fill('85999990001');
      await page.getByRole('button', { name: 'Salvar cliente e selecionar' }).click();
      await page.waitForFunction(() => !!document.querySelector('#completeForm [name="customer_id"]').value);
      await form.locator('[name="detail_item_type"]').selectOption('vehicle');
      await form.locator('[name="detail_brand"]').fill('Toyota'); await form.locator('[name="detail_model"]').fill('Corolla');
      await form.locator('[name="detail_identifier"]').fill('TEST-123'); await form.locator('[name="detail_service"]').fill('Revisão preventiva');
      await form.locator('[name="reference"]').fill('UI-CAR'); await form.locator('[name="process_id"]').selectOption(workflow.id);
      const response = page.waitForResponse(r => r.url().endsWith('/api/orders') && r.request().method() === 'POST');
      await form.getByRole('button', { name: 'Criar pedido', exact: true }).click();
      const created = await response; assert.equal(created.status(), 201); const data = await created.json(); orderId = data.id; orderPath = new URL(data.tracking_url).pathname;
      await page.locator(`#datedOrders [data-order-id="${orderId}"]`).waitFor();
      assert.equal(await page.locator('#datedOrders > article').first().getAttribute('data-order-id'), orderId);
      assert.equal(await form.locator('[name="detail_brand"]').inputValue(), '');
      assert.match(await page.locator('#completeStatus').textContent(), /Pedido criado/);
      const stored = (await f.api('/orders')).find(o => o.id === orderId); assert.equal(stored.details.model, 'Corolla');
      assert.equal(stored.customer, 'Cliente cadastrado no pedido');
    });
    await t.test('all stage controls work inside Orders and editing preserves a draft during automatic refresh', async () => {
      const card = page.locator(`#datedOrders [data-order-id="${orderId}"]`);
      await card.getByRole('button', { name: 'Iniciar atendimento' }).click();
      await card.getByRole('button', { name: 'Próxima etapa' }).waitFor();
      await card.getByRole('button', { name: 'Próxima etapa' }).click();
      await page.waitForFunction(id => document.querySelector(`#datedOrders [data-order-id="${id}"] .nv-order-progress strong`)?.textContent === 'Reparo', orderId);
      await card.locator('summary').click(); await card.getByRole('button', { name: 'Editar pedido' }).click();
      const dialog = page.locator('#editorDialog'); await dialog.locator('[name="detail_notes"]').fill('Rascunho deve permanecer durante atualização');
      await dialog.getByRole('button', { name: 'Pausar', exact: true }).click();
      await dialog.getByRole('button', { name: 'Retomar atendimento' }).waitFor();
      await dialog.getByRole('button', { name: 'Voltar etapa' }).click();
      await page.waitForFunction(() => document.querySelector('[data-dialog-order-status]')?.textContent.includes('Recepção'));
      await page.waitForTimeout(5500);
      assert.equal(await dialog.locator('[name="detail_notes"]').inputValue(), 'Rascunho deve permanecer durante atualização');
      await dialog.getByRole('button', { name: 'Retomar atendimento' }).click();
      await dialog.getByRole('button', { name: 'Pausar', exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Salvar alterações' }).click();
      await page.waitForFunction(() => !document.querySelector('#editorDialog').open);
      const stored = (await f.api('/orders')).find(o => o.id === orderId); assert.equal(stored.details.notes, 'Rascunho deve permanecer durante atualização'); assert.equal(stored.step_index, 0);
      const records = (await f.db.query('SELECT id FROM recordings WHERE order_id=$1', [orderId])).rows;
      assert.equal(new Set(records.map(r => r.id)).size, records.length); assert.ok(records.length >= 3);
    });
    await t.test('a live order can be deleted directly without advancing to its last stage', async () => {
      const card = page.locator(`#datedOrders [data-order-id="${orderId}"]`);
      page.once('dialog', dialog => dialog.accept());
      await card.getByRole('button', { name: 'Excluir pedido', exact: true }).click();
      await card.waitFor({ state: 'detached' });
      assert.equal((await f.request('/public/orders/' + orderPath.split('/').at(-1), { token: null })).status, 404);
    });
    await t.test('orders from another session appear without F5, and form drafts survive polling', async () => {
      const form = page.locator('#completeForm'); await form.locator('[name="detail_brand"]').fill('Não apagar meu rascunho');
      await makeQuick('OUTRA-SESSAO'); await page.waitForTimeout(5500);
      assert.equal(await form.locator('[name="detail_brand"]').inputValue(), 'Não apagar meu rascunho');
      await view('home');
      await page.waitForFunction(() => document.querySelector('#ordersList > article')?.textContent.includes('OUTRA-SESSAO'));
      const created = await makeQuick('CHEGOU-AGORA');
      await page.locator(`#ordersList [data-order-id="${created.id}"]`).waitFor({ timeout: 10000 });
      assert.equal(await page.locator('#ordersList > article').first().getAttribute('data-order-id'), created.id);
    });
    await t.test('customers are read-only rows until Edit opens a form', async () => {
      await view('customers'); await page.locator('.nv-customer-row').first().waitFor();
      assert.equal(await page.locator('.nv-customer-row input').count(), 0);
      await page.locator('.nv-customer-row').filter({ hasText: 'Cliente cadastrado no pedido' }).getByRole('button', { name: 'Editar', exact: true }).click();
      await page.locator('#editCustomerForm [name="name"]').fill('Cliente atualizado');
      await page.locator('#editCustomerForm').getByRole('button', { name: 'Salvar alterações' }).click();
      await page.waitForFunction(() => !document.querySelector('#editorDialog').open);
      assert.match(await page.locator('#customerList').innerText(), /Cliente atualizado/);
      if (process.env.TEST_SCREENSHOT_DIR) { await mkdir(process.env.TEST_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: process.env.TEST_SCREENSHOT_DIR + '/customers.png' }); }
    });
    await t.test('the store sees no niche catalog or camera installation controls and requests a plan via WhatsApp', async () => {
      await view('processes'); await page.locator('#processForm').waitFor(); assert.equal(await page.getByText('Modelo predefinido', { exact: true }).count(), 0);
      await view('cameras'); await page.getByRole('heading', { name: 'Câmeras autorizadas' }).waitFor();
      assert.equal(await page.locator('#sectionContent input').count(), 0);
      await f.api('/master/settings', { method: 'PUT', token: f.masterToken, body: { sales_whatsapp: '5585999990000' } });
      await view('plan'); await page.locator('#requestedCameras').fill('6');
      const link = new URL(await page.locator('#salesContact').getAttribute('href'));
      assert.equal(link.hostname, 'wa.me'); assert.equal(link.pathname, '/5585999990000'); assert.match(link.searchParams.get('text'), /6 câmera/);
      assert.equal((await f.api('/store/settings')).camera_limit, 1);
    });
    await t.test('the central configures niches, camera limits, commercial contact and camera inventory', async () => {
      const adminContext=await browser.newContext();await adminContext.addInitScript(value=>sessionStorage.setItem('nv_token',value),f.masterToken);
      const admin=await adminContext.newPage();
      try{
        await admin.goto(f.base+'/');await admin.locator('#storeCameraLimit').waitFor();
        await admin.locator('#name').fill('Loja administrada');await admin.locator('#slug').fill('admin-browser');
        await admin.locator('#storeNiche').selectOption('automotive');await admin.locator('#storeCameraLimit').fill('6');
        const posted=admin.waitForResponse(r=>r.url().endsWith('/api/master/tenants')&&r.request().method()==='POST');
        await admin.locator('#form').getByRole('button',{name:'Cadastrar loja'}).click();
        const response=await posted;assert.equal(response.status(),201);const store=await response.json();
        await admin.locator('#limit-'+store.id).waitFor();assert.equal(await admin.locator('#limit-'+store.id).inputValue(),'6');
        assert.equal(await admin.locator('#niche-'+store.id).inputValue(),'automotive');
        await admin.locator('#status-'+store.id).selectOption('active');
        const patched=admin.waitForResponse(r=>r.url().endsWith('/api/master/tenants/'+store.id)&&r.request().method()==='PATCH');
        await admin.locator('[data-save-niche="'+store.id+'"]').click();assert.equal((await patched).status(),200);
        await admin.locator('#nav').getByRole('button',{name:'Câmeras',exact:true}).click();await admin.locator('#cameraTenant').waitFor();
        await admin.locator('#cameraTenant').selectOption(store.id);
        await admin.waitForFunction(()=>document.querySelector('#cameraCapacity')?.textContent.includes('de 6'));
        await admin.locator('#masterCameraName').fill('Câmera 1');await admin.locator('#masterCameraForm').getByRole('button',{name:'Cadastrar câmera'}).click();
        await admin.waitForFunction(()=>document.querySelector('#cameraCapacity')?.textContent.includes('1 de 6'));
        await admin.locator('#masterCameraName').fill('Câmera 2');await admin.locator('#masterCameraForm').getByRole('button',{name:'Cadastrar câmera'}).click();
        await admin.waitForFunction(()=>document.querySelector('#cameraCapacity')?.textContent.includes('2 de 6'));
        assert.equal(await admin.locator('.admin-camera').count(),2);
        await admin.locator('#nav').getByRole('button',{name:'Configurações',exact:true}).click();await admin.locator('#salesWhatsApp').fill('5585999990000');
        await admin.getByRole('button',{name:'Salvar contato'}).click();
        assert.equal((await f.api('/master/settings',{token:f.masterToken})).sales_whatsapp,'5585999990000');
      }finally{await adminContext.close();}
    });
    await t.test('the public queue updates positions and shows anonymous phases without videos of other customers',async()=>{
      const queueStore=await f.api('/master/tenants',{method:'POST',token:f.masterToken,body:{name:'Fila pública',slug:'public-queue'}},201);
      const owner=await f.addOwner(queueStore.id);
      const workflow=await f.api('/processes',{method:'POST',token:owner,body:{name:'Atendimento',steps:['Recepção','Diagnóstico','Entrega']}},201);
      const create=reference=>f.api('/orders/quick',{method:'POST',token:owner,body:{reference,process_id:workflow.id}},201);
      const running=await create('DADO-PRIVADO'),first=await create('PRIMEIRO'),second=await create('SEGUNDO');
      await f.api('/orders/'+running.id+'/transition',{method:'POST',token:owner,body:{action:'start'}});
      await f.api('/orders/'+running.id+'/transition',{method:'POST',token:owner,body:{action:'advance'}});
      const customer=await browser.newPage();try{
        await customer.goto(f.base+new URL(second.tracking_url).pathname);
        await customer.getByText('Sua vez na fila',{exact:true}).waitFor();
        assert.match(await customer.locator('.queue-position').innerText(),/2º/);assert.match(await customer.locator('.queue-services').innerText(),/Diagnóstico/);
        assert.equal(await customer.locator('video').count(),0);assert.equal((await customer.locator('body').innerText()).includes('DADO-PRIVADO'),false);
        await f.api('/orders/'+first.id,{method:'DELETE',token:owner});
        await f.api('/orders/'+running.id+'/transition',{method:'POST',token:owner,body:{action:'advance'}});
        await customer.getByRole('button',{name:'Atualizar agora'}).click();
        await customer.waitForFunction(()=>document.querySelector('.queue-position')?.textContent.startsWith('1º'));
        assert.match(await customer.locator('.queue-services').innerText(),/Entrega/);
      }finally{await customer.close();}
    });
    await t.test('mobile Orders remains usable without horizontal scrolling', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.nv-phone-nav [data-view="orders"]').click(); await page.locator('#completeForm').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
      if (process.env.TEST_SCREENSHOT_DIR) await page.screenshot({ path: process.env.TEST_SCREENSHOT_DIR + '/orders-mobile.png' });
    });
    assert.deepEqual(pageErrors, []);
  } finally { await browser?.close(); await f.cleanup(); }
});
