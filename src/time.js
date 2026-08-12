function formatDuration(ms) {
  if (ms <= 0) return 'Disponible ahora';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds && !hours) parts.push(`${seconds}s`);

  return parts.length ? parts.join(' ') : '0s';
}

function addHours(hours) {
  return Date.now() + hours * 60 * 60 * 1000;
}

const UNIT_MS = {
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000
};

const MIN_DURATION_MS = 30 * 1000;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Convierte "2h", "1h30m", "45m", "2d", "90" (minutos) en milisegundos.
 * Devuelve { ms } o { error } con un mensaje explicando que se esperaba.
 */
function parseDuration(input) {
  if (!input) return { error: 'Escribe una duracion, por ejemplo `2h`, `45m` o `1h30m`.' };

  const value = String(input).trim().toLowerCase().replace(/\s+/g, '');
  if (!value) return { error: 'Escribe una duracion, por ejemplo `2h`, `45m` o `1h30m`.' };

  // Un numero suelto se interpreta como minutos.
  if (/^\d+$/.test(value)) {
    return checkRange(Number(value) * UNIT_MS.m, `${value}m`);
  }

  if (!/^(\d+[dhms])+$/.test(value)) {
    return {
      error:
        `No entiendo la duracion \`${input}\`.\n` +
        'Usa numero + unidad: `2h`, `45m`, `1h30m`, `2d`, `90s`. Un numero suelto son minutos.'
    };
  }

  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+)([dhms])/g)) {
    total += Number(amount) * UNIT_MS[unit];
  }
  return checkRange(total, value);
}

function checkRange(ms, shown) {
  if (ms < MIN_DURATION_MS) {
    return { error: `\`${shown}\` es demasiado corto. El minimo son 30 segundos.` };
  }
  if (ms > MAX_DURATION_MS) {
    return { error: `\`${shown}\` es demasiado largo. El maximo son 30 dias.` };
  }
  return { ms };
}

// Como formatDuration pero incluyendo dias, para CDs largos.
function formatLongDuration(ms) {
  if (ms <= 0) return 'ya termino';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds && !days && !hours) parts.push(`${seconds}s`);
  return parts.join(' ') || '0s';
}

module.exports = {
  formatDuration,
  formatLongDuration,
  addHours,
  parseDuration,
  MIN_DURATION_MS,
  MAX_DURATION_MS
};
