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

// Importação das planilhas de outro sistema (clientes.xls / animais.xls em HTML).
test('importação de outro sistema: clientes e animais, sem duplicar', {
  skip: process.env.TEST_DATABASE_URL ? false : 'Set TEST_DATABASE_URL', timeout: 90000
}, async () => {
  await import('../public/legacy-import.js'); const L = globalThis.FPLegacy;
  // Linhas de cliente sem <tr> de abertura, como no arquivo real.
  const clientes = `<html><table><tr><th>CdCliente</th><th>Nome</th><th>Nascimento</th><th>Email</th><th>CPF</th><th>Endereco</th><th>Numero</th><th>Complemento</th><th>Bairro</th><th>Cidade</th><th>Estado</th><th>CEP</th><th>DataCadastro</th><th>Telefone</th></tr>
<td>10</td><td>Klany Lopes</td><td>0000-00-00</td><td>KLANY@ME.COM</td><td>529.982.247-25</td><td>RUA LOURDES VIDAL</td><td>999</td><td></td><td>LAGOA REDONDA</td><td>fortaleza</td><td>ce</td><td>60.831-000</td><td>2022-11-05 08:58:11</td><td>5585997802475</td></tr>
<td>11</td><td>Amauri &amp; Cia</td><td>1980-02-30</td><td>sem-email</td><td>111.111.111-11</td><td></td><td></td><td></td><td></td><td></td><td></td><td>123</td><td>2022-11-06 10:00:00</td><td>85 8864-4736</td></tr></table>`;
  const animais = `<table><tr><th>CdAnimal</th><th>CdCliente</th><th>Nome</th><th>Especie</th><th>Raca</th><th>Sexo</th><th>Nascimento</th><th>Cor</th><th>Peso</th><th>Porte</th><th>IF(A.Pelagem='G','Longo',IF(A.Pelagem='P','Médio','Curto'))</th><th>Castrado</th><th>Obs</th><th>Planos</th><th>Vacina Raiva</th></tr>
<tr><td>1</td><td>10</td><td>Malfoy</td><td>CAO</td><td>Yorkshire</td><td>M</td><td>2016-05-24</td><td>Preto</td><td>7.00</td><td>P</td><td>Curto</td><td>Não</td><td>PRENHA</td><td>Pacote Nv2</td><td>2023-02-02</td></tr>
<tr><td>2</td><td>10</td><td>Amora</td><td>Gato</td><td></td><td>F</td><td>0000-00-00</td><td></td><td>0.00</td><td>Mi</td><td>Longo</td><td>Sim</td><td></td><td></td><td></td></tr>
<tr><td>3</td><td>99</td><td>Sem dono</td><td>Cão</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr></table>`;
  const customers = L.mapCustomers(L.parseTable(clientes)), pets = L.mapPets(L.parseTable(animais));
  assert.deepEqual(customers[0], { ext: '10', name: 'Klany Lopes', phone: '(85) 99780-2475', email: 'klany@me.com', cpf: '52998224725', birth: null, address: 'Rua Lourdes Vidal, 999 - Lagoa Redonda - Fortaleza/CE', cep: '60831000', created: '2022-11-05 08:58:11' });
  assert.equal(customers[1].name, 'Amauri & Cia'); assert.equal(customers[1].cpf, null); assert.equal(customers[1].email, null); assert.equal(customers[1].birth, null); assert.equal(customers[1].phone, '(85) 8864-4736');
  assert.equal(pets[0].species, 'Cão'); assert.equal(pets[0].size, 'Pequeno'); assert.equal(pets[0].coat, null); assert.equal(pets[0].neutered, false);
  assert.equal(pets[0].notes, 'PRENHA\nPlano: Pacote Nv2\nVacina Raiva: 02/02/2023');
  assert.equal(pets[1].weight, null); assert.equal(pets[1].size, 'Mini'); assert.equal(pets[1].coat, 'Longo'); assert.equal(pets[1].neutered, true);

  const f = await createStoreFixture(); const { api, request } = f;
  try {
    const operator = (await f.addOperator(f.tenant)).token;
    assert.equal((await request('/customers/import-legacy', { method: 'POST', body: { customers }, token: operator })).status, 403);
    assert.deepEqual(await api('/customers/import-legacy', { method: 'POST', body: { customers } }), { customers: 2, pets: 0, orphan_pets: 0 });
    assert.deepEqual(await api('/customers/import-legacy', { method: 'POST', body: { pets } }), { customers: 0, pets: 2, orphan_pets: 1 });
    // Repetir não duplica.
    assert.deepEqual(await api('/customers/import-legacy', { method: 'POST', body: { customers, pets } }), { customers: 0, pets: 0, orphan_pets: 1 });
    const list = await api('/customers');
    const klany = list.find(c => c.name === 'Klany Lopes');
    assert.equal(klany.source, 'importado'); assert.equal(klany.cpf, '52998224725'); assert.equal(klany.postal_code, '60831000');
    assert.deepEqual(klany.pets.map(p => p.name), ['Amora', 'Malfoy']);
    assert.equal(new Date(klany.created_at).toISOString(), '2022-11-05T11:58:11.000Z');
    // Outra loja importa o mesmo código sem conflito.
    assert.equal((await request('/customers/import-legacy', { method: 'POST', body: { customers }, token: f.foreignToken })).data.customers, 2);
    assert.equal((await request('/customers/import-legacy', { method: 'POST', body: { customers: [{ ext: '1', name: 'X', foo: 1 }] } })).status, 400);
  } finally { await f.cleanup(); }
});
