import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createStoreFixture } from './helpers/store-fixture.js';

process.env.STOCK_VALUE_LOGIN = 'admin';
process.env.STOCK_VALUE_PASSWORD_HASH = bcrypt.hashSync('senha-de-teste-1', 8);
const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

test('dono liberado (admin_password_free) não precisa da senha do admin; os demais continuam precisando', { skip }, async () => {
  const f = await createStoreFixture();
  try {
    const owner = jwt.decode(f.ownerToken);
    await f.api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { sales_enabled: true } });

    // Antes de liberar: metas, valor do estoque e unlock pedem senha.
    assert.equal((await f.request('/store/sales/performance')).status, 401);
    assert.equal((await f.request('/store/stock/value', { method: 'POST', body: {} })).status, 400);
    assert.equal((await f.request('/store/admin/unlock', { method: 'POST', body: {} })).status, 400);
    assert.equal((await f.api('/store/sales/config')).admin_free, false);

    await f.db.query('UPDATE users SET admin_password_free=true WHERE id=$1', [owner.id]);
    assert.equal((await f.api('/store/sales/config')).admin_free, true);
    await f.api('/store/sales/performance');
    await f.api('/store/sales/goals', { method: 'PUT', body: { month: new Date().toISOString().slice(0, 7), target_cents: 3000000 } });
    const v = await f.api('/store/stock/value', { method: 'POST', body: {} });
    assert.ok(v.products);
    const u = await f.api('/store/admin/unlock', { method: 'POST', body: {} });
    assert.ok(u.admin_token);

    // Operador com a mesma marcação não é liberado (só dono).
    const op = await f.addOperator(f.tenant, 'full', 'Op');
    await f.db.query('UPDATE users SET admin_password_free=true WHERE id=$1', [op.id]);
    assert.equal((await f.request('/store/sales/performance', { token: op.token })).status, 401);
    // Outro dono da mesma loja sem a marcação continua precisando.
    const other = await f.addOwner(f.tenant);
    assert.equal((await f.request('/store/sales/performance', { token: other })).status, 401);
  } finally { await f.cleanup(); }
});
