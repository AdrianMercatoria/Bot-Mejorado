// Buscador de XP: cuanta experiencia da cada producto.
//
// La lista vive en el estado de cada servidor y los administradores la amplian
// con /xp_agregar. Mientras nadie la toque se usa la lista de partida.

const prices = require('./prices');

const MAX_NAME_LENGTH = 60;
const MAX_XP = 100000;
const LIST_LIMIT = 1900;

// xp null = la lista de partida no lo dice.
const DEFAULT_XP_ITEMS = [
  { name: 'Mosquete', xp: 90 },
  { name: '.50', xp: 60 },
  { name: 'Placas x3', xp: 25 },
  { name: 'Silenciador táctico', xp: 30 },
  { name: 'Silenciador de pistola', xp: 20 },
  { name: 'Cargador ampliado de pistola', xp: 12 },
  { name: 'Chaleco pesado', xp: 40 },
  { name: 'Empuñadura', xp: 10 },
  { name: 'Martillo', xp: 5 },
  { name: 'Mira holográfica', xp: 11 },
  { name: 'Cargador ampliado de escopeta', xp: 10 },
  { name: 'Bate', xp: 5 },
  { name: 'AP', xp: 70 },
  { name: 'Heavy Pistol', xp: 50 },
  { name: 'Revolver MK2', xp: 55 },
  { name: 'Revolver', xp: 40 },
  { name: 'Revolver Double Action', xp: 40 },
  { name: 'Bullpup Shotgun', xp: 80 },
  { name: 'Sweeper Shotgun', xp: 100 },
  { name: 'Revo Navy', xp: 50 },
  { name: 'Palanca', xp: 35 },
  { name: 'Double Barrel Shotgun', xp: 120 },
  { name: 'WM', xp: 40 },
  { name: 'Cargador ampliado de subfusil', xp: 3 },
  { name: 'Pistol 9mm', xp: 25 },
  { name: 'Piedra de afilar', xp: 15 },
  { name: 'MK2 Pistol', xp: null },
  { name: 'Machete', xp: 8 },
  { name: 'Llave inglesa', xp: 5 },
  { name: 'Palo de billar', xp: 5 },
  { name: 'Botella rota', xp: 5 },
  { name: 'Vintaje', xp: 20 },
  { name: 'Cerámica', xp: 15 },
  { name: 'Cargador de tambor de rifle', xp: 3 },
  { name: 'Cargador de tambor de subfusil', xp: 3 }
];

function cleanName(name) {
  return String(name).replace(/[`*_~|>\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

// La lista del servidor, o la de partida si nadie la ha cambiado.
function getXpItems(guildConfig) {
  const list = Array.isArray(guildConfig.xp?.items) ? guildConfig.xp.items : DEFAULT_XP_ITEMS;
  // El buscador de precios tambien mira el tipo: aqui no hay.
  return list.map((item) => ({ name: item.name, xp: item.xp, type: '' }));
}

function findIndex(list, name) {
  const key = prices.normalizeText(name);
  return list.findIndex((item) => prices.normalizeText(item.name) === key);
}

// A partir del primer cambio el servidor guarda su propia copia de la lista.
function editableList(guildConfig) {
  if (!Array.isArray(guildConfig.xp.items)) {
    guildConfig.xp.items = DEFAULT_XP_ITEMS.map((item) => ({ ...item }));
  }
  return guildConfig.xp.items;
}

// Añade un producto o, si ya existe con ese nombre, le cambia la XP.
function upsertXpItem(guildConfig, rawName, xp) {
  const name = cleanName(rawName);
  if (!name) return { error: 'Escribe el nombre del producto.' };
  const list = editableList(guildConfig);
  const index = findIndex(list, name);
  if (index === -1) {
    list.push({ name, xp });
    return { added: true, item: list[list.length - 1] };
  }
  const previous = list[index].xp;
  list[index].xp = xp;
  return { added: false, previous, item: list[index] };
}

function removeXpItem(guildConfig, rawName) {
  const list = getXpItems(guildConfig);
  const index = findIndex(list, cleanName(rawName));
  if (index === -1) {
    const similar = prices.findSimilarItems(list, rawName).map((item) => item.name);
    return { removed: null, similar };
  }
  const [removed] = editableList(guildConfig).splice(index, 1);
  return { removed, similar: [] };
}

function formatXp(xp) {
  return xp === null || xp === undefined ? 'XP sin indicar' : `**${xp} XP**`;
}

function formatXpItem(item) {
  return `• ${item.name}: ${formatXp(item.xp)}`;
}

function buildXpReply(items, query) {
  return prices.buildSearchReply(items, query, {
    format: formatXpItem,
    separator: '\n',
    example: '`revolver` o `cargador`'
  });
}

// La lista entera, ordenada por nombre, cortada si no cabe en un mensaje.
function buildXpList(items) {
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const lines = [];
  let length = 0;
  for (const item of sorted) {
    const line = formatXpItem(item);
    if (length + line.length + 1 > LIST_LIMIT) break;
    lines.push(line);
    length += line.length + 1;
  }
  const hidden = sorted.length - lines.length;
  return lines.join('\n') + (hidden > 0 ? `\n_Y ${hidden} más que no caben aquí._` : '');
}

module.exports = {
  DEFAULT_XP_ITEMS,
  MAX_NAME_LENGTH,
  MAX_XP,
  getXpItems,
  upsertXpItem,
  removeXpItem,
  formatXp,
  buildXpReply,
  buildXpList
};
