// textdate.js
// ---------------------------------------------------------------------------
// Local date/time formatting shared by the main-process modules.
// ---------------------------------------------------------------------------

// Date -> 'YYYY-MM-DD' using LOCAL time.
function toLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Date -> 'HH:MM' using LOCAL time.
function toLocalTime(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

module.exports = { toLocalDate, toLocalTime };
