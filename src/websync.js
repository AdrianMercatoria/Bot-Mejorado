// Envia a la web de la banda (POST /api/bot/eventos) los contactos y las runs
// que registra el bot, para que entren en estadisticas y sorteos.
//
// La web ignora un evento repetido si trae el mismo id, asi que reenviar es
// seguro. Lo que no sabe emparejar con un miembro NO lo guarda: esos eventos se
// quedan pendientes aqui y se reintentan en cada pasada hasta que alguien
// vincula ese Discord en la web.

const { readState, writeState } = require('./storage');

const WEB_URL = (process.env.WEB_URL || '').trim().replace(/\/+$/, '');
const WEB_SECRET = (process.env.WEB_BOT_SECRET || '').trim();
const BATCH_SIZE = 500;
const REQUEST_TIMEOUT_MS = 20 * 1000;

function isEnabled() {
  return Boolean(WEB_URL && WEB_SECRET);
}

// Id estable de un reporte: no cambia entre pasadas ni entre reinicios.
function reportId(report) {
  return `${report.kind}:${report.guildId}:${report.userId}:${report.createdAt}`;
}

// Traduce un reporte del bot a un evento de la web, o null si no le interesa.
function toWebEvent(report) {
  if (!report.userId || !report.createdAt) return null;
  let tipo = null;
  if (report.kind === 'maritime_terrestrial') tipo = report.type; // maritimo | terrestre | aereo
  else if (report.kind === 'runs_start') tipo = 'run';
  if (!tipo) return null;
  return {
    id: reportId(report),
    discordId: report.userId,
    tipo,
    // La web cuelga los eventos del dia en UTC.
    dia: new Date(report.createdAt).toISOString().slice(0, 10)
  };
}

async function postEvents(events) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${WEB_URL}/api/bot/eventos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEB_SECRET}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ eventos: events }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${body?.error || 'sin detalle'}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

let running = false;
let lastPendingSummary = '';

// Manda lo pendiente. Devuelve un resumen, o null si esta desactivado u ocupado.
async function syncToWeb() {
  if (!isEnabled() || running) return null;
  running = true;
  try {
    const state = readState();
    const sent = new Set(state.webSync?.sentIds || []);
    const pending = state.reports
      .map(toWebEvent)
      .filter((event) => event && !sent.has(event.id));
    if (!pending.length) return { enviados: 0, guardados: 0, sinEmparejar: [] };

    const accepted = [];
    const unmatched = new Set();
    let guardados = 0;

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const result = await postEvents(batch);
      guardados += result.guardados || 0;
      const batchUnmatched = new Set(result.sinEmparejar || []);
      const discarded = new Set(
        (result.descartados || []).map((d) => Number(String(d).match(/^#(\d+)/)?.[1]) - 1)
      );
      batch.forEach((event, idx) => {
        if (batchUnmatched.has(event.discordId)) unmatched.add(event.discordId);
        else if (!discarded.has(idx)) accepted.push(event.id);
      });
    }

    // Releemos: el bot pudo guardar cambios mientras esperabamos a la web.
    const fresh = readState();
    const liveIds = new Set(fresh.reports.map(reportId));
    const merged = new Set([...(fresh.webSync?.sentIds || []), ...accepted]);
    fresh.webSync = {
      // Solo guardamos ids de reportes que siguen existiendo (el historial tiene tope).
      sentIds: [...merged].filter((id) => liveIds.has(id)),
      lastSyncAt: Date.now(),
      unmatchedDiscordIds: [...unmatched]
    };
    writeState(fresh);

    const summary = `${accepted.length} confirmados, ${guardados} nuevos en la web, ${unmatched.size} usuario(s) sin vincular`;
    const pendingKey = [...unmatched].sort().join(',');
    if (accepted.length || pendingKey !== lastPendingSummary) {
      console.log(
        `[web] ${summary}` +
          (unmatched.size ? `. Vincula su Discord en Miembros de la web: ${[...unmatched].join(', ')}` : '')
      );
    }
    lastPendingSummary = pendingKey;
    return { enviados: pending.length, guardados, sinEmparejar: [...unmatched] };
  } finally {
    running = false;
  }
}

module.exports = { isEnabled, syncToWeb };
