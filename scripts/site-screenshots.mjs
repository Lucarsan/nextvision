// Gera as imagens da página "O que é o Ficou Pronto?" a partir do sistema de verdade:
// sobe uma loja de exemplo (pet shop, dados fictícios) num banco local, abre cada tela e salva em public/img/site/.
// Uso: TEST_DATABASE_URL=postgres://...local... BROWSER_EXECUTABLE=/caminho/do/chrome node scripts/site-screenshots.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { createStoreFixture, FIXTURE_ADMIN } from '../test/helpers/store-fixture.js';

const OUT = process.env.OUT_DIR || 'public/img/site';
const RAW = process.env.RAW_DIR || '/tmp/site-raw';
fs.mkdirSync(RAW, { recursive: true });
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }

const day = (n = 0) => { const d = new Date(Date.now() + n * 86400000); return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(d); };
const f = await createStoreFixture();
let browser;
try {
  const { api, db, tenant, masterToken } = f;
  await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true, niche: 'pet' } });
  await api('/store/settings', { method: 'PATCH', body: { name: 'Pet Shop Exemplo', logo_url: '', email_notifications: 'off' } });
  await db.query("UPDATE users SET name='Carla' WHERE tenant_id=$1 AND role='owner'", [tenant]);
  const joana = await f.addOperator(tenant, 'full', 'Joana');

  // Processo e serviços do pet shop.
  const proc = await api('/processes', { method: 'POST', body: { name: 'Banho e tosa', steps: ['Banho', 'Secagem', 'Tosa', 'Pronto para retirada'] } }, 201);
  const procB = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Banho', 'Secagem', 'Pronto para retirada'] } }, 201);
  const size = (m, g) => [{ name: 'Médio', cents: m }, { name: 'Grande', cents: g }];
  const svc = {};
  for (const [name, price, rules, addon] of [
    ['Banho', 4000, { size: size(1000, 2500), coat: [{ name: 'Longo', cents: 1000 }] }, false],
    ['Banho e tosa', 7000, { size: size(1500, 3500), coat: [{ name: 'Longo', cents: 1500 }] }, false],
    ['Tosa higiênica', 2500, { size: size(500, 1000) }, true],
    ['Hidratação', 2000, { size: size(500, 1000) }, true],
    ['Corte de unhas', 1500, {}, true]]) {
    svc[name] = await api('/store/sales/service-items', { method: 'POST', body: { name, price_cents: price, addon, price_rules: rules } }, 201);
  }

  // Clientes e pets (nomes fictícios).
  const people = [
    ['Mariana Costa', '85991234501', ['Thor', 'Cão', 'Golden Retriever', 'Grande', 'Longo', 31]],
    ['Ricardo Alves', '85991234502', ['Mel', 'Cão', 'Shih Tzu', 'Pequeno', 'Longo', 6]],
    ['Fernanda Lima', '85991234503', ['Luna', 'Cão', 'Poodle', 'Médio', 'Curto', 9]],
    ['Paulo Mendes', '85991234504', ['Bob', 'Cão', 'Lhasa Apso', 'Pequeno', 'Longo', 7]],
    ['Camila Rocha', '85991234505', ['Nina', 'Cão', 'Yorkshire', 'Pequeno', 'Longo', 3]],
    ['José Freitas', '85991234506', ['Pipoca', 'Cão', 'SRD', 'Médio', 'Curto', 14]],
    ['Aline Souza', '85991234507', ['Fred', 'Gato', 'Persa', 'Pequeno', 'Longo', 4]],
    ['Bruno Teixeira', '85991234508', ['Max', 'Cão', 'Border Collie', 'Grande', 'Longo', 19]]];
  const cust = [];
  for (const [name, phone, [pet, species, breed, sz, coat, kg]] of people) {
    const c = await api('/customers', { method: 'POST', body: { name, phone } }, 201);
    const p = await api('/customers/' + c.id + '/pets', { method: 'POST', body: { name: pet, species, breed, size: sz, coat, weight_kg: kg } }, 201);
    cust.push({ ...c, pet: { ...p, name: pet, species, breed, size: sz, coat } });
  }
  // Prontuário: vacinas e vermífugo com retornos.
  const rec = (i, kind, title, d, next) => api('/pets/' + cust[i].pet.id + '/records', { method: 'POST', body: { kind, title, record_date: day(d), next_date: next == null ? null : day(next) } }, 201);
  await rec(0, 'vaccine', 'V10 (reforço anual)', -360, 5); await rec(0, 'deworming', 'Vermífugo', -80, 10);
  await rec(1, 'vaccine', 'Antirrábica', -350, 15); await rec(2, 'antiparasitic', 'Antipulgas', -28, 2);
  await rec(4, 'vaccine', 'V10', -370, -5); await rec(5, 'consult', 'Consulta de rotina', -40, null);

  // Pedidos de hoje em etapas diferentes.
  const orders = [];
  const mk = async (i, p, svcName) => {
    const c = cust[i];
    const o = await api('/orders', { method: 'POST', body: { customer_id: c.id, process_id: p.id, reference: String(1040 + orders.length), details: { item_type: 'pet', pet_name: c.pet.name, species: c.pet.species, breed: c.pet.breed, size: c.pet.size } } }, 201);
    orders.push(o); return o;
  };
  const tr = async (o, action) => { const r = await f.request('/orders/' + o.id + '/transition', { method: 'POST', body: { action, without_video: true } }); if (r.status !== 200) console.log('transição', action, r.status, r.data.error); };
  const o1 = await mk(0, proc, 'Banho e tosa'); await tr(o1, 'start');
  const o2 = await mk(1, proc, 'Banho e tosa'); await tr(o2, 'start'); await tr(o2, 'advance'); await tr(o2, 'advance');
  const o3 = await mk(2, procB, 'Banho'); await tr(o3, 'start'); await tr(o3, 'advance');
  const o4 = await mk(3, procB, 'Banho'); await tr(o4, 'start'); await tr(o4, 'advance'); await tr(o4, 'advance'); await tr(o4, 'advance'); await tr(o4, 'complete');
  const o5 = await mk(4, proc, 'Banho e tosa'); await mk(5, procB, 'Banho');

  // Fidelidade e cashback.
  await api('/store/loyalty', { method: 'PATCH', body: { loyalty_enabled: true, loyalty_target: 10, loyalty_reward: '1 banho grátis' } });
  await api('/store/sales/cashback', { method: 'PATCH', body: { cashback_enabled: true, cashback_percent: 5, cashback_valid_days: 60 } }).catch(() => {});
  await api('/store/sales/config', { method: 'PATCH', body: { google_review_url: 'https://g.page/r/exemplo/review' } }).catch(() => {});

  // Caixa e vendas do dia.
  await api('/store/cash/open', { method: 'POST', body: { opening_cents: 15000 } }, 201);
  const sale = (i, items, method, token) => api('/store/sales', { method: 'POST', token, body: { customer_id: cust[i].id, payment_method: method, items: items.map(([s, cents]) => ({ service: s, unit_price_cents: cents, device_model: cust[i].pet.name, catalog_id: svc[s].id })) } }, 201);
  await sale(3, [['Banho', 4000], ['Hidratação', 2000]], 'pix', joana.token);
  await sale(6, [['Banho', 5000], ['Corte de unhas', 1500]], 'credit', joana.token);
  await sale(7, [['Banho e tosa', 12000], ['Tosa higiênica', 3500]], 'pix');
  await sale(5, [['Banho', 5000]], 'cash', joana.token);
  // Produtos.
  for (const [name, price, cost, barcode] of [['Ração Premium Adulto 15 kg', 28990, 21500, '7891000100011'], ['Shampoo neutro 500 ml', 3490, 1800, '7891000100028'], ['Petisco dental (7 un.)', 2290, 1100, '7891000100035'], ['Coleira antipulgas', 8990, 5200, '7891000100042'], ['Areia sanitária 4 kg', 2490, 1400, '7891000100059']]) {
    await api('/store/products', { method: 'POST', body: { name, price_cents: price, cost_cents: cost, barcode, stock: 12 } }, 201).catch(async () => api('/store/products', { method: 'POST', body: { name, price_cents: price, cost_cents: cost, barcode } }, 201));
  }
  // Metas e comissão.
  const month = day().slice(0, 7);
  await api('/store/sales/goals', { method: 'PUT', admin: true, body: { month, target_cents: 3000000 } });
  await api('/store/sales/commission/' + joana.id, { method: 'PATCH', admin: true, body: { commission_percent: 10, commission_base: 'addons' } });

  browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, locale: 'pt-BR', timezoneId: 'America/Fortaleza' });
  await ctx.addInitScript(v => sessionStorage.setItem('nv_token', v), f.ownerToken);
  const page = await ctx.newPage();
  const shot = async name => { await page.waitForTimeout(700); await page.screenshot({ path: `${RAW}/${name}.png` }); console.log('ok', name); };
  const view = async v => { await page.locator(`.nv-sidebar [data-view="${v}"]`).click(); await page.waitForTimeout(900); };
  await page.goto(f.base + '/loja.html'); await page.waitForTimeout(1500);
  await shot('visao-geral');
  await view('customers'); await shot('clientes');
  await view('pets'); await shot('animais');
  await view('cash'); await page.getByRole('button', { name: 'Mostrar valores' }).click().catch(() => {}); await shot('caixa');
  await view('dayservices'); await shot('servicos-do-dia');
  await view('stock'); await shot('estoque');
  await view('messages'); await shot('mensagens');
  await view('goals');
  await page.locator('#fsGoalsUnlock').click();
  await page.locator('#fsAdminF [name=login]').fill(FIXTURE_ADMIN.login); await page.locator('#fsAdminF [name=password]').fill(FIXTURE_ADMIN.password);
  await page.locator('#fsAdminF button.nv-button').first().click(); await page.waitForSelector('#fsGoalForm');
  await shot('metas');
  // Página do tutor no celular: na fila e, com vídeo de exemplo, no banho.
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, locale: 'pt-BR' });
  const mp = await mob.newPage();
  const local = u => u.replace(/^https?:\/\/[^/]+/, f.base);
  await mp.goto(local(o5.tracking_url)); await mp.waitForTimeout(2000);
  await mp.screenshot({ path: `${RAW}/tutor-fila.png` }); console.log('ok tutor-fila');
  await db.query('UPDATE tenants SET demo_mode=true, demo_step_seconds=600 WHERE id=$1', [tenant]);
  await mp.goto(local(o1.tracking_url)); await mp.waitForTimeout(5000);
  await mp.screenshot({ path: `${RAW}/tutor-video.png` }); console.log('ok tutor-video');
} finally { await browser?.close(); await f.cleanup(); }
