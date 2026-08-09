const fs = require('fs');
const path = require('path');

// DATA_DIR permite guardar los datos FUERA de la carpeta del proyecto, para que
// reemplazar/reinstalar el bot no borre la base de datos.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_FILE = path.join(DATA_DIR, 'state.backup.json');
const TMP_FILE = path.join(DATA_DIR, 'state.tmp.json');

const BACKUP_MIN_INTERVAL_MS = 60 * 1000;

const defaultState = {
  guilds: {},
  tasks: {},
  reports: [],
  pendingEvidence: {},
  pendingPlantation: {}
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function normalizeState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('El estado guardado no es un objeto valido');
  }
  if (!state.guilds) state.guilds = {};
  if (!state.tasks) state.tasks = {};
  if (!state.reports) state.reports = [];
  if (!state.pendingEvidence) state.pendingEvidence = {};
  if (!state.pendingPlantation) state.pendingPlantation = {};
  return state;
}

// Devuelve el estado del archivo, o null si no existe / esta vacio.
// Lanza si el contenido existe pero esta corrupto.
function readCandidate(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return null;
  return normalizeState(JSON.parse(raw));
}

function quarantineFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(DATA_DIR, `state.corrupto-${stamp}.json`);
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

function readState() {
  ensureDataDir();

  try {
    const state = readCandidate(STATE_FILE);
    if (state) return state;
  } catch (error) {
    // El archivo principal esta corrupto. NUNCA lo descartamos en silencio:
    // primero intentamos el respaldo, y el corrupto se conserva para revisarlo.
    console.error(`[DATOS] state.json esta corrupto: ${error.message}`);

    let backup = null;
    try {
      backup = readCandidate(BACKUP_FILE);
    } catch (backupError) {
      console.error(`[DATOS] El respaldo tambien esta corrupto: ${backupError.message}`);
    }

    const quarantined = quarantineFile(STATE_FILE);
    if (quarantined) {
      console.error(`[DATOS] Archivo corrupto conservado en: ${quarantined}`);
    }

    if (backup) {
      console.error(`[DATOS] Restaurado desde el respaldo (${describeState(backup)}).`);
      return backup;
    }

    console.error('[DATOS] No habia respaldo utilizable. Se arranca con datos vacios.');
    return { ...defaultState };
  }

  // El principal no existe o esta vacio: puede ser instalacion nueva o un borrado.
  try {
    const backup = readCandidate(BACKUP_FILE);
    if (backup) {
      console.warn(
        `[DATOS] state.json no existe o esta vacio. Restaurado desde el respaldo (${describeState(backup)}).`
      );
      return backup;
    }
  } catch (error) {
    console.error(`[DATOS] El respaldo esta corrupto: ${error.message}`);
  }

  return { ...defaultState };
}

let lastBackupAt = 0;

function refreshBackup() {
  if (!fs.existsSync(STATE_FILE)) return;
  if (Date.now() - lastBackupAt < BACKUP_MIN_INTERVAL_MS) return;
  try {
    fs.copyFileSync(STATE_FILE, BACKUP_FILE);
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
