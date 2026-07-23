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

module.exports = {
  formatDuration,
  addHours
};
