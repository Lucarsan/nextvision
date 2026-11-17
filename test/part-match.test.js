import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchParts, aliases, partKindFor } from '../src/part-match.js';

const list = JSON.parse(readFileSync(new URL('../scripts/data/elitech-telas-2026-11-17.json', import.meta.url), 'utf8'))
  .map((r, i) => ({ id: String(i), name: r.name, device_model: r.device_model, stock_qty: r.qty, price_cents: r.price * 100, cost_cents: r.cost * 100 }));
const exact = (model, service = 'Troca de tela') => matchParts(list, model, service).filter(p => p.match === 'exact').map(p => p.name + ' · ' + p.device_model);
const any = (model, service = 'Troca de tela') => matchParts(list, model, service).map(p => p.name + ' · ' + p.device_model);

test('aparelhos de uma peça herdam a marca', () => {
  assert.deepEqual(aliases('Realme C51/C53/Note 50').map(a => a.full), ['realmec51', 'realmec53', 'realmenote50']);
  assert.deepEqual(aliases('Redmi Note 13 4G/Poco M7 Pro').map(a => a.full), ['redminote134g', 'pocom7pro']);
  assert.deepEqual(aliases('Samsung A02/A12').map(a => a.core), ['a02', 'a12']);
});

test('tela certa pelo aparelho digitado (lista da ELITECH)', () => {
  assert.deepEqual(exact('A12'), ['Tela · Samsung A02/A12']);
  assert.deepEqual(exact('Galaxy A12'), ['Tela · Samsung A02/A12']);
  assert.deepEqual(exact('samsung a03'), ['Tela · Samsung A02S/A03S/A03/A04E']);
  assert.deepEqual(exact('A03 core'), ['Tela · Samsung A03 Core']);
  assert.deepEqual(exact('Note 8'), ['Tela · Redmi Note 8']);
  assert.deepEqual(exact('Xiaomi Redmi Note 8'), ['Tela · Redmi Note 8']);
  assert.deepEqual(exact('Redmi 12'), ['Tela · Redmi 12'], 'Redmi 12 não é Redmi Note 12');
  assert.deepEqual(exact('Note 12'), ['Tela · Redmi Note 12']);
  assert.deepEqual(exact('iPhone 11'), ['Tela · iPhone 11']);
  assert.deepEqual(exact('IP 11'), ['Tela · iPhone 11']);
  assert.deepEqual(exact('Apple 11'), ['Tela · iPhone 11']);
  assert.deepEqual(exact('iPhone 12'), [], 'iPhone 12 não acha Redmi 12');
  assert.deepEqual(exact('Moto E7 Power'), ['Tela · Moto E7/E7 Power/E7i Power']);
  assert.deepEqual(exact('Motorola G9 Play'), ['Tela sem aro · Moto E7 Plus/G9 Play']);
  assert.deepEqual(exact('G9 Power').sort(), ['Tela com aro · Moto G9 Power', 'Tela sem aro · Moto G9 Power'], 'com aro e sem aro: escolher');
  assert.deepEqual(exact('G14').length, 2, 'G14 está em duas linhas da lista');
  assert.deepEqual(exact('Poco M7 Pro'), ['Tela · Redmi Note 13 4G/Poco M7 Pro']);
  assert.deepEqual(exact('Note 13 Pro'), ['Tela · Redmi Note 14/Note 13 Pro']);
  assert.deepEqual(exact('Realme Note 50'), ['Tela · Realme C51/C53/Note 50']);
  assert.deepEqual(exact('not 60x'), ['Tela · Realme Note 60X']);
  assert.deepEqual(exact('Hot 50'), ['Tela · Tecno Spark 30/Infinix Hot 50']);
  assert.deepEqual(exact('A20'), ['Tela com aro · Samsung A20']);
  assert.deepEqual(any('A14').sort(), ['Tela · Samsung A14 4G', 'Tela · Samsung A14 5G'], 'A14 sem 4G/5G: as duas como parecidas');
  assert.deepEqual(exact('A32'), []); assert.deepEqual(any('A32'), ['Tela com aro · Samsung A32 4G']);
  assert.deepEqual(exact('A05S'), ['Tela · Samsung A05S']); assert.deepEqual(exact('A05'), ['Tela · Samsung A05']);
  assert.deepEqual(any('A1'), [], 'curto demais para sugerir');
});

test('o serviço decide o tipo de peça', () => {
  assert.equal(partKindFor('Troca de tela'), 'tela'); assert.equal(partKindFor('troca do display'), 'tela'); assert.equal(partKindFor(''), '');
  assert.equal(partKindFor('Formatação'), null);
  assert.deepEqual(exact('A12', ''), ['Tela · Samsung A02/A12'], 'serviço vazio: sugere');
  assert.deepEqual(exact('A12', 'Troca de conector de carga'), [], 'conector não é tela');
});

test('aparelho escolhido com "/" nas sugestões', () => {
  assert.deepEqual(exact('Samsung A02/A12'), ['Tela · Samsung A02/A12']);
  assert.deepEqual(exact('Moto E7/E7 Power/E7i Power'), ['Tela · Moto E7/E7 Power/E7i Power']);
});
