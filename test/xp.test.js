// Prueba la lista y el buscador de XP sin Discord.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const xp = require('../src/xp');

const nuevoServidor = () => ({ xp: { channelId: null, items: null } });

test('la lista de partida tiene 35 productos sin repetir', () => {
  const nombres = xp.DEFAULT_XP_ITEMS.map((item) => item.name.toLowerCase());
  assert.equal(nombres.length, 35);
  assert.equal(new Set(nombres).size, nombres.length);
});

test('busca por nombre y muestra la XP', () => {
  const reply = xp.buildXpReply(xp.getXpItems(nuevoServidor()), 'mosquete');
  assert.match(reply, /Mosquete: \*\*90 XP\*\*/);
});

test('una palabra encuentra todos los que la llevan, tambien en plural y sin tildes', () => {
  const items = xp.getXpItems(nuevoServidor());
  const reply = xp.buildXpReply(items, 'revolveres');
  assert.match(reply, /\*\*3\*\* resultado/);
  assert.match(reply, /Revolver MK2: \*\*55 XP\*\*/);
  assert.match(xp.buildXpReply(items, 'tactico'), /Silenciador táctico/);
  assert.match(xp.buildXpReply(items, 'holografica'), /Mira holográfica: \*\*11 XP\*\*/);
});

test('con una errata ofrece lo mas parecido', () => {
  const reply = xp.buildXpReply(xp.getXpItems(nuevoServidor()), 'machette');
  assert.match(reply, /Lo más parecido/);
  assert.match(reply, /Machete: \*\*8 XP\*\*/);
});

test('el producto sin XP lo dice en vez de inventarla', () => {
  const reply = xp.buildXpReply(xp.getXpItems(nuevoServidor()), 'mk2 pistol');
  assert.match(reply, /MK2 Pistol: XP sin indicar/);
});

test('añadir un producto lo guarda en el servidor sin perder la lista', () => {
  const servidor = nuevoServidor();
  const result = xp.upsertXpItem(servidor, '  Rifle   de asalto ', 150);
  assert.equal(result.added, true);
  assert.equal(servidor.xp.items.length, 36);
  assert.deepEqual(result.item, { name: 'Rifle de asalto', xp: 150 });
  assert.match(xp.buildXpReply(xp.getXpItems(servidor), 'rifle de asalto'), /150 XP/);
  // La lista de partida no se toca.
  assert.equal(xp.DEFAULT_XP_ITEMS.length, 35);
});

test('añadir uno que ya esta le cambia la XP, aunque se escriba distinto', () => {
  const servidor = nuevoServidor();
  const result = xp.upsertXpItem(servidor, 'mk2 PISTOL', 45);
  assert.equal(result.added, false);
  assert.equal(result.previous, null);
  assert.equal(servidor.xp.items.length, 35);
  assert.equal(servidor.xp.items.find((item) => item.name === 'MK2 Pistol').xp, 45);
});

test('el nombre no admite formato de Discord', () => {
  const servidor = nuevoServidor();
  assert.equal(xp.upsertXpItem(servidor, '**Granada**', 10).item.name, 'Granada');
  assert.ok(xp.upsertXpItem(servidor, '***', 10).error);
});

test('quitar un producto, y si no existe sugiere el parecido', () => {
  const servidor = nuevoServidor();
  assert.equal(xp.removeXpItem(servidor, 'bate').removed.name, 'Bate');
  assert.equal(servidor.xp.items.length, 34);

  const fallo = xp.removeXpItem(nuevoServidor(), 'machette');
  assert.equal(fallo.removed, null);
  assert.deepEqual(fallo.similar, ['Machete']);
});

test('la lista completa sale ordenada y cabe en un mensaje', () => {
  const servidor = nuevoServidor();
  for (let i = 0; i < 200; i++) xp.upsertXpItem(servidor, `Producto de prueba ${i}`, i);
  const lista = xp.buildXpList(xp.getXpItems(servidor));
  assert.ok(lista.length < 2000);
  assert.match(lista, /más que no caben/);
  assert.ok(lista.startsWith('• .50'));
});
