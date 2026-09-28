// Limpieza automatica de canales y filtro de palabras prohibidas.
// Aqui solo viven funciones sin estado del bot: index.js decide cuando llamarlas.

const AUTO_CLEAN_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 horas
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 - 60 * 1000; // limite de Discord, con margen
const MAX_WORD_LENGTH = 100;
const WORDS_HISTORY_LIMIT = 1000;

function createDefaultModeration() {
  return {
    // channelId -> { nextCleanAt }
    autoCleanChannels: {},
    watchChannelIds: [],
    wordsChannelId: null,
    bannedWords: []
  };
}

function ensureModerationState(guildConfig) {
  const base = createDefaultModeration();
  if (!guildConfig.moderation || typeof guildConfig.moderation !== 'object') {
    guildConfig.moderation = base;
  }
  const mod = guildConfig.moderation;
  if (!mod.autoCleanChannels || typeof mod.autoCleanChannels !== 'object') mod.autoCleanChannels = {};
  if (!Array.isArray(mod.watchChannelIds)) mod.watchChannelIds = [];
  if (mod.wordsChannelId === undefined) mod.wordsChannelId = null;
  if (!Array.isArray(mod.bannedWords)) mod.bannedWords = [];
  return mod;
}

// Minusculas y sin acentos, para que "Película" y "pelicula" cuenten igual.
function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Cada linea, coma o punto y coma de un mensaje es una palabra (o frase).
function parseWordList(content) {
  return String(content || '')
    .split(/[\n,;]+/)
    .map(normalizeText)
    .filter((word) => word && word.length <= MAX_WORD_LENGTH);
}

function mergeWords(existing, added) {
  const set = new Set(existing);
  let count = 0;
  for (const word of added) {
    if (!set.has(word)) {
      set.add(word);
      count++;
    }
  }
  return { words: [...set].sort(), added: count };
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Devuelve la primera palabra prohibida encontrada, o null.
// Coincide con palabras completas: "sal" no bloquea "salir".
function findBannedWord(content, bannedWords) {
  if (!bannedWords.length) return null;
  const text = normalizeText(content);
  if (!text) return null;
  for (const word of bannedWords) {
    const pattern = escapeRegex(word).replace(/ /g, '\\s+');
    const regex = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'u');
    if (regex.test(text)) return word;
  }
  return null;
}

// Relee todo el canal de palabras. Se usa al asignarlo y cuando se editan o
// borran mensajes, para que la lista refleje exactamente lo que hay en el canal.
async function collectWordsFromChannel(channel) {
  const words = new Set();
  let before;
  let fetched = 0;
  while (fetched < WORDS_HISTORY_LIMIT) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    for (const message of batch.values()) {
      if (message.author?.bot) continue;
      for (const word of parseWordList(message.content)) words.add(word);
    }
    fetched += batch.size;
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return [...words].sort();
}

// Borra todos los mensajes del canal excepto los de keepIds (paneles del bot).
// Recorre el historial hacia atras para no quedarse atascado en mensajes que
// no se pueden borrar.
async function cleanChannelCompletely(channel, keepIds = new Set()) {
  let before;
  let deleted = 0;
  let failed = 0;

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    before = batch.last().id;

    const targets = batch.filter((m) => !keepIds.has(m.id) && !m.pinned);
    const limit = Date.now() - BULK_DELETE_MAX_AGE_MS;
    const recent = targets.filter((m) => m.createdTimestamp > limit);
    const old = targets.filter((m) => m.createdTimestamp <= limit);

    if (recent.size > 1) {
      const removed = await channel.bulkDelete(recent, true).catch((error) => {
        console.error(`[auto-clean] bulkDelete fallido canal=${channel.id}: ${error.message}`);
        return null;
      });
      deleted += removed ? removed.size : 0;
      failed += removed ? recent.size - removed.size : recent.size;
    } else if (recent.size === 1) {
      if (await recent.first().delete().catch(() => null)) deleted++;
      else failed++;
    }

    for (const message of old.values()) {
      if (await message.delete().catch(() => null)) deleted++;
      else failed++;
    }

    if (batch.size < 100) break;
  }

  return { deleted, failed };
}

module.exports = {
  AUTO_CLEAN_INTERVAL_MS,
  ensureModerationState,
  parseWordList,
  mergeWords,
  findBannedWord,
  collectWordsFromChannel,
  cleanChannelCompletely
};
