const fs = require('fs');
const path = require('path');

// DATA_DIR permite guardar los datos FUERA de la carpeta del proyecto, para que
// reemplazar/reinstalar el bot no borre la base de datos.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');

// Ubicacion por defecto, dentro del proyecto. Sirve para migrar solo.
const LEGACY_DATA_DIR = path.join(process.cwd(), 'data');
const USING_CUSTOM_DIR = path.resolve(DATA_DIR) !== path.resolve(LEGACY_DATA_DIR);

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_FILE = path.join(DATA_DIR, 'state.backup.json');
const TMP_FILE = path.join(DATA_DIR, 'state.tmp.json');
const BACKUP_TMP_FILE = path.join(DATA_DIR, 'state.backup.tmp.json');

const BACKUP_MIN_INTERVAL_MS = 60 * 1000;
const READ_ATTEMPTS = 5;
const READ_RETRY_MS = 50;

// Cada llamada devuelve objetos nuevos: nunca se comparte una instancia entre
// estados, porque los handlers mutan el estado que reciben.
function createDefaultState() {
  return {
    guilds: {},
    tasks: {},
    reports: [],
    pendingEvidence: {},
    pendingPlantation: {},
    // CDs sueltos creados con /cd desde cualquier canal.
    timers: []
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

class CorruptStateError extends Error {}

function normalizeState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new CorruptStateError('El estado guardado no es un objeto valido');
  }
  const base = createDefaultState();
  for (const [key, value] of Object.entries(base)) {
    if (!state[key]) state[key] = value;
  }
  return state;
}

// Solo estos errores significan "el contenido esta dañado". Un fallo de E/S
// (archivo bloqueado, permisos) NO es corrupcion y no debe tocar nada.
function isCorruptionError(error) {
  return error instanceof SyntaxError || error instanceof CorruptStateError;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Los bloqueos de archivo en Windows (antivirus, indexador) suelen durar
// milisegundos: reintentamos antes de dar el fallo por definitivo.
function readFileWithRetry(file) {
  let lastError;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      lastError = error;
      sleepSync(READ_RETRY_MS);
    }
  }
  throw lastError;
}

// Devuelve el estado del archivo, o null si no existe / esta vacio.
// Lanza CorruptStateError o SyntaxError si el contenido esta dañado,
// y el error de E/S original si no se pudo leer.
function readCandidate(file) {
  if (!fs.existsSync(file)) return null;
  const raw = readFileWithRetry(file);
  if (!raw.trim()) return null;
  return normalizeState(JSON.parse(raw));
}

function quarantineFile(file, tag) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(DATA_DIR, `state.corrupto-${tag}-${stamp}.json`);
  try {
    fs.renameSync(file, target);
    return target;
  } catch {
    return null;
  }
}

function describeState(state) {
  const guilds = Object.keys(state.guilds || {}).length;
  const reports = (state.reports || []).length;
  return `${guilds} servidor(es), ${reports} reporte(s)`;
}

// Lee el respaldo. Si esta dañado lo aparta, porque si no el siguiente
// refreshBackup lo sobrescribe y perdemos la ultima copia recuperable.
function readBackupOrQuarantine() {
  try {
    return readCandidate(BACKUP_FILE);
  } catch (error) {
    if (isCorruptionError(error)) {
      const moved = quarantineFile(BACKUP_FILE, 'respaldo');
      console.error(
        `[DATOS] El respaldo tambien esta dañado: ${error.message}` +
        (moved ? ` (conservado en ${moved})` : '')
      );
    } else {
      console.error(`[DATOS] No se pudo leer el respaldo: ${error.message}`);
    }
    return null;
  }
}

