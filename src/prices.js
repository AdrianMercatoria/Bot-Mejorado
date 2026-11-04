// Buscador de precios: lee una hoja publica de Google Sheets y responde a las
// busquedas del canal asignado. Solo hace falta que la hoja este compartida como
// "cualquier persona con el enlace puede ver".
//
// La hoja no es una tabla unica: cada pestaña tiene varias tablas puestas lado a
// lado y unas debajo de otras. Por eso se detectan por su cabecera en vez de
// esperar columnas fijas, y cambiar precios o agregar filas no requiere tocar nada.

const DEFAULT_SHEET_ID = '1eD_fIl9ZNro39KosscPvIjpbbjw1cMwL78ma-te3e8U';
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const RELOAD_RETRY_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_RESULTS = 10;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 60;
const DISCORD_MESSAGE_LIMIT = 2000;

const PRICE_HEADER = /^(precio|% ?max)/i;
const NOTE_HEADER = /^observ/i;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function cellAt(rows, rowIndex, column) {
  return (rows[rowIndex]?.[column] || '').trim();
}

// Una tabla empieza por su titulo seguido de una columna de precio. El titulo no
// puede ser otra columna de precio: RADIOS tiene dos seguidas (en blanco y en negro).
function isHeaderAt(rows, rowIndex, column) {
  const title = cellAt(rows, rowIndex, column);
  return Boolean(title) && !PRICE_HEADER.test(title) && PRICE_HEADER.test(cellAt(rows, rowIndex, column + 1));
}

function isSeparator(value) {
  return /^[-\s]+$/.test(value);
}

// "$15.000,00" -> "$15.000" y "30,00%" -> "30%". Los textos quedan igual.
function formatValue(value) {
  return value.replace(/,00(?=%?$)/, '');
}

function titleCase(text) {
  return text.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, space, letter) => space + letter.toUpperCase());
}

// Convierte una pestaña en articulos { name, type, tab, prices, requirements, notes }.
function parseTab(tabName, csvText) {
  const rows = parseCsv(csvText);
  const items = [];

  rows.forEach((row, headerRow) => {
    row.forEach((_, column) => {
      if (!isHeaderAt(rows, headerRow, column)) return;

      const type = titleCase(cellAt(rows, headerRow, column));
      const columns = [];
      for (let c = column + 1; cellAt(rows, headerRow, c); c++) {
        columns.push({ index: c, label: cellAt(rows, headerRow, c) });
      }

      for (let r = headerRow + 1; r < rows.length; r++) {
        // La siguiente tabla de esta misma columna empieza donde esta termina.
        if (isHeaderAt(rows, r, column)) break;
        const name = cellAt(rows, r, column);
        if (!name || isSeparator(name)) continue;

        const item = { name, type, tab: tabName, prices: [], requirements: [], notes: [] };
        for (const { index, label } of columns) {
          const value = cellAt(rows, r, index);
          if (!value || isSeparator(value)) continue;
          if (PRICE_HEADER.test(label)) item.prices.push({ label, value: formatValue(value) });
          else if (NOTE_HEADER.test(label)) item.notes.push(value);
          else item.requirements.push({ label, value: formatValue(value) });
        }
        items.push(item);
      }
    });
  });

  return items;
}

