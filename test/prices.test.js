const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const prices = require('../src/prices');

// Copia real de la hoja de precios.
const TABS = ['Armas', 'Droga', 'Blanqueo', 'Otros'];
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', `precios-${name}.csv`), 'utf8');
const items = TABS.flatMap((tab) => prices.parseTab(tab, fixture(tab)));

const byName = (name, type) =>
  items.filter((item) => item.name === name && (!type || item.type === type));

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

test('lee todas las tablas puestas lado a lado y unas debajo de otras', () => {
  const types = new Set(items.map((item) => item.type));
  for (const type of [
    'Armamento', 'Municion', 'Melees', 'Accesorios', 'Reparacion Armas', 'Complementos',
    'General Droga', 'Blanqueo', 'Otros', 'Radios'
  ]) {
    assert.ok(types.has(type), `falta la tabla ${type}`);
  }
});

test('un articulo con requisitos tiene precio y a quien se vende', () => {
  const [item] = byName('Chaleco Pesado');
  assert.equal(item.type, 'Complementos');
  assert.deepEqual(item.prices, [{ label: 'PRECIO MIN', value: '$40.000' }]);
  assert.deepEqual(item.requirements, [
    { label: 'BANDAS -3 MESES', value: '✅' },
    { label: 'PDB', value: '❌' },
    { label: 'CIVILES', value: '❌' }
  ]);
});

test('no toma separadores ni titulos de columna como articulos', () => {
  assert.ok(!items.some((item) => /^[-\s]+$/.test(item.name)));
  assert.ok(!items.some((item) => /^precio/i.test(item.name)));
  assert.ok(!items.some((item) => item.name === 'MELEES'));
});

test('conserva los textos de la columna de precio', () => {
  assert.equal(byName('Chromium')[0].prices[0].value, 'No se vende ni se negocia');
  assert.equal(byName('Cargador de tambor de SMG')[0].prices[0].value, 'No se vende de momento');
});

test('una tabla con dos columnas de precio no se parte en dos', () => {
  const [item] = byName('Amplificadores');
  assert.equal(item.type, 'Radios');
  assert.deepEqual(item.prices, [
    { label: 'PRECIO MIN en blanco', value: '$40.000' },
    { label: 'PRECIO MIN en negro', value: '$70.000' }
  ]);
  assert.equal(items.filter((i) => i.name === '$40.000').length, 0);
});

test('los precios por grupo de Droga se muestran como requisito', () => {
  const [item] = byName('Cabina Mediana');
  assert.deepEqual(item.requirements, [
    { label: 'BANDAS -3 MESES', value: '$11.000.000' },
    { label: 'PDB', value: '❌' },
    { label: 'CIVILES', value: '❌' }
  ]);
});

test('Blanqueo guarda el porcentaje y Otros la observacion', () => {
  assert.deepEqual(byName('Civiles')[0].prices, [{ label: '% MAX', value: '30%' }]);
  assert.deepEqual(byName('Civiles')[0].notes, ['Preguntar Matrix casos especificos']);
  assert.deepEqual(byName('Negocios de territorios')[0].notes, ['Para otras consultas mediante ticket.']);
});

test('la busqueda ignora mayusculas y acentos y acepta parte del nombre', () => {
  const names = (query) => prices.searchItems(items, query).map((item) => item.name);
  assert.deepEqual(names('CHALECO'), ['Chaleco Ligero', 'Chaleco Pesado']);
  assert.deepEqual(names('cañon'), ['Cañon de Pistola']);
  assert.deepEqual(names('canon'), ['Cañon de Pistola']);
  assert.ok(names('revolver').length >= 5);
  assert.deepEqual(names('no existe esto'), []);
});

test('acepta varias palabras en cualquier orden y busca por tipo', () => {
  const found = prices.searchItems(items, 'pesado chaleco');
  assert.deepEqual(found.map((item) => item.name), ['Chaleco Pesado']);
  assert.ok(prices.searchItems(items, 'municion').some((item) => item.name === '.38'));
});

test('el nombre exacto sale primero', () => {
  assert.equal(prices.searchItems(items, 'revolver')[0].name, 'Revolver');
});

