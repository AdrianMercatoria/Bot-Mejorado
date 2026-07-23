const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const defaultState = {
  guilds: {},
  tasks: {},
  reports: [],
  pendingEvidence: {},
  pendingPlantation: {}
};

function ensureStateFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState, null, 2), 'utf8');
  }
}

function readState() {
  ensureStateFile();
  const raw = fs.readFileSync(STATE_FILE, 'utf8');
  try {
    const state = JSON.parse(raw);
    if (!state.guilds) state.guilds = {};
    if (!state.tasks) state.tasks = {};
    if (!state.reports) state.reports = [];
    if (!state.pendingEvidence) state.pendingEvidence = {};
    if (!state.pendingPlantation) state.pendingPlantation = {};
    return state;
  } catch {
    return { ...defaultState };
  }
}

function writeState(state) {
  ensureStateFile();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

module.exports = {
  readState,
  writeState
};
