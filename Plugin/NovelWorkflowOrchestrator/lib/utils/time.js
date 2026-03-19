function toLocalIsoString(now = new Date()) {
  const tzMinutes = -now.getTimezoneOffset();
  const sign = tzMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(tzMinutes);
  const offsetHours = String(Math.floor(absMinutes / 60)).padStart(2, '0');
  const offsetMinutes = String(absMinutes % 60).padStart(2, '0');
  const localDate = new Date(now.getTime() + tzMinutes * 60 * 1000);
  return `${localDate.toISOString().slice(0, 23)}${sign}${offsetHours}:${offsetMinutes}`;
}

function toLocalCompactTimestamp(now = new Date()) {
  return toLocalIsoString(now).replace(/[^\d]/g, '').slice(0, 14);
}

module.exports = {
  toLocalIsoString,
  toLocalCompactTimestamp
};
