// recur.js
// ---------------------------------------------------------------------------
// Pure recurrence helpers. "One rule, many occurrences": instead of saving a
// copy of an event for every meeting, we store ONE rule on the event and
// generate the dates for the visible month only, at render time.
//
// This file works two ways (same trick as sync.js):
//   - in the widget window as `Recur` (loaded by a <script> tag)
//   - in Node.js tests via require('./recur.js')
//
// Rule shape stored on an event:
//   recurrence = {
//     freq: 'none' | 'daily' | 'weekly' | 'monthly',
//     weekdays: [0..6],   // Weekly only; 0 = Sunday. Empty -> the start day.
//     until: 'YYYY-MM-DD' | '',  // optional last allowed day
//     count: number | null       // optional max number of occurrences
//   }
// Per-date data lives next to it (added/removed by the renderer):
//   skipped:        { 'YYYY-MM-DD': true }   // a removed single occurrence
//   exceptions:     { 'YYYY-MM-DD': { ...fields } }  // an edited occurrence
//   occurrencesDone:{ 'YYYY-MM-DD': true }   // per-occurrence "done"
// ---------------------------------------------------------------------------

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Recur = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const FREQS = ['none', 'daily', 'weekly', 'monthly'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MAX_DAYS = 366 * 10;   // safety cap (~10 years) for the day walk

  // Date -> 'YYYY-MM-DD' using LOCAL time.
  function toISO(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseISO(s) {
    const [y, m, d] = String(s || '').split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  // Fill in missing pieces so the rest of the code never has to guess.
  function normalizeRecurrence(rec) {
    const r = rec || {};
    const freq = FREQS.includes(r.freq) ? r.freq : 'none';
    let weekdays = Array.isArray(r.weekdays) ? r.weekdays.map(Number).filter((n) => n >= 0 && n <= 6) : [];
    weekdays = [...new Set(weekdays)].sort((a, b) => a - b);
    const until = /^\d{4}-\d{2}-\d{2}$/.test(String(r.until || '')) ? r.until : '';
    const count = r.count ? Math.max(1, Number(r.count)) : null;
    return { freq, weekdays, until, count };
  }

  // Does the calendar day `d` match the rule (given the event's start date)?
  function matches(d, rec, start) {
    const r = normalizeRecurrence(rec);
    if (r.freq === 'none') return toISO(d) === toISO(start);
    if (r.freq === 'daily') return true;
    if (r.freq === 'weekly') {
      const days = r.weekdays.length ? r.weekdays : [start.getDay()];
      return days.includes(d.getDay());
    }
    if (r.freq === 'monthly') return d.getDate() === start.getDate();
    return false;
  }

  // Every date this event happens on, restricted to [fromISO, toISO).
  // For a plain (non-recurring) event this is just its own start date when
  // that date falls in the window.
  function expand(ev, fromISO, toISOExclusive) {
    const out = [];
    if (!ev || !ev.start) return out;
    const startDate = parseISO(ev.start);
    const rec = normalizeRecurrence(ev.recurrence);
    if (rec.freq === 'none') {
      if (ev.start >= fromISO && ev.start < toISOExclusive) out.push(ev.start);
      return out;
    }

    let count = 0;
    let cur = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    for (let i = 0; i < MAX_DAYS; i++) {
      const ds = toISO(cur);
      if (rec.until && ds > rec.until) break;      // past the end date
      if (ds >= toISOExclusive) break;             // past the visible window

      if (matches(cur, rec, startDate)) {
        count++;
        if (rec.count && count > rec.count) break; // past the "after N times"
        if (ds >= fromISO) out.push(ds);
      }
      cur = addDays(cur, 1);
    }
    return out;
  }

  // A short human label, e.g. "Every Mon, Wed" or "Monthly on the 16th".
  function describe(rec) {
    const r = normalizeRecurrence(rec);
    if (r.freq === 'none') return 'Does not repeat';
    if (r.freq === 'daily') return 'Every day';
    if (r.freq === 'weekly') {
      if (!r.weekdays.length) return 'Every week';
      return 'Every ' + r.weekdays.map((d) => WEEKDAYS[d]).join(', ');
    }
    if (r.freq === 'monthly') return 'Every month';
    return '';
  }

  // The occurrences to DRAW in [fromISO, toISOExclusive), with the per-date data
  // applied: a removed one (exceptions[d].cancelled) is dropped, an edited one
  // carries its extra fields, and each keeps its own "done" flag.
  function occurrences(ev, fromISO, toISOExclusive) {
    const out = [];
    for (const d of expand(ev, fromISO, toISOExclusive)) {
      const ex = (ev.exceptions && ev.exceptions[d]) || null;
      if (ex && ex.cancelled) continue;
      out.push({
        date: d,
        done: !!(ev.occurrencesDone && ev.occurrencesDone[d]),
        view: { ...ev, ...(ex || {}), start: d, id: ev.id + '@' + d }
      });
    }
    return out;
  }

  return { FREQS, WEEKDAYS, toISO, parseISO, addDays, normalizeRecurrence, matches, expand, describe, occurrences };
});