test('la respuesta incluye nombre, tipo, precio y requisito', () => {
  const reply = prices.buildSearchReply(items, 'chaleco pesado');
  assert.match(reply, /\*\*Chaleco Pesado\*\*/);
  assert.match(reply, /Tipo: Complementos/);
  assert.match(reply, /Precio Min: \$40\.000/);
  assert.match(reply, /Requisito: Bandas -3 Meses: ✅ · PDB: ❌ · Civiles: ❌/);
});

test('sin columnas de requisito lo dice en vez de inventarlo', () => {
  assert.match(prices.buildSearchReply(items, 'molotov'), /Requisito: no indicado/);
});

test('con muchos resultados limita la respuesta al tamaño de Discord', () => {
  const reply = prices.buildSearchReply(items, 'armamento');
  assert.ok(reply.length <= 2000, `mide ${reply.length}`);
  assert.match(reply, /Escribe algo más concreto/);
});

test('el texto del usuario no puede meter formato en la respuesta', () => {
  const reply = prices.buildSearchReply(items, '**`hola`**\nmundo');
  assert.ok(reply.includes('**hola mundo**'));
  assert.ok(!reply.includes('`hola`'));
});

test('solo acepta enlaces de hojas de Google', () => {
  const id = '1eD_fIl9ZNro39KosscPvIjpbbjw1cMwL78ma-te3e8U';
  assert.equal(prices.parseSheetId(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=0#gid=0`), id);
  assert.equal(prices.parseSheetId(`https://docs.google.com/spreadsheets/d/${id}`), id);
  assert.equal(prices.parseSheetId(`https://malo.example/spreadsheets/d/${id}/edit`), null);
  assert.equal(prices.parseSheetId(`http://docs.google.com/spreadsheets/d/${id}`), null);
  assert.equal(prices.parseSheetId('hola'), null);
});

test('reconoce las pestañas de la vista publica sin repetirlas', () => {
  const html =
    'items.push({name: "Armas", pageUrl: "https:\\/\\/docs.google.com\\/x\\/htmlview?gid=0"});' +
    'items.push({name: "Droga", pageUrl: "https:\\/\\/docs.google.com\\/x\\/htmlview?gid\\x3d863401247"});' +
    'items.push({name: "Armas", pageUrl: "https:\\/\\/docs.google.com\\/x\\/htmlview?gid=0"});';
  assert.deepEqual(prices.parseTabList(html), [
    { name: 'Armas', gid: '0' },
    { name: 'Droga', gid: '863401247' }
  ]);
});

function fakeGoogle(sheet) {
  global.fetch = async (url) => {
    if (sheet.fail) return { ok: false, status: 503, text: async () => '' };
    return {
      ok: true,
      text: async () =>
        url.includes('htmlview') ? 'name: "Otros", pageUrl: "https:\\/\\/x?gid=7"' : sheet.csv
    };
  };
}

test('si Google falla se sigue usando la ultima version y se anota el error', async () => {
  const sheet = { csv: ',OTROS,PRECIO MIN\n,Gancho,"$15.000,00"\n' };
  fakeGoogle(sheet);
  await prices.refreshCatalog('hoja-que-falla');
  assert.equal((await prices.getItems('hoja-que-falla'))[0].name, 'Gancho');

  sheet.fail = true;
  await prices.refreshCatalog('hoja-que-falla');
  assert.equal((await prices.getItems('hoja-que-falla'))[0].name, 'Gancho');
  assert.match(prices.getCatalogStatus('hoja-que-falla').lastError, /503/);
});

test('los cambios de la hoja entran al releerla', async () => {
  const sheet = { csv: ',OTROS,PRECIO MIN\n,Gancho,"$15.000,00"\n' };
  fakeGoogle(sheet);
  await prices.refreshCatalog('hoja-que-cambia');

  sheet.csv = ',OTROS,PRECIO MIN\n,Gancho,"$20.000,00"\n';
  await prices.refreshCatalog('hoja-que-cambia');
  const [item] = await prices.getItems('hoja-que-cambia');
  assert.equal(item.prices[0].value, '$20.000');
});

test('una hoja sin tablas reconocibles cuenta como error', async () => {
  fakeGoogle({ csv: 'nada,que,ver\n' });
  await prices.refreshCatalog('hoja-vacia');
  assert.match(prices.getCatalogStatus('hoja-vacia').lastError, /ninguna tabla/);
});