function readState() {
  ensureDataDir();

  let mainState = null;
  try {
    mainState = readCandidate(STATE_FILE);
  } catch (error) {
    if (!isCorruptionError(error)) {
      // Fallo de E/S, no corrupcion. Preferimos fallar de forma ruidosa antes
      // que devolver un estado vacio que la siguiente escritura haria permanente.
      console.error(
        `[DATOS] No se pudo leer state.json tras ${READ_ATTEMPTS} intentos ` +
        `(${error.code || error.message}). No se modifica ningun archivo.`
      );
      throw error;
    }

    // Corrupcion real: intentamos el respaldo y conservamos el archivo dañado.
    console.error(`[DATOS] state.json esta corrupto: ${error.message}`);
    const backup = readBackupOrQuarantine();
    const quarantined = quarantineFile(STATE_FILE, 'principal');
    if (quarantined) {
      console.error(`[DATOS] Archivo corrupto conservado en: ${quarantined}`);
    } else {
      console.error('[DATOS] No se pudo apartar el archivo corrupto (¿bloqueado?).');
    }

    if (backup) {
      console.error(`[DATOS] Restaurado desde el respaldo (${describeState(backup)}).`);
      return backup;
    }

    console.error('[DATOS] No habia respaldo utilizable. Se arranca con datos vacios.');
    return createDefaultState();
  }

  if (mainState) return mainState;

  // El principal no existe o esta vacio: instalacion nueva o borrado.
  const backup = readBackupOrQuarantine();
  if (backup) {
    console.warn(
      `[DATOS] state.json no existe o esta vacio. Restaurado desde el respaldo (${describeState(backup)}).`
    );
    return backup;
  }

  // Migracion: si acaban de configurar DATA_DIR y la carpeta nueva esta
  // vacia, adoptamos los datos que vivian dentro del proyecto. Sin esto, el
  // bot arrancaria en blanco y se perderian paneles, cooldowns y historial.
  const migrated = adoptLegacyState();
  if (migrated) return migrated;

  return createDefaultState();
}

function adoptLegacyState() {
  if (!USING_CUSTOM_DIR) return null;

  const legacyFile = path.join(LEGACY_DATA_DIR, 'state.json');
  let legacy = null;
  try {
    legacy = readCandidate(legacyFile);
  } catch (error) {
    console.error(`[DATOS] Habia datos antiguos en ${legacyFile} pero no se pudieron leer: ${error.message}`);
    return null;
  }
  if (!legacy) return null;

  const guilds = Object.keys(legacy.guilds || {}).length;
  const reports = (legacy.reports || []).length;
  if (!guilds && !reports) return null; // estaba vacio: nada que migrar

  console.warn(
    `[DATOS] DATA_DIR es nuevo y esta vacio. Se adoptan los datos previos de ${legacyFile} ` +
    `(${describeState(legacy)}). El archivo antiguo se conserva intacto.`
  );
  return legacy;
}

let lastBackupAt = 0;

// Respalda la version en disco solo si es valida, y de forma atomica.
function refreshBackup() {
  if (Date.now() - lastBackupAt < BACKUP_MIN_INTERVAL_MS) return;

  let current;
  try {
    current = readCandidate(STATE_FILE);
  } catch (error) {
    console.error(
      `[DATOS] No se actualiza el respaldo: state.json no es legible o valido (${error.message}).`
    );
    return;
  }
  if (!current) return;

  try {
    fs.writeFileSync(BACKUP_TMP_FILE, JSON.stringify(current, null, 2), 'utf8');
    fs.renameSync(BACKUP_TMP_FILE, BACKUP_FILE);
    lastBackupAt = Date.now();
  } catch (error) {
    console.error(`[DATOS] No se pudo actualizar el respaldo: ${error.message}`);
  }
}

function writeState(state) {
  ensureDataDir();
  normalizeState(state);

  // Respaldamos la version anterior (buena) antes de sustituirla.
  refreshBackup();

  // Escritura atomica: si el proceso muere a medias, state.json sigue intacto
  // porque el archivo temporal es el unico que queda incompleto.
  const payload = JSON.stringify(state, null, 2);
  fs.writeFileSync(TMP_FILE, payload, 'utf8');
  fs.renameSync(TMP_FILE, STATE_FILE);
}

function getStorageInfo() {
  return { dataDir: DATA_DIR, stateFile: STATE_FILE, backupFile: BACKUP_FILE };
}

module.exports = {
  readState,
  writeState,
  getStorageInfo
};
