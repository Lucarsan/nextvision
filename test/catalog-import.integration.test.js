import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';
// Planilha no formato exportado pelo sistema antigo da Audace: 2 linhas de título antes do cabeçalho.
async function sheet(header, rows) {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('vendas e nf-e');
  ws.addRow([null, null, 'AUDACE JOIAS MARACANAU - Vendas e NF-e']); ws.addRow([null, null, 'Emitido por Administrativo']);
  ws.addRow(header); rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const post = (base, path, token, buf) => fetch(base + '/api' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body: buf }).then(async r => ({ status: r.status, data: await r.json() }));

test('central importa peças e clientes de planilha .xlsx, conferindo antes de gravar', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const { tenant, masterToken, base, api } = f;
    await api('/master/tenants/' + tenant, { method: 'PATCH', token: masterToken, body: { sales_enabled: true } });
    const prod = await sheet(['Situação', 'Descrição', 'Código', 'Família de Produto', 'Código NCM', 'Preço Unitário de Venda', 'Estoque Disponível'], [
      ['Ativo', 'ALIANCA ACO BASIC BANHO DE OURO NEW 4MM', '1511', 'ALIANÇA', '7117.19.00', 89, -85],
      ['Ativo', 'BRINCO PONTO DE LUZ', '62', 'BRINCOS', '7117.19.00', 29.9, 3],
      ['Ativo', 'ARGOLA AÇO CRAVEJADA G', '0277', 'BRINCOS', '7117.19.00', 59, -2],
      ['Ativo', 'ARGOLA AÇO CRAVEJADA G', '0277', 'BRINCOS', '7117.19.00', 59, 0],
      ['Inativo', 'PULSEIRA ANTIGA', '9999', 'PULSEIRA', '7117.19.00', 10, 0],
    ]);
    assert.equal((await post(base, `/master/tenants/${tenant}/import?dry_run=1`, f.ownerToken, prod)).status, 403);
    const dry = await post(base, `/master/tenants/${tenant}/import?dry_run=1`, masterToken, prod);
    assert.equal(dry.status, 200); assert.equal(dry.data.kind, 'products'); assert.equal(dry.data.dry_run, true);
    assert.equal(dry.data.total, 4); assert.equal(dry.data.new, 4); assert.equal(dry.data.negative_stock, 2); assert.equal(dry.data.skipped.length, 1);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM products WHERE tenant_id=$1', [tenant])).rows[0].n, 0);
    const done = await post(base, `/master/tenants/${tenant}/import`, masterToken, prod);
    assert.equal(done.status, 200);
    const rows = (await f.db.query('SELECT code,barcode,name,price_cents,stock_qty,ncm,family,fiscal_origin,active FROM products WHERE tenant_id=$1 ORDER BY code', [tenant])).rows;
    assert.deepEqual(rows.map(r => r.code), ['0277', '1511', '62']);
    assert.equal(rows[1].price_cents, 8900); assert.equal(rows[1].stock_qty, -85); assert.equal(rows[1].ncm, '71171900'); assert.equal(rows[1].fiscal_origin, 0);
    assert.equal(rows[2].barcode, '62'); assert.equal(rows[2].price_cents, 2990);
    // O caixa acha a peça pelo código curto impresso na etiqueta.
    const p = await api('/store/products/barcode/62', { token: f.ownerToken });
    assert.equal(p.name, 'BRINCO PONTO DE LUZ');
    // Reimportar atualiza (não duplica).
    const again = await post(base, `/master/tenants/${tenant}/import`, masterToken, prod);
    assert.equal(again.data.update, 3); assert.equal(again.data.new, 1);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM products WHERE tenant_id=$1', [tenant])).rows[0].n, 3);

    const cli = await sheet(['Situação', 'Tags', 'CNPJ / CPF', 'Razão Social / Nome Completo', 'Nome Fantasia / Nome Abreviado', 'Telefone', 'Contato', 'E-mail'], [
      ['Ativo', null, '090.961.743-05', 'Miguel Mendes', 'Miguel Mendes', '(85) 98133-7352', null, null],
      ['Ativo', null, null, 'Maria Sem CPF', null, '(85) 99999-0000', null, 'MARIA@EXEMPLO.COM'],
      ['Ativo', null, '090.961.743-05', 'Miguel Repetido', null, null, null, null],
    ]);
    const c1 = await post(base, `/master/tenants/${tenant}/import`, masterToken, cli);
    assert.equal(c1.status, 200); assert.equal(c1.data.kind, 'customers'); assert.equal(c1.data.new, 2); assert.equal(c1.data.skipped.length, 1);
    const cs = (await f.db.query("SELECT name,cpf,phone,email,source FROM customers WHERE tenant_id=$1 AND source='import' ORDER BY name", [tenant])).rows;
    assert.deepEqual(cs.map(c => [c.name, c.cpf, c.phone, c.email]), [['Maria Sem CPF', null, '85999990000', 'maria@exemplo.com'], ['Miguel Mendes', '09096174305', '85981337352', null]]);
    const c2 = await post(base, `/master/tenants/${tenant}/import`, masterToken, cli);
    assert.equal(c2.data.update, 2); assert.equal(c2.data.new, 0);

    assert.equal((await post(base, `/master/tenants/${tenant}/import`, masterToken, Buffer.from('não é xlsx'))).status, 400);
  } finally { await f.cleanup(); }
});
