import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreFixture } from './helpers/store-fixture.js';

// Ficha dos pets de cada tutor: API, criação automática pelo pedido e lista de clientes.
test('pets do tutor: API, pedido e lista de clientes', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 90000
}, async () => {
  const f = await createStoreFixture(); const { api, request, base } = f;
  const del = id => fetch(base + '/api/pets/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + f.ownerToken } }).then(r => r.status);
  try {
    await api('/master/tenants/' + f.tenant, { method: 'PATCH', token: f.masterToken, body: { niche: 'pet' } });
    const cli = await api('/customers', { method: 'POST', body: { name: 'Ana Lima', phone: '85988887777' } }, 201);
    const pet = await api('/customers/' + cli.id + '/pets', { method: 'POST', body: { name: 'Mel', species: 'Cão', breed: 'Poodle', sex: 'F', birth_date: '2020-05-01', weight_kg: 6.5, size: 'Pequeno', neutered: true, notes: 'Alergia a shampoo X' } }, 201);
    assert.equal(pet.name, 'Mel'); assert.equal(Number(pet.weight_kg), 6.5); assert.equal(pet.neutered, true);
    // Validação e isolamento entre lojas.
    assert.equal((await request('/customers/' + cli.id + '/pets', { method: 'POST', body: { name: '' } })).status, 400);
    assert.equal((await request('/customers/' + cli.id + '/pets', { method: 'POST', body: { name: 'X', foo: 1 } })).status, 400);
    assert.equal((await request('/customers/' + cli.id + '/pets', { method: 'POST', body: { name: 'X' }, token: f.foreignToken })).status, 404);
    assert.equal((await request('/pets/' + pet.id, { method: 'PATCH', body: { name: 'Y' }, token: f.foreignToken })).status, 404);

    // Pedido de pet com nome novo cria a ficha; com nome repetido (outra caixa) não duplica.
    const proc = await api('/processes', { method: 'POST', body: { name: 'Banho', steps: ['Banho', 'Pronto'] } }, 201);
    await api('/orders', { method: 'POST', body: { customer_id: cli.id, process_id: proc.id, details: { item_type: 'pet', pet_name: 'Thor', species: 'Cão', breed: 'Shih-tzu', size: 'Médio' } } }, 201);
    await api('/orders', { method: 'POST', body: { customer_id: cli.id, process_id: proc.id, details: { item_type: 'pet', pet_name: 'mel' } } }, 201);
    let pets = []; for (let i = 0; i < 20 && pets.length < 2; i++) { pets = await api('/customers/' + cli.id + '/pets'); if (pets.length < 2) await new Promise(r => setTimeout(r, 100)); }
    assert.deepEqual(pets.map(p => p.name), ['Mel', 'Thor']);
    assert.equal(pets[1].breed, 'Shih-tzu'); assert.equal(pets[1].size, 'Médio');

    // Lista de clientes traz os pets (para a busca pelo nome do animal).
    const listed = (await api('/customers')).find(c => c.id === cli.id);
    assert.deepEqual(listed.pets.map(p => p.name).sort(), ['Mel', 'Thor']);

    // Editar e excluir.
    const upd = await api('/pets/' + pet.id, { method: 'PATCH', body: { name: 'Mel', breed: 'Poodle toy', weight_kg: null } });
    assert.equal(upd.breed, 'Poodle toy'); assert.equal(upd.weight_kg, null);
    assert.equal(await del(pet.id), 204);
    assert.deepEqual((await api('/customers/' + cli.id + '/pets')).map(p => p.name), ['Thor']);
    assert.equal(await del(pet.id), 404);
  } finally { await f.cleanup(); }
});
