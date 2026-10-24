// textdate.js
// ---------------------------------------------------------------------------
// Shared "find a date in some text" helper, used by BOTH Gmail and Discord.
// Runs in Node (main process), so it can use the chrono-node library.
// ---------------------------------------------------------------------------

const chrono = require('chrono-node');

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

// Look for a date (and maybe a time) inside some text using chrono-node.
// Returns { start:'YYYY-MM-DD', time:'HH:MM'|'', allDay, matchedText } or null.
// Dates more than a week old or a year away are ignored to reduce false hits.
function detectEvent(text) {
  const results = chrono.parse(String(text || ''), new Date(), { forwardDate: true });

  for (const r of results) {
    const d = r.start.date();
    const t = d.getTime();
    const now = Date.now();
    if (t < now - 7 * 86400000) continue;
    if (t > now + 366 * 86400000) continue;

    const hasTime = r.start.isCertain('hour');
    return {
      start: toLocalDate(d),
      time: hasTime ? toLocalTime(d) : '',
      allDay: !hasTime,
      matchedText: r.text
    };
  }
  return null;
}

module.exports = { toLocalDate, toLocalTime, detectEvent };
