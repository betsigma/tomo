// canvas.js
// ---------------------------------------------------------------------------
// All the Canvas-specific logic lives here, separate from the window code.
// It takes raw iCalendar (.ics) text and returns a clean, simple array the rest
// of the app can use. Keeping it separate also makes it easy to test on its own.
// ---------------------------------------------------------------------------

const ical = require('node-ical');
const { stripHtml, decodeEntities, cleanTitle } = require('./titles');

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

// Canvas usually writes the course in brackets: "Quiz 3 - Limits (MATH 1A)".
// Split that into { title: "Quiz 3 - Limits", course: "MATH 1A" }.
function splitCourse(summary) {
  const m = summary.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (m) return { title: m[1].trim(), course: m[2].trim() };
  return { title: summary, course: '' };
}

// Pull the first link out of a description (Canvas embeds the assignment URL).
function firstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : '';
}

// Make a description readable: no tags, entities decoded, whitespace collapsed.
// Kept long enough (~4,000 chars) for the Deadline & Task Analyst to summarize.
const DESCRIPTION_MAX = 4000;
function cleanDescription(html) {
  return cleanTitle(stripHtml(decodeEntities(String(html || '')))).slice(0, DESCRIPTION_MAX);
}

// Turn raw .ics text into a clean list of items.
function normalizeCalendar(text) {
  const parsed = ical.sync.parseICS(text);
  const items = [];

  for (const key of Object.keys(parsed)) {
    const e = parsed[key];
    if (!e || e.type !== 'VEVENT') continue;   // only calendar events
    if (e.rrule) continue;                     // recurring = class meetings; skip
    if (!e.start) continue;

    const summary = String(e.summary || '').trim();
    if (!summary) continue;

    const allDay = e.datetype === 'date';      // 'date' = all-day, 'date-time' = timed
    const startD = new Date(e.start);
    const endD = e.end ? new Date(e.end) : null;
    const { title, course } = splitCourse(summary);
    const rawDesc = e.description ? String(e.description) : '';
    // node-ical gives URL as { params, val }; plain feeds may give a string.
    const urlProp = e.url && typeof e.url === 'object' ? e.url.val : e.url;

    items.push({
      uid: String(e.uid || key),               // stable id -> used to dedupe
      title,
      course,
      start: toLocalDate(startD),
      time: allDay ? '' : toLocalTime(startD),
      allDay,
      endTime: (!allDay && endD && !isNaN(endD)) ? toLocalTime(endD) : '',
      location: String(e.location || '').trim(),
      description: cleanDescription(rawDesc),
      url: String(urlProp || '').trim() || firstUrl(rawDesc)
    });
  }

  // Soonest first.
  items.sort((a, b) => (a.start + a.time).localeCompare(b.start + b.time));
  return items;
}

// Just the host, so a log line can never reveal the private feed token that is
// part of the full URL.
function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return '(unknown host)'; }
}

// Download the feed text. Uses Node's global fetch, which exists both in a plain
// Node script and in Electron's main process. Errors carry a status or a code so
// the caller can show a real reason instead of a generic failure.
async function fetchText(url) {
  console.log('[canvas] fetching feed from', hostOf(url));   // host only, never the token
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    const why = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || 'request failed';
    const e = new Error('Network error: ' + why);
    e.code = 'ENETWORK';
    throw e;
  }
  if (!res.ok) {
    const e = new Error('HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : ''));
    e.status = res.status;
    throw e;
  }
  return res.text();
}

module.exports = { normalizeCalendar, fetchText, hostOf };
