// teamInputs.js
// ---------------------------------------------------------------------------
// Pure helpers that turn the widget's store into each agent's input, and check
// agent output against the real calendar. No network, no Electron: data in,
// data out (tested in test-features.js).
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const Recur = require('./src/recur.js');

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localStamp = (d) => `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseStamp = (s) => {
  const [date, time = '00:00'] = String(s).split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function contentHash(task) {
  const basis = [task.title, task.due_date, task.course, task.description || ''].join('␟');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

// A description that is only a meeting link or a one-line boilerplate carries
// nothing to summarize; send null so the Analyst answers "low" confidence.
function usefulDescription(text) {
  const d = String(text || '').trim();
  const words = d.replace(/https?:\/\/\S+/g, ' ').replace(/\[[^\]]*\]/g, ' ').trim();
  return words.length >= 20 ? d : null;
}

// ---------------------------------------------------------------------------
// Deadline & Task Analyst
// ---------------------------------------------------------------------------
// Open tasks due from `overdueDays` ago (default 3) through `horizonDays` ahead
// (default 14), soonest first, at most `max` (default 30). Done, dismissed,
// suggested and filtered tasks are left out. A description is sent only when
// the task is new or its content changed (cache keyed by task id + hash).
function courseCode(task) {
  const text = `${task.course || ''} ${task.title || ''}`;
  const skip = new Set(['WEEK', 'LAB', 'QUIZ', 'EXAM', 'UNIT', 'DAY', 'DUE', 'PART']);
  const bracket = text.match(/\[[^\]]*?\b([A-Z]{2,5})\s+([A-Z]?\d{1,4}[A-Z]?)\b/i);
  if (bracket && !skip.has(bracket[1].toUpperCase())) return (bracket[1] + ' ' + bracket[2]).toUpperCase();
  const re = /\b([A-Z]{2,5})\s+([A-Z]?\d{1,4}[A-Z]?)\b/gi;
  let m;
  while ((m = re.exec(text))) {
    if (!skip.has(m[1].toUpperCase())) return (m[1] + ' ' + m[2]).toUpperCase();
  }
  return '';
}

function titlesOverlap(a, b) {
  const x = String(a || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const y = String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!x || !y || Math.min(x.length, y.length) < 8) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// Same course code, same due date, and one title contains the other: keep the
// longer title so the Analyst is not asked twice.
function mergeDuplicateTasks(tasks) {
  const kept = [];
  const merged = [];
  for (const t of tasks || []) {
    const code = courseCode(t);
    const due = String(t.due_date || '').slice(0, 10);
    const hit = kept.find((k) => courseCode(k) === code && code && String(k.due_date || '').slice(0, 10) === due && titlesOverlap(k.title, t.title));
    if (!hit) { kept.push(t); continue; }
    const stay = t.title.length > hit.title.length ? t : hit;
    const drop = stay === t ? hit : t;
    if (stay !== hit) kept[kept.indexOf(hit)] = stay;
    merged.push({ kept: stay.title, dropped: drop.title, course: code, due });
  }
  return { tasks: kept, merged };
}

function buildAnalystInput(store, analystCache, importantEmails, now = new Date(), opts = {}) {
  const horizonDays = opts.horizonDays == null ? 14 : opts.horizonDays;
  const overdueDays = opts.overdueDays == null ? 3 : opts.overdueDays;
  const max = opts.max == null ? 30 : opts.max;
  const today = localDate(now);
  const from = localDate(addDays(now, -overdueDays));
  const to = localDate(addDays(now, horizonDays));
  const eventByKey = new Map((store.events || []).map((e) => [e.dedupeKey, e]));

  // Canvas items are agent input, not the visible task list. They live in
  // archived.legacy_canvas once migrated; before that, fall back to old todos.
  const archived = store.archived && Array.isArray(store.archived.legacy_canvas) && store.archived.legacy_canvas.length
    ? store.archived.legacy_canvas
    : null;
  const pool = archived || (store.todos || []).filter((t) => t && t.source === 'canvas');
  const eligible = pool
    .filter((t) => t && !t.done && t.due && t.status !== 'dismissed' && t.status !== 'suggested' && t.status !== 'filtered')
    .map((t) => {
      const due = String(t.due).slice(0, 10);
      const ev = eventByKey.get(t.dedupeKey) || {};
      return {
        id: t.id,
        title: t.title || '',
        due_date: t.time ? `${due}T${t.time}` : due,
        course: t.course || '',
        description: usefulDescription(ev.description)
      };
    })
    .filter((t) => t.due_date.slice(0, 10) >= from && t.due_date.slice(0, 10) <= to)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const folded = mergeDuplicateTasks(eligible);
  const candidates = folded.tasks.slice(0, max);

  const hashes = {};
  const tasks = candidates.map((t) => {
    const h = contentHash(t);
    hashes[t.id] = h;
    const known = analystCache[t.id] && analystCache[t.id].hash === h;
    return known ? { ...t, description: null } : t;
  });

  return {
    input: {
      tasks,
      important_emails: (importantEmails || []).map((m) => ({
        subject: m.subject, summary: m.summary, event_date: m.event_date || null
      })),
      today
    },
    hashes,
    sent: candidates.length,
    eligible: folded.tasks.length,
    merged: folded.merged
  };
}

// Combine a fresh Analyst reply with cached per-task summaries: tasks that were
// sent without a description (unchanged) keep their earlier summary fields.
// Returns { tasks, cache } with the cache updated for new/changed tasks.
function mergeAnalyst(output, sentInput, hashes, analystCache) {
  const sentById = new Map(sentInput.tasks.map((t) => [t.id, t]));
  const cache = { ...analystCache };
  const tasks = (output.tasks || []).map((t) => {
    const sent = sentById.get(t.id);
    const prev = cache[t.id];
    if (sent && sent.description === null && prev && prev.hash === hashes[t.id]) {
      const { summary, deliverables, effort_estimate_minutes, confidence } = prev.result;
      return { ...t, summary, deliverables, effort_estimate_minutes, confidence };
    }
    if (sent && hashes[t.id]) {
      cache[t.id] = { hash: hashes[t.id], result: {
        summary: t.summary, deliverables: t.deliverables,
        effort_estimate_minutes: t.effort_estimate_minutes, confidence: t.confidence
      } };
    }
    return t;
  });
  // Forget tasks that are no longer open, so the cache does not grow forever.
  for (const id of Object.keys(cache)) if (!sentById.has(id)) delete cache[id];
  tasks.sort((a, b) => a.priority_rank - b.priority_rank);
  return { tasks, cache };
}

// ---------------------------------------------------------------------------
// Planner: calendar + free windows
// ---------------------------------------------------------------------------
// Timed, active events (incl. recurring occurrences) in the next `days` days.
// All-day events are deadlines, not busy time, so they are left out.
function buildCalendar(store, now = new Date(), days = 7) {
  const fromISO = localDate(now);
  const toISO = localDate(addDays(now, days));
  const out = [];
  for (const ev of (store.events || [])) {
    if (ev.status !== 'active' || !ev.time) continue;
    for (const occ of Recur.occurrences(ev, fromISO, toISO)) {
      const v = occ.view;
      if (!v.time) continue;
      const start = `${occ.date}T${v.time}`;
      const end = v.endTime && v.endTime > v.time ? `${occ.date}T${v.endTime}` : localStamp(new Date(parseStamp(start).getTime() + 60 * 60000));
      out.push({ start, end, title: v.title || '' });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

// Gaps between busy blocks inside each day's study hours, starting from now.
function freeWindows(calendar, now = new Date(), opts = {}) {
  const days = opts.days || 7;
  const dayStart = opts.dayStart || '09:00';
  const dayEnd = opts.dayEnd || '21:00';
  const minMinutes = opts.minMinutes || 25;
  const busy = calendar.map((c) => [parseStamp(c.start), parseStamp(c.end)]);
  const windows = [];
  for (let i = 0; i < days; i++) {
    const date = localDate(addDays(now, i));
    let cursor = parseStamp(`${date}T${dayStart}`);
    const end = parseStamp(`${date}T${dayEnd}`);
    if (i === 0 && now > cursor) {
      // Round "now" up to the next quarter hour.
      cursor = new Date(Math.ceil(now.getTime() / (15 * 60000)) * 15 * 60000);
    }
    const todays = busy.filter(([s, e]) => e > cursor && s < end).sort((a, b) => a[0] - b[0]);
    for (const [s, e] of todays) {
      if (s > cursor && (s - cursor) / 60000 >= minMinutes) windows.push({ start: localStamp(cursor), end: localStamp(s) });
      if (e > cursor) cursor = e;
    }
    if (end > cursor && (end - cursor) / 60000 >= minMinutes) windows.push({ start: localStamp(cursor), end: localStamp(end) });
  }
  return windows;
}

// Enforce the Planner's hard rules locally: every block must sit inside one
// free window and must not overlap an event or an earlier accepted block.
// Returns { kept, dropped:[{proposal, why}] }.
function checkProposals(proposals, calendar, windows) {
  const kept = [];
  const dropped = [];
  const overlaps = (a, b) => a.s < b.e && b.s < a.e;
  const busy = calendar.map((c) => ({ s: parseStamp(c.start), e: parseStamp(c.end) }));
  const wins = windows.map((w) => ({ s: parseStamp(w.start), e: parseStamp(w.end) }));
  for (const p of proposals || []) {
    const r = { s: parseStamp(p.start), e: parseStamp(p.end) };
    let why = null;
    if (!(r.e > r.s)) why = 'end is not after start';
    else if (!wins.some((w) => r.s >= w.s && r.e <= w.e)) why = 'outside free windows';
    else if (busy.some((b) => overlaps(r, b))) why = 'overlaps an event';
    else if (kept.some((k) => overlaps(r, { s: parseStamp(k.start), e: parseStamp(k.end) }))) why = 'overlaps another block';
    if (why) dropped.push({ proposal: p, why });
    else kept.push(p);
  }
  return { kept, dropped };
}

module.exports = {
  localDate, localStamp, parseStamp, contentHash, usefulDescription,
  buildAnalystInput, mergeAnalyst, mergeDuplicateTasks, buildCalendar, freeWindows, checkProposals
};
