// Gera os prints do manual (public/manual/img) com dados de demonstração num banco de teste local.
// Uso: TEST_DATABASE_URL=postgres://... BROWSER_EXECUTABLE=/caminho/do/chrome node scripts/manual-shots.mjs
// Nenhum dado real: rede, unidades, pessoas, peças e clientes são inventados.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createStoreFixture } from '../test/helpers/store-fixture.js';

const OUT = new URL('../public/manual/img/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const HOST = 'rede-demo.example.test';
const f = await createStoreFixture(); let browser;
try {
  const { api, tenant, foreignTenant, masterToken, base, db } = f;
  const port = new URL(base).port, site = `http://${HOST}:${port}`;
  const net = await api('/master/networks', { method: 'POST', token: masterToken, body: { name: 'Audace Joias', slug: 'demo-manual', hostname: HOST } }, 201);
  for (const [id, label] of [[tenant, 'Grand Shopping'], [foreignTenant, 'Iguatemi']]) {
    await api(`/master/tenants/${id}/network`, { method: 'PATCH', token: masterToken, body: { network_id: net.id, unit_label: label } });
    await api('/master/tenants/' + id, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
  }
  await db.query("UPDATE tenants SET name = CASE WHEN id = $1 THEN 'Audace Grand Shopping' ELSE 'Audace Iguatemi' END WHERE id IN ($1, $2)", [tenant, foreignTenant]);
  await db.query("UPDATE users SET name = 'Gerente Demo', email = id || '@demo.test' WHERE role = 'owner'");
  const people = `/master/networks/${net.id}/people`;
  await api(people, { method: 'POST', token: masterToken, body: { name: 'Gestão Demo', email: 'gestao@demo.test', function: 'dono', password: 'senha-gestao-demo-1' } }, 201);
  await api(people, { method: 'POST', token: masterToken, body: { name: 'Supervisor Demo', email: 'sup@demo.test', function: 'supervisor', unit_ids: [tenant, foreignTenant], password: 'senha-sup-demo-123' } }, 201);
  const ana = await api(people, { method: 'POST', token: masterToken, body: { name: 'Ana Souza', function: 'vendedora', unit_id: tenant, pin: '1111' } }, 201);
  await api(people, { method: 'POST', token: masterToken, body: { name: 'Bia Lima', function: 'vendedora', unit_id: tenant, pin: '2222' } }, 201);
  await api(people, { method: 'POST', token: masterToken, body: { name: 'Carla Melo', function: 'vendedora', unit_id: foreignTenant, pin: '3333' } }, 201);
  const prods = [['Anel prata estrela de Davi', '003628', 22900], ['Brinco gota banho de ouro', '003622', 8900], ['Colar ponto de luz', '003410', 15900], ['Pulseira riviera zircônia', '003501', 19900], ['Aliança prata trabalhada', '003277', 12900], ['Pingente coração vazado', '003133', 6900], ['Anel solitário prata', '003390', 14900], ['Brinco argola média', '003455', 7900]];
  for (const t of [tenant, foreignTenant]) for (const [i, [n, code, price]] of prods.entries())
    await db.query('INSERT INTO products(tenant_id,name,barcode,code,price_cents,stock_qty) VALUES($1,$2,$3,$3,$4,$5)', [t, n, code, price, t === tenant ? 3 + (i % 4) : i % 3]);
  const login = async (email, password) => (await f.request('/auth/login', { method: 'POST', token: null, body: { email, password } })).data.token;
  const gestao = await login('gestao@demo.test', 'senha-gestao-demo-1');
  await api('/network/settings/cashback', { method: 'PUT', token: gestao, body: { enabled: true, percent: 5, max_use_percent: 30, valid_days: 90, min_sale_cents: 5000 } });
  await api(`/master/tenants/${tenant}/kiosk-password`, { method: 'POST', token: masterToken, body: { password: 'senha-grand-demo' } });
  const kt = (await (await fetch(base + '/api/auth/unit', { method: 'POST', headers: { Host: HOST, 'Content-Type': 'application/json' }, body: JSON.stringify({ unit_id: tenant, password: 'senha-grand-demo' }) })).json()).token;
  if (!kt) throw Error('quiosque não abriu');

  const require = createRequire(import.meta.url);
  let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
  browser = await pw.chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`] });
  const shot = async (page, name, opts = {}) => { await page.waitForTimeout(400); await page.screenshot({ path: OUT + name, ...opts }); console.log('ok', name); };
  const view = { width: 1366, height: 768 };

  // ----- Quiosque -----
  const c0 = await browser.newContext({ viewport: view });
  const p0 = await c0.newPage();
  await p0.goto(site + '/acesso'); await p0.waitForTimeout(800);
  await shot(p0, 'v-entrar.png');

  const ck = await browser.newContext({ viewport: view });
  await ck.addInitScript(v => localStorage.setItem('fp_kiosk_token', v), kt);
  const pk = await ck.newPage(); pk.on('dialog', d => d.accept());
  await pk.goto(site + '/caixa');
  await pk.waitForSelector('#closedBox:not([hidden])');
  await pk.fill('#openCash', '150,00'); await shot(pk, 'v-abrir-caixa.png');
  const pin = async (digits) => { for (const d of digits) await pk.click(`#keys [data-k="${d}"]`); };
  await pk.click('#openBtn'); await pk.click('#openWho button:has-text("Ana")'); await pin('1111');
  await pk.waitForSelector('#cashBox:not([hidden])');
  // Vendas de demonstração (com clientes), para o Meu dia, Clientes e Vendas e caixa ficarem reais.
  const kapi = (path, body) => api(path, { method: 'POST', token: kt, body }, 201);
  const s1 = await kapi('/store/sales', { items: [{ product_id: (await db.query("SELECT id FROM products WHERE tenant_id=$1 AND barcode='003410'", [tenant])).rows[0].id, quantity: 1 }], payment_method: 'credit', seller_id: ana.id, seller_pin: '1111', new_customer: { name: 'Mariana Alves', phone: '85988887777' } });
  await kapi('/store/sales', { items: [{ product_id: (await db.query("SELECT id FROM products WHERE tenant_id=$1 AND barcode='003455'", [tenant])).rows[0].id, quantity: 2 }], payment_method: 'pix', seller_id: ana.id, seller_pin: '1111', new_customer: { name: 'Juliana Costa', phone: '85977776666' } });
  await kapi('/store/sales', { items: [{ product_id: (await db.query("SELECT id FROM products WHERE tenant_id=$1 AND barcode='003133'", [tenant])).rows[0].id, quantity: 1 }], payment_method: 'cash', seller_id: ana.id, seller_pin: '1111', anonymous: true });
  // Venda em andamento na tela
  await pk.reload(); await pk.waitForSelector('#cashBox:not([hidden])');
  for (const code of ['003628', '003622']) { await pk.fill('#scan', code); await pk.press('#scan', 'Enter'); await pk.waitForTimeout(500); }
  await pk.fill('#custQ', 'Mariana'); await pk.waitForSelector('#custResults:not([hidden]) >> text=Mariana'); await pk.click('#custResults >> text=Mariana');
  await pk.click('#pay [data-m="pix"]');
  await pk.click('#sellers button:has-text("Ana")'); await pin('1111');
  await pk.waitForSelector('#pinOk:not([hidden])');
  await shot(pk, 'v-caixa.png');
  await pk.click('#finish'); await pk.waitForSelector('#doneBox:not([hidden])');
  await pk.evaluate(() => document.getElementById('doneBox').scrollIntoView({ block: 'center' }));
  await shot(pk, 'v-venda-ok.png');
  // Meu dia
  await pk.click('[data-view="day"]'); await pk.click('#daySellers button:has-text("Ana")'); await pin('1111');
  await pk.waitForSelector('#dayBox:not([hidden])'); await shot(pk, 'v-meudia.png');
  await pk.click('#dayLock');
  // Clientes
  await pk.click('[data-view="clients"]'); await pk.waitForSelector('#clRows tr'); await shot(pk, 'v-clientes.png');
  // Mensagens
  await pk.click('[data-view="msgs"]'); await pk.waitForTimeout(800); await shot(pk, 'v-mensagens.png');
  // Garantia
  await pk.click('[data-view="warranty"]'); await pk.fill('#wCode', s1.sale.receipt_code); await pk.click('#wFind');
  await pk.waitForSelector('#wBox:not([hidden])'); await shot(pk, 'v-garantia.png');
  // Estoque
  await pk.click('[data-view="stock"]'); await pk.waitForSelector('#sfRes tr'); await shot(pk, 'v-estoque.png');
  // Vendas e caixa
  await pk.click('[data-view="sales"]'); await pk.waitForSelector('#tSales tr'); await shot(pk, 'v-vendas-caixa.png');
  // Fechar caixa (só o diálogo; não fecha)
  await pk.click('[data-view="cash"]'); await pk.click('#topClose'); await pk.waitForSelector('#clDlg[open]'); await pk.fill('#cdCash', '150,00'); await shot(pk, 'v-fechar.png');

  // ----- Painel da rede (gestão) -----
  const cg = await browser.newContext({ viewport: view });
  await cg.addInitScript(v => sessionStorage.setItem('nv_token', v), gestao);
  const pg = await cg.newPage(); pg.on('dialog', d => d.accept());
  await pg.goto(site + '/rede.html'); await pg.waitForSelector('#nav a');
  const go = async (hash, wait, name, before) => { await pg.click('#nav a[data-page="' + hash + '"]'); await pg.waitForSelector(wait, { state: 'attached' }); if (before) await before(); await pg.evaluate(() => window.scrollTo(0, 0)); await shot(pg, name); };
  await go('overview', '#rows tr', 's-visao-geral.png');
  const pickUnit = async id => { await pg.waitForFunction(v => !v || [...document.getElementById('unitSel').options].some(o => o.value === v), id); await pg.evaluate(v => { const s = document.getElementById('unitSel'); s.value = v; s.onchange(); }, id); };
  await go('loja', '#upTitle', 's-painel-loja.png', async () => { await pickUnit(tenant); await pg.waitForSelector('#upSales tr'); await pg.waitForTimeout(600); });
  await pickUnit('');
  await go('pessoas', '#pcRows tr', 's-pessoas.png');
  await go('estoque', '#nsTabs button', 's-estoque.png', async () => { await pg.waitForTimeout(1200); });
  await go('metas', '#gUnits', 's-metas.png', async () => { await pg.waitForTimeout(800); });
  await go('clientes', '#cpTitle', 's-campanhas.png', async () => { await pg.fill('#cpTitle', 'Dia das Mães'); await pg.fill('#cpBody', 'Olá, {nome}! Neste Dia das Mães, venha escolher o presente na Audace. Seu saldo de cashback: {saldo}.'); });
  await go('treinamento', '#trBox section', 's-treinamento.png', async () => { await pg.waitForTimeout(800); });
  await go('config', '#cbPct', 'g-config.png', async () => { await pg.waitForTimeout(800); });
  await go('relatorios', '#repMonth', 'g-relatorios.png');
  await go('implantacao', '#obBox table', 'g-implantacao.png');
} finally { await browser?.close(); await f.cleanup(); }
