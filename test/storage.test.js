const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STORAGE_PATH = require.resolve('../src/storage');
let dataDir;

// Cada test parte de un modulo recien cargado, como si el bot arrancara de nuevo.
function loadStorage() {
  delete require.cache[STORAGE_PATH];
  return require(STORAGE_PATH);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-storage-'));
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('readState devuelve siempre la misma copia en memoria', () => {
  const { readState } = loadStorage();
  assert.equal(readState(), readState());
});

test('guardar desde un lector antiguo no pisa lo que guardo otro', () => {
  const { readState, writeState } = loadStorage();
  const slowReader = readState();

  const fastReader = readState();
  fastReader.timers.push({ id: 'nuevo' });
  writeState(fastReader);

  writeState(slowReader);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(onDisk.timers, [{ id: 'nuevo' }]);
});

test('los datos sobreviven a un reinicio', () => {
  const first = loadStorage();
  const state = first.readState();
  state.reports.push({ kind: 'prueba' });
  first.writeState(state);

  assert.deepEqual(loadStorage().readState().reports, [{ kind: 'prueba' }]);
});

test('un fallo de lectura no se queda en memoria como estado vacio', () => {
  const { readState } = loadStorage();
  // Una carpeta en lugar del archivo provoca un error de E/S, no de corrupcion.
  fs.mkdirSync(path.join(dataDir, 'state.json'));
  assert.throws(() => readState());

  fs.rmdirSync(path.join(dataDir, 'state.json'));
  fs.writeFileSync(
    path.join(dataDir, 'state.json'),
    JSON.stringify({ guilds: { g1: {} }, tasks: {}, reports: [] })
  );
  assert.deepEqual(Object.keys(readState().guilds), ['g1']);
});