function normalizeText(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function matchScore(item, normalizedQuery, words) {
  const name = normalizeText(item.name);
  const haystack = `${name} ${normalizeText(item.type)}`;
  if (!words.every((word) => haystack.includes(word))) return 0;
  if (name === normalizedQuery) return 4;
  if (name.startsWith(normalizedQuery)) return 3;
  if (words.every((word) => name.includes(word))) return 2;
  return 1; // Coincide por el tipo: "municion" lista toda la municion.
}

function searchItems(items, query) {
  const normalizedQuery = normalizeText(query);
  const words = normalizedQuery.split(' ').filter(Boolean);
  if (!words.length) return [];
  return items
    .map((item) => ({ item, score: matchScore(item, normalizedQuery, words) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

// Devuelve el id de la hoja a partir de su enlace, o null si no es una hoja de Google.
function parseSheetId(url) {
  const match = String(url).trim().match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]{20,})(?:[/?#]|$)/);
  return match ? match[1] : null;
}

function sheetUrl(sheetId) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Google respondio HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// La vista publica de la hoja lista sus pestañas, asi que una pestaña nueva entra sola.
function parseTabList(html) {
  const tabs = [];
  for (const [, name, gid] of html.matchAll(/name: "([^"]+)", pageUrl: "[^"]*?gid(?:=|\\x3d)(\d+)/g)) {
    if (!tabs.some((tab) => tab.gid === gid)) tabs.push({ name, gid });
  }
  return tabs;
}

async function fetchCatalog(sheetId) {
  const base = `https://docs.google.com/spreadsheets/d/${sheetId}`;
  const tabs = parseTabList(await fetchText(`${base}/htmlview`));
  if (!tabs.length) throw new Error('No se encontraron pestañas: ¿la hoja es publica?');

  const items = [];
  for (const tab of tabs) {
    // export conserva los textos de las columnas numericas ("No se vende de momento").
    items.push(...parseTab(tab.name, await fetchText(`${base}/export?format=csv&gid=${tab.gid}`)));
  }
  if (!items.length) throw new Error('La hoja no tiene ninguna tabla reconocible');
  return items;
}

// Ultima version buena de cada hoja. Si Google falla, se sigue respondiendo con ella.
const catalogs = new Map();

function getCatalogEntry(sheetId) {
  if (!catalogs.has(sheetId)) {
    catalogs.set(sheetId, { items: null, loadedAt: 0, lastAttemptAt: 0, lastError: null, loading: null });
  }
  return catalogs.get(sheetId);
}

function refreshCatalog(sheetId) {
  const entry = getCatalogEntry(sheetId);
  if (entry.loading) return entry.loading;

  entry.lastAttemptAt = Date.now();
  entry.loading = fetchCatalog(sheetId)
    .then((items) => {
      entry.items = items;
      entry.loadedAt = Date.now();
      entry.lastError = null;
    })
    .catch((error) => {
      entry.lastError = error.message;
      console.error(`[precios] No se pudo leer la hoja ${sheetId}: ${error.message}`);
    })
    .finally(() => {
      entry.loading = null;
    });
  return entry.loading;
}

// Si nunca se pudo cargar, una busqueda reintenta, sin insistir mas de una vez cada 30 s.
async function getItems(sheetId) {
  const entry = getCatalogEntry(sheetId);
  if (entry.loading) await entry.loading;
  if (!entry.items && Date.now() - entry.lastAttemptAt >= RELOAD_RETRY_MS) await refreshCatalog(sheetId);
  return entry.items;
}

function getCatalogStatus(sheetId) {
  const { items, loadedAt, lastError } = getCatalogEntry(sheetId);
  return { count: items ? items.length : 0, loadedAt, lastError };
}

function formatPairs(pairs) {
  // Las siglas cortas como PDB se dejan tal cual.
  return pairs
    .map(({ label, value }) => `${label.length <= 3 ? label : titleCase(label)}: ${value}`)
    .join(' · ');
}

function formatItem(item) {
  const lines = [`**${item.name}**`, `Tipo: ${item.type}`];
  if (item.prices.length) lines.push(formatPairs(item.prices));
  lines.push(`Requisito: ${item.requirements.length ? formatPairs(item.requirements) : 'no indicado'}`);
  if (item.notes.length) lines.push(`Nota: ${item.notes.join(' · ')}`);
  return lines.join('\n');
}

// El texto del usuario se muestra de vuelta: sin formato ni saltos de linea.
function sanitizeQuery(query) {
  return String(query).replace(/[`*_~|>\\]/g, '').replace(/\s+/g, ' ').trim();
}

function buildSearchReply(items, query) {
  const shown = sanitizeQuery(query);
  const results = searchItems(items, query);
  if (!results.length) {
    return `🔎 No encontré nada para **${shown}**. Prueba con otra palabra, por ejemplo \`chaleco\` o \`9mm\`.`;
  }

  const header = `🔎 **${results.length}** resultado(s) para **${shown}**`;
  const blocks = [];
  let length = header.length;
  for (const item of results.slice(0, MAX_RESULTS)) {
    const block = formatItem(item);
    // Se reserva sitio para el aviso de resultados ocultos.
    if (length + block.length + 2 > DISCORD_MESSAGE_LIMIT - 100) break;
    blocks.push(block);
    length += block.length + 2;
  }

  const hidden = results.length - blocks.length;
  const footer = hidden > 0 ? `\n\n_Y ${hidden} más. Escribe algo más concreto para verlos._` : '';
  return `${header}\n\n${blocks.join('\n\n')}${footer}`;
}

module.exports = {
  DEFAULT_SHEET_ID,
  REFRESH_INTERVAL_MS,
  MIN_QUERY_LENGTH,
  MAX_QUERY_LENGTH,
  parseCsv,
  parseTab,
  parseTabList,
  parseSheetId,
  sheetUrl,
  searchItems,
  refreshCatalog,
  getItems,
  getCatalogStatus,
  formatItem,
  buildSearchReply
};
