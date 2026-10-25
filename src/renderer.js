// renderer.js
// ---------------------------------------------------------------------------
// Runs INSIDE the window. It cannot touch files or the OS directly; it calls the
// safe functions from preload.js (window.widgetAPI).
//
// Stage 3 adds Canvas sync:
//   - a Settings modal where you paste your Canvas iCal feed URL (stored
//     encrypted by the main process)
//   - syncCanvas() downloads items and MERGES them into events + todos
//   - a dedupeKey prevents duplicates when the same item syncs twice
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. State
// ---------------------------------------------------------------------------
let store = {
  events: [],
  todos: [],
  links: [],
  overrides: {},
  llmCache: {},
  // Learned-filter training examples: [{ key, text, label, source, at }].
  // label 1 = useful (accepted / done / kept), 0 = not useful (dismissed / blocked).
  mlExamples: [],
  emails: [],
  discord: [],
  settings: {
    theme: 'auto', refreshMinutes: 15, alwaysOnTop: true, viewMode: 'compact',
    deadlineWindowDays: 2,
    canvas: {},
    gmail: {
      keywords: 'appointment, deadline, interview',
      senders: '',
      domains: 'deanza.edu',
      names: 'de anza, deanza',
      trustedSenders: 'communications@deanza.edu, *@fhda.edu',
      blockedSenders: '',
      // Subject + start of body; matching emails are dropped and logged.
      excludeKeywords: 'voter registration, register to vote, ballot, polling place, election day',
      label: '',
      maxResults: 15,
      days: 30,
      cleanupDone: false
    },
    gmailMeta: {},
    llm: { enabled: false, model: 'gemini-2.5-flash-lite' },
    // Learned relevance filter. Off by default; only used once there are enough
    // labelled examples. `seeded` records that we already back-filled examples
    // from the existing history, so we never do it twice.
    ml: { enabled: false, seeded: false },
    timer: { work: 25, break: 5, notify: true, sound: true },
    music: { track: 0, shuffle: false, loop: false },
    discord: { limit: 25 },
    discordMeta: {}
  }
};

let calendar = null;
let currentView = 'compact';
let editingEventId = null;
let refreshTimer = null;
let canvasConnected = false;
let gmailConnected = false;
let gmailEmail = null;
let discordConnected = false;
let discordChannel = null;

// Palette from the app icon: Manual = butter yellow, Canvas = pink,
// Gmail = lavender, Discord = baby blue. Kept in sync with --src-* in styles.css.
const SOURCE_COLORS = {
  manual:  '#fbe8a0',
  canvas:  '#f8a3c4',
  gmail:   '#d4bfff',
  discord: '#afc6ff',
  agent:   '#ffd6a5'
};

// ---------------------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------------------
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayStr() { return toISODate(new Date()); }

function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Local "add N days" (all comparisons stay on local calendar days).
function addDays(d, n) { return Recur.addDays(d, n); }

// Normalize any date-ish value to a local 'YYYY-MM-DD'. A date-only string keeps
// its own day, and a naive "23:59" local datetime stays on that day too — this
// avoids the classic `new Date('2026-10-12')` = UTC-midnight roll-back bug.
function localDateOf(value) {
  if (!value) return '';
  if (value instanceof Date) return toISODate(value);
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : toISODate(d);
}

// Friendly label: "Today", "Tomorrow", "Wed Oct 14" (+ due time), with an
// "Overdue ·" prefix for past dates.
function formatDue(value, time) {
  const iso = localDateOf(value);
  if (!iso) return '';
  const today = todayStr();
  const tomorrow = toISODate(addDays(new Date(), 1));
  const label = iso === today ? 'Today'
    : iso === tomorrow ? 'Tomorrow'
    : parseISODate(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const shown = time ? `${label} ${time}` : label;
  return iso < today ? `Overdue \u00B7 ${shown}` : shown;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Unique-id + merge helpers live in sync.js (loaded before this file) so the
// same logic can be tested outside the app.
const uid = Sync.uid;

function byDue(a, b) {
  if (a.due && b.due) return a.due.localeCompare(b.due);
  if (a.due) return -1;
  if (b.due) return 1;
  return 0;
}

// Safe DOM helpers: one missing element must never crash the whole render.
// Each helper warns and no-ops when the element is absent.
function el(id) {
  const n = document.getElementById(id);
  if (!n) console.warn('[renderer] missing element #' + id);
  return n;
}
function setText(id, value) {
  const n = document.getElementById(id);
  if (n) n.textContent = value;
  else console.warn('[renderer] missing element #' + id + ' (textContent skipped)');
}
function setHTML(id, html) {
  const n = document.getElementById(id);
  if (n) n.innerHTML = html;
  else console.warn('[renderer] missing element #' + id + ' (innerHTML skipped)');
}
function toggleHidden(id, hide) {
  const n = document.getElementById(id);
  if (n) n.classList.toggle('hidden', hide);
  else console.warn('[renderer] missing element #' + id + ' (classList skipped)');
}
function setStatus(msg) {
  setText('status', msg);
}

// Only ACTIVE items appear in the UI. 'suggested' waits in Settings for your
// decision; 'dismissed' items are tombstones (kept in the file, never shown);
// 'filtered' items were hidden by the learned filter and wait in Settings.
function activeEvents() {
  return (store.events || []).filter((e) =>
    e.status !== 'dismissed' && e.status !== 'suggested' && e.status !== 'filtered');
}
function activeTodos() {
  return (store.todos || []).filter((t) => t.status !== 'dismissed' && t.status !== 'suggested' && t.status !== 'filtered');
}

// ---------------------------------------------------------------------------
// 3. Persistence
// ---------------------------------------------------------------------------
function save() { window.widgetAPI.saveStore(store); }

async function load() {
  const data = await window.widgetAPI.loadStore();
  store.events = data.events || [];
  store.todos = data.todos || [];
  store.links = data.links || [];
  store.overrides = data.overrides || {};
  store.llmCache = data.llmCache || {};
  store.mlExamples = Array.isArray(data.mlExamples) ? data.mlExamples : [];
  store.emails = data.emails || [];
  store.discord = data.discord || [];
  // Merge settings deeply enough that NEW default fields appear for existing
  // users (e.g. the new Gmail domain/name/trusted-sender rules).
  const s = data.settings || {};
  store.settings = {
    ...store.settings,
    ...s,
    gmail: { ...store.settings.gmail, ...(s.gmail || {}) },
    llm: { ...store.settings.llm, ...(s.llm || {}) },
    ml: { ...store.settings.ml, ...(s.ml || {}) },
    timer: { ...store.settings.timer, ...(s.timer || {}) },
    music: { ...store.settings.music, ...(s.music || {}) },
    discord: { ...store.settings.discord, ...(s.discord || {}) }
  };
}

// ---------------------------------------------------------------------------
// 4. To-do list
// ---------------------------------------------------------------------------
let teamState = null;

function taskSummary(id) {
  const tasks = teamState && teamState.outputs && teamState.outputs.ANALYST && teamState.outputs.ANALYST.tasks;
  const hit = (tasks || []).find((t) => t && t.id === id);
  return hit && hit.summary ? String(hit.summary) : '';
}

function shortWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function mailScannerLive() {
  return !!(teamState && teamState.nodes && teamState.nodes.MAIL && teamState.nodes.MAIL.mode === 'live');
}

function updateGeminiControls() {
  if (!llmEnabled) return;
  const live = mailScannerLive();
  const note = document.getElementById('llm-live-note');
  if (note) note.classList.toggle('hidden', !live);
  llmEnabled.disabled = live;
  if (live) llmEnabled.checked = false;
  else llmEnabled.checked = !!(store.settings.llm && store.settings.llm.enabled);
}

function renderMorningBrief() {
  const el = document.getElementById('morning-brief');
  if (!el) return;
  const text = teamState && teamState.outputs && teamState.outputs.DIGEST && teamState.outputs.DIGEST.morning_brief;
  const brief = String(text || '').trim();
  el.classList.toggle('hidden', !brief);
  el.innerHTML = brief ? `<strong>Morning brief</strong>${esc(brief)}` : '';
}

function renderTeam() {
  const chart = document.getElementById('team-chart');
  if (!chart) return;
  const state = teamState;
  const loading = document.getElementById('team-loading');
  const runBtn = document.getElementById('team-run');
  if (!state) {
    chart.innerHTML = '<p class="hint">The team has not reported in yet.</p>';
    return;
  }
  if (loading) loading.classList.toggle('hidden', !state.running);
  if (runBtn) runBtn.disabled = !!state.running;
  const last = state.lastRun && state.lastRun.at ? 'Last run ' + shortWhen(state.lastRun.at) : 'Not run yet';
  const next = state.nextRunAt ? ' · next ' + shortWhen(state.nextRunAt) : '';
  setText('team-schedule', last + next);

  const order = state.order || [];
  chart.innerHTML = order.map((role, i) => {
    const node = (state.nodes && state.nodes[role]) || {};
    const status = node.status || 'idle';
    const sent = role === 'ANALYST' && state.analystSent
      ? `<div class="team-sent">sent ${state.analystSent.sent} of ${state.analystSent.eligible}</div>` : '';
    const when = node.at ? `<div class="team-meta">${esc(shortWhen(node.at))}${node.cached ? ' · cached' : ''}</div>` : '';
    const err = node.error ? `<div class="team-error">${esc(node.error)}</div>` : '';
    const arrow = i < order.length - 1
      ? `<div class="team-arrow">&#8595; ${esc(node.handoff || '')}</div>` : '';
    return `<article class="team-node is-${esc(status)}">
      <div class="team-node-top"><span class="team-name">${esc(node.name || role)}</span><span class="team-status ${esc(status)}">${esc(status)}</span></div>
      ${when}${sent}${err}
    </article>${arrow}`;
  }).join('');

  const pending = document.getElementById('team-pending');
  if (!pending) return;
  const proposals = (typeof Inbox !== 'undefined')
    ? Inbox.pendingProposals(state.outputs, store)
    : [];
  pending.innerHTML = proposals.length ? proposals.map(pendingRow).join('') : '<li class="empty-note">Nothing waiting yet.</li>';
}

function pendingRow(p) {
  const when = [p.start, p.time].filter(Boolean).join(' ');
  const what = p.what || [p.summary, p.reason].filter(Boolean).join(' — ');
  return `<li class="pending-item" data-key="${esc(p.key)}">
    <div class="pending-title">${esc(p.title)}</div>
    <div class="pending-meta">${esc(when)}${p.location ? ' · ' + esc(p.location) : ''}</div>
    <details class="pending-what"><summary>what's this?</summary><p>${esc(what || 'No summary yet.')}</p></details>
    <form class="pending-edit hidden" data-edit-for="${esc(p.key)}">
      <input name="title" type="text" value="${esc(p.title)}" />
      <input name="start" type="date" value="${esc(p.start || '')}" />
      <input name="time" type="time" value="${esc(p.time || '')}" />
    </form>
    <div class="pending-actions">
      <button type="button" class="btn small primary" data-action="approve-proposal" data-key="${esc(p.key)}">Approve</button>
      <button type="button" class="btn small" data-action="edit-proposal" data-key="${esc(p.key)}">Edit</button>
      <button type="button" class="btn small" data-action="reject-proposal" data-key="${esc(p.key)}">Reject</button>
    </div>
  </li>`;
}

function proposalByKey(key) {
  if (typeof Inbox === 'undefined' || !teamState) return null;
  return Inbox.listProposals(teamState.outputs).find((p) => p.key === key) || null;
}

function editsFromForm(key) {
  const form = document.querySelector('.pending-edit[data-edit-for="' + key.replace(/"/g, '') + '"]');
  if (!form || form.classList.contains('hidden')) return null;
  return {
    title: form.querySelector('[name=title]').value.trim(),
    start: form.querySelector('[name=start]').value,
    time: form.querySelector('[name=time]').value
  };
}

function decideProposal(key, action) {
  const proposal = proposalByKey(key);
  if (!proposal || typeof Inbox === 'undefined') return;
  if (action === 'reject') Inbox.rejectProposal(store, proposal, uid);
  else Inbox.approveProposal(store, proposal, editsFromForm(key), uid);
  save();
  renderCalendar();
  renderTeam();
  setStatus(action === 'reject' ? 'Proposal rejected' : 'Added to calendar');
}

function applyTeam(state) {
  teamState = state || null;
  renderMorningBrief();
  renderTeam();
  renderTodos();
  updateGeminiControls();
}

function todoRow(t, dueIso) {
  const due = dueIso !== undefined ? dueIso : localDateOf(t.due);
  const today = todayStr();
  const overdue = !!due && !t.done && due < today;
  const isToday = !!due && !t.done && due === today;
  const cls = ['todo', t.done ? 'done' : '', overdue ? 'overdue' : '',
    isToday ? 'due-today' : (due && !t.done ? 'due-soon' : '')].filter(Boolean).join(' ');
  const dot = `<span class="src-dot" style="background:${SOURCE_COLORS[t.source] || SOURCE_COLORS.manual}" title="${esc(t.source || 'manual')}"></span>`;
  const course = t.course ? `<span class="course-tag">${esc(t.course)}</span>` : '';
  const loc = t.location ? `<span class="todo-loc" title="${esc(t.location)}">&#128205; ${esc(t.location)}</span>` : '';
  const pomo = t.pomodoros ? `<span class="todo-pomo" title="${t.pomodoros} pomodoro${t.pomodoros === 1 ? '' : 's'} completed">&#127813; ${t.pomodoros}</span>` : '';
  const meta = due ? `<span class="todo-meta">${esc(formatDue(t.due, t.time))}</span>` : '';
  const sub = (loc || course || pomo || meta) ? `<span class="todo-sub">${loc}${course}${pomo}${meta}</span>` : '';
  const summary = taskSummary(t.id);
  const summaryHtml = summary ? `<span class="todo-summary">${esc(summary)}</span>` : '';
  return `
    <li class="${cls}">
      ${dot}
      <input type="checkbox" data-action="toggle" data-id="${t.id}" ${t.done ? 'checked' : ''} />
      <span class="todo-body">
        <span class="todo-text clickable" data-action="open-todo" data-id="${t.id}" title="${esc(t.title)}">${esc(t.title)}</span>
        ${summaryHtml}
        ${sub}
      </span>
      <button class="del" data-action="delete-todo" data-id="${t.id}" title="Delete">&#10005;</button>
    </li>`;
}

function renderTodos() {
  const windowDays = Math.max(1, Math.min(14, Number(store.settings.deadlineWindowDays) || 2));
  const today = todayStr();
  const windowEnd = toISODate(addDays(new Date(), windowDays));

  const all = activeTodos();
  const notDone = all.filter((t) => !t.done);
  const withDue = notDone.map((t) => ({ t, due: localDateOf(t.due) })).filter((x) => x.due);
  const byDueTime = (a, b) => (`${a.due} ${a.t.time || ''}`).localeCompare(`${b.due} ${b.t.time || ''}`);

  const overdue = withDue.filter((x) => x.due < today).sort(byDueTime);       // Overdue line
  const dueToday = withDue.filter((x) => x.due === today).sort(byDueTime);    // Today
  const inWindow = withDue.filter((x) => x.due > today && x.due <= windowEnd).sort(byDueTime);
  const later = withDue.filter((x) => x.due > windowEnd).sort(byDueTime);

  // Requested diagnostics: what is considered, what passes each filter, and today.
  const countSrc = (src) => all.filter((t) => t.source === src).length;
  console.log(`[todos] today=${today} window=+${windowDays}d (through ${windowEnd}) | ` +
    `canvas=${countSrc('canvas')} manual=${countSrc('manual')} | active=${all.length} ` +
    `notDone=${notDone.length} withDue=${withDue.length} | overdue=${overdue.length} ` +
    `today=${dueToday.length} upcoming=${inWindow.length} later=${later.length} ` +
    `done=${all.filter((t) => t.done).length}`);

  const todayItems = [...overdue, ...dueToday];
  if (!todayItems.length) {
    setHTML('today-list', '<li class="empty-note">Nothing due today.</li>');
  } else {
    const parts = [];
    if (overdue.length) parts.push('<li class="list-note">Overdue</li>', ...overdue.map((x) => todoRow(x.t, x.due)));
    if (dueToday.length) parts.push(...dueToday.map((x) => todoRow(x.t, x.due)));
    setHTML('today-list', parts.join(''));
  }

  if (inWindow.length) {
    setHTML('upcoming-list', inWindow.map((x) => todoRow(x.t, x.due)).join(''));
  } else {
    const days = `${windowDays} day${windowDays === 1 ? '' : 's'}`;
    const note = `<li class="empty-note">Nothing due in the next ${days}.</li>`;
    const nextOne = later[0];
    setHTML('upcoming-list', note + (nextOne
      ? `<li class="empty-note">Next up:</li>${todoRow(nextOne.t, nextOne.due)}`
      : ''));
  }

  const allSorted = [...all].sort((a, b) =>
    (a.done - b.done) || (`${localDateOf(a.due)} ${a.time || ''}`).localeCompare(`${localDateOf(b.due)} ${b.time || ''}`));
  setHTML('all-list',
    allSorted.length ? allSorted.map((t) => todoRow(t, localDateOf(t.due))).join('') : '<li class="empty-note">No tasks yet. Add one below.</li>');

  // Keep the Focus view's "Focus on" picker in step with the shared tasks.
  if (typeof focusRefreshPicker === 'function') focusRefreshPicker();
}

// Mark a task done/undone. Canvas items exist as BOTH a to-do and a calendar
// event under the same dedupeKey, so mirror the flag to keep them in step.
function setTaskDone(id, done) {
  const t = store.todos.find((x) => x.id === id);
  if (!t) return;
  t.done = done;
  if (t.dedupeKey) {
    const ev = store.events.find((e) => e.dedupeKey === t.dedupeKey);
    if (ev) ev.done = done;
  }
  save();
  renderTodos();       // also repaints Focus
  renderCalendar();
}

// ---------------------------------------------------------------------------
// 4b. Emails
// ---------------------------------------------------------------------------
function emailRow(e) {
  const events = e.events || (e.event ? [e.event] : []);
  const marker = events.length
    ? `<span class="email-event">&#128197; ${esc(formatDue(events[0].start))}${events.length > 1 ? ' +' + (events.length - 1) : ''}</span>`
    : '';
  return `
    <li class="email" data-action="open-email" data-url="${esc(e.link || '')}" title="${esc(e.subject)}">
      <span class="email-from">${esc(e.from)}</span>
      <span class="email-subject">${esc(e.subject)}</span>
      ${marker}
    </li>`;
}

function renderEmails() {
  const list = store.emails || [];
  const compactHTML = list.length
    ? list.slice(0, 3).map(emailRow).join('')
    : '<li class="empty-note">No matching emails.</li>';
  const fullHTML = list.length
    ? list.map(emailRow).join('')
    : '<li class="empty-note">No matching emails. Connect Gmail in Settings.</li>';

  setHTML('email-list-compact', compactHTML);
  setHTML('email-list', fullHTML);
}

function discordRow(m) {
  const marker = m.event ? `<span class="discord-event">&#128197; ${esc(formatDue(m.event.start))}</span>` : '';
  return `
    <li class="discord">
      <span class="discord-author">${esc(m.author)}</span>
      <span class="discord-text" title="${esc(m.content)}">${esc(m.content)}</span>
      ${marker}
    </li>`;
}

function renderDiscord() {
  const list = store.discord || [];
  const compactHTML = list.length
    ? list.slice(0, 2).map(discordRow).join('')
    : '<li class="empty-note">No Discord messages.</li>';
  const fullHTML = list.length
    ? list.map(discordRow).join('')
    : '<li class="empty-note">No Discord messages. Connect a channel in Settings.</li>';

  setHTML('discord-list-compact', compactHTML);
  setHTML('discord-list', fullHTML);
}

// ---------------------------------------------------------------------------
// 4c. Links & details (saved links, category filter, deadline -> manual event)
// ---------------------------------------------------------------------------
const LINK_CATEGORIES = ['Internship', 'MESA', 'Scholarship', 'School', 'Other'];
let linkFilter = 'All';   // active category chip ('All' or one of LINK_CATEGORIES)

// Small local URL finder (the Node module titles.js is not available here).
function extractUrlsLocal(text, limit = 10) {
  const re = /https?:\/\/[^\s"'<>()\]]+/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js)(\?|$)/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url); out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

function activeLinks() { return (store.links || []); }

// Keep a link's deadline and its Manual calendar event in step.
function syncLinkEvent(link) {
  const existing = (store.events || []).find((e) => e.linkId === link.id);
  if (link.deadline) {
    if (existing) {
      existing.title = link.title;
      existing.start = link.deadline;
      existing.notes = link.notes || '';
      existing.status = 'active';
    } else {
      store.events.push({
        id: uid(), title: link.title, start: link.deadline, time: '',
        source: 'manual', linkId: link.id, dedupeKey: null, location: '', notes: link.notes || ''
      });
    }
  } else if (existing) {
    store.events = store.events.filter((e) => e.linkId !== link.id);
  }
}

function renderLinks() {
  // Category chips (All first).
  const cats = ['All', ...LINK_CATEGORIES];
  setHTML('link-chips', cats.map((c) =>
    `<button class="chip ${linkFilter === c ? 'active' : ''}" data-action="filter-links" data-cat="${esc(c)}">${esc(c)}</button>`
  ).join(''));

  const items = activeLinks().filter((l) => linkFilter === 'All' || l.category === linkFilter);
  setHTML('link-list', items.length ? items.map((l) => {
    const bits = [l.category];
    if (l.deadline) bits.push(`&#128197; ${esc(formatDue(l.deadline))}`);
    if (l.notes) bits.push(esc(l.notes));
    if (l.addedAt) bits.push(`added ${esc(new Date(l.addedAt).toLocaleDateString())}`);
    return `
      <li class="link-item" data-action="open-link" data-url="${esc(l.url)}" data-id="${l.id}" title="${esc(l.url)}">
        <span class="link-main">
          <span class="link-title">${esc(l.title || l.url)}</span>
          <span class="link-url">${esc(l.url)}</span>
          <span class="link-meta">${bits.join(' &middot; ')}</span>
        </span>
        <button class="btn small" data-action="edit-link" data-id="${l.id}" title="Edit">&#9998;</button>
        <button class="del" data-action="delete-link" data-id="${l.id}" title="Delete">&#10005;</button>
      </li>`;
  }).join('') : '<li class="empty-note">No saved links yet. Click "+ Add link", or use "Save to Links" on an event or email.</li>');
}

// Save one or more links gathered from an event or an email.
function addLinksFromExternal({ title, urls, category = 'Other', notes = '' }) {
  const list = (urls || []).map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u));
  const unique = [...new Set(list)];
  if (!unique.length) { showToast('No links to save', null); return 0; }
  for (const url of unique) {
    store.links.push({
      id: uid(), title: title || url, url, category,
      notes, deadline: '', addedAt: new Date().toISOString()
    });
  }
  save();
  renderLinks();
  showToast(`Saved ${unique.length} link${unique.length === 1 ? '' : 's'} to Links`, null);
  return unique.length;
}

// "Save to Links" on the event details panel (source link + URLs in the notes).
function savePanelToLinks() {
  const item = panelItem();
  if (!item) return;
  const urls = [];
  if (item.url) urls.push(item.url);
  if (item.source === 'gmail' && item.messageId) urls.push(`https://mail.google.com/mail/u/0/#all/${item.messageId}`);
  for (const u of extractUrlsLocal(item.description || '')) if (!urls.includes(u)) urls.push(u);
  for (const u of extractUrlsLocal(item.notes || '')) if (!urls.includes(u)) urls.push(u);
  addLinksFromExternal({ title: item.title || 'Saved link', urls, category: 'Other', notes: `From ${SOURCE_LABELS[item.source] || item.source || 'event'}` });
}

// "Save to Links" on a Gmail preview row.
function saveRowToLinks(key) {
  const pv = store.settings.gmailPreview;
  if (!pv) return;
  const row = (pv.rows || []).find((r) => r.key === key);
  if (!row) return;
  const urls = (row.links && row.links.length) ? row.links : [row.link].filter(Boolean);
  addLinksFromExternal({ title: row.subject || 'Email link', urls, category: 'Other', notes: `From ${row.sender || 'email'}` });
}

// --- Link add / edit modal ---
let editingLinkId = null;
const linkModal = document.getElementById('link-modal');

function openLinkModal(id) {
  editingLinkId = id || null;
  const titleEl = el('lm-title');
  const urlEl = el('lm-url');
  const catEl = el('lm-category');
  const notesEl = el('lm-notes');
  const dateEl = el('lm-deadline');
  if (editingLinkId) {
    const l = activeLinks().find((x) => x.id === editingLinkId);
    if (!l) return;
    setText('link-modal-title', 'Edit link');
    if (titleEl) titleEl.value = l.title || '';
    if (urlEl) urlEl.value = l.url || '';
    if (catEl) catEl.value = LINK_CATEGORIES.includes(l.category) ? l.category : 'Other';
    if (notesEl) notesEl.value = l.notes || '';
    if (dateEl) dateEl.value = l.deadline || '';
    toggleHidden('lm-delete', false);
  } else {
    setText('link-modal-title', 'Add link');
    if (titleEl) titleEl.value = '';
    if (urlEl) urlEl.value = '';
    if (catEl) catEl.value = 'Internship';
    if (notesEl) notesEl.value = '';
    if (dateEl) dateEl.value = '';
    toggleHidden('lm-delete', true);
  }
  if (linkModal) linkModal.classList.remove('hidden');
  if (titleEl) titleEl.focus();
}
function closeLinkModal() { if (linkModal) linkModal.classList.add('hidden'); editingLinkId = null; }

function saveLinkFromModal() {
  const title = (el('lm-title') ? el('lm-title').value.trim() : '') || '';
  const url = (el('lm-url') ? el('lm-url').value.trim() : '');
  const category = (el('lm-category') ? el('lm-category').value : 'Other') || 'Other';
  const notes = (el('lm-notes') ? el('lm-notes').value : '');
  const deadline = (el('lm-deadline') ? el('lm-deadline').value : '');
  if (!/^https?:\/\//i.test(url)) {
    showToast('Enter a URL that starts with http:// or https://', null);
    if (el('lm-url')) el('lm-url').focus();
    return;
  }
  if (editingLinkId) {
    const l = activeLinks().find((x) => x.id === editingLinkId);
    if (l) { l.title = title || url; l.url = url; l.category = category; l.notes = notes; l.deadline = deadline; syncLinkEvent(l); }
  } else {
    const link = { id: uid(), title: title || url, url, category, notes, deadline, addedAt: new Date().toISOString() };
    store.links.push(link);
    syncLinkEvent(link);
  }
  save();
  renderLinks();
  renderCalendar();
  closeLinkModal();
}

function deleteLink(id) {
  const l = activeLinks().find((x) => x.id === id);
  if (!l) return;
  store.links = store.links.filter((x) => x.id !== id);
  store.events = store.events.filter((e) => e.linkId !== id);
  save();
  renderLinks();
  renderCalendar();
  closeLinkModal();
  showToast('Link deleted', null);
}

// ---------------------------------------------------------------------------
// 4d. Learned relevance filter (labels, training, score display)
// ---------------------------------------------------------------------------
// The heavy parts (sentence embeddings + the classifier) live in ml.js and run
// in the MAIN process. This side only:
//   - turns your actions into labelled examples (store.mlExamples)
//   - asks the main process to (re)train in the background
//   - maps the score the pipeline attached to each item onto a status
//   - shows the score/reason and the "Filtered out" list
let mlState = { modelReady: false, trainedOn: 0, accuracy: null, heldOut: 0, training: false, coldStart: 40 };

function mlEnabled() { return !!(store.settings.ml && store.settings.ml.enabled); }

// The text a Gmail item is judged on: subject + the section text it came from.
// Older items have no mlText yet, so fall back to the readable fields.
function mlTextFor(item) {
  if (!item) return '';
  if (item.mlText) return String(item.mlText).trim().slice(0, 600);
  const mail = (store.emails || []).find((e) => e && e.uid === item.messageId);
  const subject = mail ? mail.subject : '';
  return [subject, item.title, item.sourceQuote, item.description, item.sender]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

// Record (or flip) a label for one Gmail item. useful=true -> 1, false -> 0.
// Returns true when something actually changed.
function mlLabel(item, useful) {
  if (!item || item.source !== 'gmail') return false;
  const key = String(item.dedupeKey || item.messageId || item.id || '');
  if (!key) return false;
  const text = mlTextFor(item);
  if (!text) return false;
  store.mlExamples = store.mlExamples || [];
  const label = useful ? 1 : 0;
  const i = store.mlExamples.findIndex((x) => x.key === key);
  if (i >= 0) {
    if (store.mlExamples[i].label === label) return false;   // nothing new to learn
    store.mlExamples[i] = { ...store.mlExamples[i], text, label, at: new Date().toISOString() };
  } else {
    store.mlExamples.push({ key, text, label, source: 'gmail', at: new Date().toISOString() });
  }
  mlAskTrain();
  return true;
}

// Fire-and-forget: the main process decides whether a retrain is due. Never
// blocks the UI (the training runs on the other side of the IPC bridge).
function mlAskTrain(force = false) {
  if (!mlEnabled()) return;
  window.widgetAPI.mlTrain(store.mlExamples || [], force)
    .then((st) => { if (st) { mlState = st; renderMlStatus(); } })
    .catch(() => {});
}

async function mlRefreshStatus() {
  try { mlState = await window.widgetAPI.mlStatus(); } catch { /* keep the old value */ }
  renderMlStatus();
}

// The one stats line in Settings: examples + the held-out accuracy (only when
// it is actually measurable).
function renderMlStatus() {
  const list = store.mlExamples || [];
  const n = list.length;
  const pos = list.filter((x) => x.label === 1).length;
  const neg = n - pos;
  const cs = mlState.coldStart || 40;
  const parts = [`${n} labelled example${n === 1 ? '' : 's'} (${pos} useful / ${neg} not)`];
  if (mlState.training) {
    parts.push('training\u2026');
  } else if (mlState.modelReady) {
    const acc = mlState.accuracy == null
      ? 'accuracy: needs both classes in the held-out 20%'
      : `accuracy on a held-out 20%: ${(mlState.accuracy * 100).toFixed(1)}%`;
    parts.push(`trained on ${mlState.trainedOn} example${mlState.trainedOn === 1 ? '' : 's'}`, acc);
  } else if (n < cs) {
    parts.push(`model not used yet \u2014 needs ${cs} labelled examples to start`);
  } else {
    parts.push('not trained yet');
  }
  if (mlState.embedder === 'error' || mlState.embedderError) {
    parts.push('on-device model unavailable, using rules only');
  }
  setText('ml-status-text', parts.join(' \u00b7 '));
}

// Map the class the pipeline attached to a parsed item onto a stored status.
// Returns null when the learned filter is off or gave no opinion.
function mlStatusFor(ev) {
  if (!mlEnabled() || !ev) return null;
  if (ev.mlClass === 'hidden') return 'filtered';
  if (ev.mlClass === 'suggested') return 'suggested';
  if (ev.mlClass === 'normal') return 'active';
  return null;
}

// Short "82% \u00b7 reason" text for the details panel ('' when unscored).
function mlScoreLabel(ev) {
  if (!ev || typeof ev.mlScore !== 'number') return '';
  const pct = Math.round(ev.mlScore * 100);
  return ev.mlReason ? `${pct}% \u00b7 ${ev.mlReason}` : `${pct}%`;
}

// One-time back-fill from the Gmail history already in the store:
// dismissed = not useful, done or kept (active) = useful. Gives the model a
// starting point without waiting for brand-new emails. Runs at most once.
function mlSeedFromHistory() {
  if (store.settings.ml && store.settings.ml.seeded) return 0;
  let added = 0;
  store.mlExamples = store.mlExamples || [];
  const have = new Set(store.mlExamples.map((x) => x.key));
  for (const ev of store.events || []) {
    if (ev.source !== 'gmail') continue;
    let label = null;
    if (ev.status === 'dismissed') label = 0;
    else if (ev.done) label = 1;
    else if (ev.status === 'active') label = 1;
    if (label === null) continue;                    // suggested / filtered = no decision yet
    const key = String(ev.dedupeKey || ev.messageId || ev.id || '');
    if (!key || have.has(key)) continue;
    const text = mlTextFor(ev);
    if (!text) continue;
    store.mlExamples.push({ key, text, label, source: 'gmail', at: new Date().toISOString() });
    have.add(key);
    added++;
  }
  store.settings.ml = { ...(store.settings.ml || {}), seeded: true };
  return added;
}

async function mlInit() {
  await mlRefreshStatus();
  if (!mlEnabled()) return;
  const added = mlSeedFromHistory();
  if (added) save();
  mlAskTrain();     // trains only if the seed crossed the cold-start line
}

// ---------------------------------------------------------------------------
// 5. Calendar
// ---------------------------------------------------------------------------
function toFCEvent(ev, opts = {}) {
  const color = SOURCE_COLORS[ev.source] || SOURCE_COLORS.manual;
  // The pale yellow manual chips need dark plum text; the others are fine white.
  const textColor = (ev.source === 'manual' || ev.source === 'agent') ? '#6b2d4f' : '#ffffff';
  const done = opts.done !== undefined ? opts.done : !!ev.done;
  return {
    id: opts.id || ev.id,
    title: ev.title,
    start: ev.time ? `${ev.start}T${ev.time}` : ev.start,
    allDay: !ev.time,
    backgroundColor: color,
    borderColor: color,
    textColor,
    classNames: done ? ['ev-done'] : [],
    extendedProps: {
      source: ev.source,
      done,
      location: ev.location || '',
      baseId: opts.baseId || ev.id,
      date: opts.date || ''
    }
  };
}

// Every event (and every generated recurrence occurrence) inside [from, to).
function eventsInRange(from, to) {
  const out = [];
  for (const e of activeEvents()) {
    const rec = e.recurrence;
    if (!rec || !rec.freq || rec.freq === 'none') {
      if (e.start >= from && e.start < to) out.push(toFCEvent(e));
      continue;
    }
    // Recurring: draw ONLY the occurrences that land in the visible window.
    // Recur.occurrences already drops removed dates and applies per-date edits.
    for (const occ of Recur.occurrences(e, from, to)) {
      out.push(toFCEvent(occ.view, { id: occ.view.id, done: occ.done, baseId: e.id, date: occ.date }));
    }
  }
  return out;
}

function initCalendar() {
  calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
    initialView: 'dayGridMonth',
    headerToolbar: { left: 'prev', center: 'title', right: 'next' },
    height: 'auto',
    dayMaxEvents: 2,          // at most 2 chips per day, then "+N more"
    fixedWeekCount: false,
    events: (info, success) => {
      const from = info.startStr.slice(0, 10);
      const to = info.endStr.slice(0, 10);
      success(eventsInRange(from, to));
      // Dots/count (compact mode) are painted onto the day cells after render.
      setTimeout(refreshDayDots, 0);
    },
    // Click an event chip -> details panel (location, times, source, actions).
    eventClick: (arg) => {
      arg.jsEvent.preventDefault();
      console.log('[ui] calendar eventClick', arg.event.id);
      openEventPanel(arg.event.id);
    },
    // "+N more" -> our own day list instead of FullCalendar's popover.
    moreLinkClick: (arg) => {
      // FullCalendar gives arg.date as UTC midnight of the cell's day. Reading it
      // in local time (e.g. Pacific) shows the PREVIOUS day, so use the UTC parts.
      const dateStr = arg.date.toISOString().slice(0, 10);
      console.log('[ui] more-link', dateStr);
      openDayList(dateStr);
      return false;
    },
    // Clicking a day number or the empty part of a cell -> day list panel.
    dateClick: (arg) => openDayList(arg.dateStr)
  });
  calendar.render();
  updateCalMode();
}

function renderCalendar() {
  if (!calendar) return;
  calendar.refetchEvents();
  setTimeout(refreshDayDots, 0);
}

// ---------------------------------------------------------------------------
// 5b. Compact calendar mode (narrow widget): dots + count instead of chips.
// ---------------------------------------------------------------------------
function isCompactCalWidth() { return window.innerWidth < 520; }

// How many events (incl. recurring occurrences) fall on one local date, and
// which sources they come from.
function daySummary(dateStr) {
  const next = Recur.toISO(Recur.addDays(Recur.parseISO(dateStr), 1));
  const list = eventsInRange(dateStr, next);
  const sources = [];
  for (const e of list) {
    const s = e.extendedProps.source || 'manual';
    if (!sources.includes(s)) sources.push(s);
  }
  return { count: list.length, sources };
}

// Paint (or clear) the dots+count on every visible day cell.
function refreshDayDots() {
  const compact = isCompactCalWidth();
  document.querySelectorAll('#calendar .fc-daygrid-day[data-date]').forEach((cell) => {
    let box = cell.querySelector('.cal-dots');
    if (!compact) { if (box) box.remove(); return; }
    const { count, sources } = daySummary(cell.getAttribute('data-date'));
    if (!box) {
      const frame = cell.querySelector('.fc-daygrid-day-frame') || cell;
      box = document.createElement('div');
      box.className = 'cal-dots';
      frame.appendChild(box);
    }
    box.innerHTML = count
      ? sources.map((s) => `<i class="cal-dot" style="background:${SOURCE_COLORS[s] || SOURCE_COLORS.manual}"></i>`).join('') +
        `<span class="cal-count">${count}</span>`
      : '';
  });
}

// Switch compact/normal based on the current width.
function updateCalMode() {
  const cal = document.getElementById('calendar');
  if (cal) cal.classList.toggle('cal-compact', isCompactCalWidth());
  refreshDayDots();
}

window.addEventListener('resize', updateCalMode);

// ---------------------------------------------------------------------------
// 6. Event modal
// ---------------------------------------------------------------------------
const modal = document.getElementById('modal');
const evTitle = document.getElementById('ev-title');
const evDate = document.getElementById('ev-date');
const evTime = document.getElementById('ev-time');
const evDelete = document.getElementById('ev-delete');
const evRepeat = document.getElementById('ev-repeat');
const evEnd = document.getElementById('ev-end');
const evUntil = document.getElementById('ev-until');
const evCount = document.getElementById('ev-count');

// Show/hide the pieces that only matter for a chosen repeat mode.
function syncRepeatVisibility() {
  const freq = evRepeat ? evRepeat.value : 'none';
  const repeating = freq !== 'none';
  toggleHidden('ev-weekdays', !(repeating && freq === 'weekly'));
  toggleHidden('ev-end-row', !repeating);
  const end = repeating ? (evEnd ? evEnd.value : 'never') : 'never';
  toggleHidden('ev-until-wrap', end !== 'on');
  toggleHidden('ev-count-wrap', end !== 'after');
}

// Read the repeats controls into a recurrence rule.
function readRecurrenceFromModal() {
  const freq = evRepeat ? evRepeat.value : 'none';
  if (freq === 'none') return { freq: 'none', weekdays: [], until: '', count: null };
  let weekdays = [...document.querySelectorAll('#ev-weekdays input:checked')].map((c) => Number(c.value));
  if (freq === 'weekly' && !weekdays.length) {
    // None ticked? Use the weekday of the start date ("every Monday at 3 PM").
    const d = parseISODate(evDate.value || todayStr());
    weekdays = [d.getDay()];
  }
  const end = evEnd ? evEnd.value : 'never';
  const until = end === 'on' ? (evUntil.value || '') : '';
  const count = end === 'after' ? Math.max(1, Number(evCount.value) || 1) : null;
  return { freq, weekdays, until, count };
}

// Is this event deletable here? (Manual ones yes; synced ones are re-created on sync.)
function openEventModal(dateStr, eventId) {
  editingEventId = eventId || null;

  if (editingEventId) {
    const ev = store.events.find((e) => e.id === editingEventId);
    if (!ev) return;
    setText('modal-title', ev.source === 'manual' ? 'Edit event' : 'Event details');
    evTitle.value = ev.title;
    evDate.value = ev.start;
    evTime.value = ev.time || '';
    // Only manual events can be deleted (synced ones come back on next sync).
    evDelete.classList.toggle('hidden', ev.source !== 'manual');
  } else {
    setText('modal-title', 'Add event');
    evTitle.value = '';
    evDate.value = dateStr || todayStr();
    evTime.value = '';
    evDelete.classList.add('hidden');
  }
  if (evRepeat) evRepeat.value = 'none';
  document.querySelectorAll('#ev-weekdays input').forEach((c) => { c.checked = false; });
  if (evEnd) evEnd.value = 'never';
  if (evUntil) evUntil.value = '';
  if (evCount) evCount.value = '10';
  syncRepeatVisibility();

  modal.classList.remove('hidden');
  evTitle.focus();
}

function closeModal() { modal.classList.add('hidden'); editingEventId = null; }

function saveEventFromModal() {
  const title = evTitle.value.trim();
  const date = evDate.value;
  const time = evTime.value;
  if (!title) { evTitle.focus(); return; }
  if (!date) { evDate.focus(); return; }

  if (editingEventId) {
    const ev = store.events.find((e) => e.id === editingEventId);
    if (ev) { ev.title = title; ev.start = date; ev.time = time; }
  } else {
    const rec = readRecurrenceFromModal();
    store.events.push({
      id: uid(), title, start: date, time, source: 'manual', dedupeKey: null,
      location: '', notes: '', url: '',
      recurrence: rec.freq === 'none' ? null : rec
    });
  }
  save();
  renderCalendar();
  closeModal();
}

function deleteEventFromModal() {
  if (!editingEventId) return;
  const ev = store.events.find((e) => e.id === editingEventId);
  closeModal();
  if (ev) dismissItem(ev, 'Event');
}

// ---------------------------------------------------------------------------
// 6b. Details panel (events + to-dos), day list, undo toast
// ---------------------------------------------------------------------------
const eventPanel = document.getElementById('event-modal');
const dayPanel = document.getElementById('day-modal');
let dayListDate = '';
const toastEl = document.getElementById('toast');

const SOURCE_LABELS = { manual: 'Manual', canvas: 'Canvas', gmail: 'Gmail', discord: 'Discord' };

function splitCSV(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function prettyDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function timeLabel(ev) {
  if (ev.allDay || !ev.time) return 'All day';
  return ev.endTime ? `${ev.time} \u2013 ${ev.endTime}` : ev.time;
}
// Does a sender match a blocklist pattern? ("a@b.c" exact, "b.c" domain)
function senderMatches(sender, pattern) {
  const p = String(pattern || '').trim().toLowerCase().replace(/^@/, '');
  const s = String(sender || '').trim().toLowerCase();
  if (!p || !s) return false;
  if (p.includes('@')) return s === p;
  const at = s.lastIndexOf('@');
  const dom = at >= 0 ? s.slice(at + 1) : '';
  return dom === p || dom.endsWith('.' + p);
}

let panelKind = 'event';   // 'event' | 'todo'
let panelOccurrence = null; // { baseId, date } when one occurrence is shown
let lastOpenedTaskId = null; // remembered for the Focus timer's auto-credit

// An occurrence id looks like "<baseId>@YYYY-MM-DD"; a plain event is just its id.
function parseEventId(id) {
  const at = String(id || '').indexOf('@');
  if (at < 0) return { baseId: id, date: null };
  return { baseId: id.slice(0, at), date: id.slice(at + 1) };
}

// "This event only" / "All events" chooser. Resolves 'one', 'all' or null.
let choiceResolve = null;
function askScope(title, text) {
  return new Promise((resolve) => {
    setText('choice-title', title);
    setText('choice-text', text);
    choiceResolve = resolve;
    const m = el('choice-modal');
    if (m) m.classList.remove('hidden');
  });
}
function closeChoice(value) {
  const m = el('choice-modal');
  if (m) m.classList.add('hidden');
  const r = choiceResolve;
  choiceResolve = null;
  if (r) r(value);
}

function openEventPanel(id) {
  const p = parseEventId(id);
  const base = store.events.find((e) => e.id === p.baseId);
  if (!base) return;
  panelKind = 'event';
  currentPanelId = id;
  panelOccurrence = p.date ? { baseId: p.baseId, date: p.date } : null;

  // Remember the paired task (if any) for the Focus timer's auto-credit.
  if (base.dedupeKey) {
    const paired = store.todos.find((t) => t.dedupeKey === base.dedupeKey);
    if (paired) lastOpenedTaskId = paired.id;
  }

  const ev = panelItem();
  if (!ev) return;

  setText('evm-title', ev.title || '(no title)');

  const recurring = base.recurrence && base.recurrence.freq && base.recurrence.freq !== 'none';
  const rows = [
    ['Date', prettyDate(ev.start)],
    ['Time', timeLabel(ev)],
    ['Location', ev.location],
    ['Repeats', recurring ? Recur.describe(base.recurrence) : ''],
    ['Source', SOURCE_LABELS[ev.source] || ev.source],
    ['Course', ev.course],
    ['Sender', ev.sender],
    // Learned-filter transparency: the score and a short reason (blank if the
    // filter is off or had no opinion on this item).
    ['Relevance', ev.source === 'gmail' ? mlScoreLabel(ev) : '']
  ].filter(([, v]) => v);
  setHTML('evm-meta', rows
    .map(([k, v]) => `<div class="meta-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
    .join(''));

  toggleHidden('evm-desc-wrap', !ev.description);
  setText('evm-desc', ev.description || '');

  toggleHidden('evm-notes-wrap', !ev.notes);
  setText('evm-notes', ev.notes || '');

  const openBtn = el('evm-open');
  if (openBtn) {
    openBtn.classList.toggle('hidden', !ev.url);
    openBtn.textContent = ev.source === 'gmail' ? 'Open in Gmail' : 'Open link';
    openBtn.dataset.url = ev.url || '';
  }

  // Save link only makes sense when there is something to save.
  const canSave = !!ev.url || (ev.source === 'gmail' && ev.messageId) ||
    extractUrlsLocal(ev.description || '').length || extractUrlsLocal(ev.notes || '').length;
  toggleHidden('evm-save-link', !canSave);

  setText('evm-done', occurrenceDone() ? 'Mark not done' : 'Mark done');
  toggleHidden('evm-block', !(ev.source === 'gmail' && ev.sender));

  showDetailsMode();
  fillEditForm(ev);
  if (eventPanel) eventPanel.classList.remove('hidden');
}

// Is the currently shown event (or occurrence) marked done?
function occurrenceDone() {
  const item = panelItem();
  if (!item) return false;
  if (panelKind === 'event' && panelOccurrence) {
    const base = store.events.find((e) => e.id === panelOccurrence.baseId);
    return !!(base && base.occurrencesDone && base.occurrencesDone[panelOccurrence.date]);
  }
  return !!item.done;
}

function openTodoPanel(id) {
  const t = store.todos.find((x) => x.id === id);
  if (!t) return;
  panelKind = 'todo';
  currentPanelId = id;
  panelOccurrence = null;
  lastOpenedTaskId = id;   // Focus timer auto-credit target

  setText('evm-title', t.title || '(no title)');
  const rows = [
    ['Due', t.due ? prettyDate(t.due) : 'No due date'],
    ['Source', SOURCE_LABELS[t.source] || t.source],
    ['Course', t.course],
    ['Sender', t.sender]
  ].filter(([, v]) => v);
  setHTML('evm-meta', rows
    .map(([k, v]) => `<div class="meta-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
    .join(''));

  toggleHidden('evm-desc-wrap', true);

  toggleHidden('evm-notes-wrap', !t.notes);
  setText('evm-notes', t.notes || '');

  toggleHidden('evm-open', true);
  toggleHidden('evm-save-link', true);
  setText('evm-done', t.done ? 'Mark not done' : 'Mark done');
  toggleHidden('evm-block', true);

  showDetailsMode();
  fillEditForm(t);
  if (eventPanel) eventPanel.classList.remove('hidden');
}

function panelItem() {
  if (panelKind === 'todo') return store.todos.find((x) => x.id === currentPanelId);
  if (panelOccurrence) {
    const base = store.events.find((e) => e.id === panelOccurrence.baseId);
    if (!base) return null;
    const ex = (base.exceptions && base.exceptions[panelOccurrence.date]) || null;
    return { ...base, ...(ex || {}), start: panelOccurrence.date, id: currentPanelId };
  }
  return store.events.find((x) => x.id === currentPanelId);
}
let currentPanelId = null;
function panelItemId() { return currentPanelId; }

function showDetailsMode() {
  toggleHidden('evm-view', false);
  toggleHidden('evm-editview', true);
}
// Stub: filter fields are the f-* inputs in Settings; nothing extra to render.
function renderFilterFields() { /* no-op (inputs already reflect settings) */ }

function fillEditForm(item) {
  const t = el('ee-title'); if (t) t.value = item.title || '';
  const d = el('ee-date'); if (d) d.value = item.start || item.due || '';
  const ti = el('ee-time'); if (ti) ti.value = item.time || '';
  const et = el('ee-endtime'); if (et) et.value = item.endTime || '';
  const loc = el('ee-location'); if (loc) loc.value = item.location || '';
  const url = el('ee-url'); if (url) url.value = item.url || '';
  const n = el('ee-notes'); if (n) n.value = item.notes || '';
}

// Read the shared edit form into a fields object.
function editFormFields() {
  const fields = {};
  const titleEl = el('ee-title'); if (titleEl) fields.title = titleEl.value.trim();
  const dEl = el('ee-date'); if (dEl && dEl.value) fields.start = dEl.value;
  const timeEl = el('ee-time'); if (timeEl) fields.time = timeEl.value;
  const endEl = el('ee-endtime'); if (endEl) fields.endTime = endEl.value;
  const locEl = el('ee-location'); if (locEl) fields.location = locEl.value.trim();
  const urlEl = el('ee-url'); if (urlEl) fields.url = urlEl.value.trim();
  const notesEl = el('ee-notes'); if (notesEl) fields.notes = notesEl.value;
  return fields;
}

// Write fields onto an event; for synced events also remember them as overrides
// so a re-sync can not wipe the change.
function applyEventEdit(base, fields) {
  for (const k of Object.keys(fields)) {
    if (k === 'title' && !fields[k]) continue;     // never blank a title
    base[k] = fields[k];
  }
  if (base.source !== 'manual' && base.dedupeKey) {
    store.overrides = store.overrides || {};
    store.overrides[base.dedupeKey] = { ...(store.overrides[base.dedupeKey] || {}), ...fields };
  }
}

async function saveEditForm() {
  // --- To-do ---
  if (panelKind === 'todo') {
    const item = panelItem();
    if (!item) { hideEventPanel(); return; }
    const f = editFormFields();
    if (f.title) item.title = f.title;
    if (f.start) item.due = f.start;
    if (f.location !== undefined) item.location = f.location;
    if (f.notes !== undefined) item.notes = f.notes;
    save();
    renderCalendar(); renderTodos(); renderSettingsLists();
    showDetailsMode();
    openTodoPanel(item.id);
    return;
  }

  // --- Event ---
  const baseId = panelOccurrence ? panelOccurrence.baseId : parseEventId(currentPanelId).baseId;
  const base = store.events.find((e) => e.id === baseId);
  if (!base) { hideEventPanel(); return; }
  const f = editFormFields();
  const recurring = base.recurrence && base.recurrence.freq && base.recurrence.freq !== 'none';

  if (panelOccurrence && recurring) {
    const scope = await askScope('Edit recurring event', 'Apply this change to just this date, or to every occurrence?');
    if (!scope) return;
    if (scope === 'one') {
      // Store an exception for this date only (its own start date is implicit).
      const cur = (base.exceptions && base.exceptions[panelOccurrence.date]) || {};
      const ex = { ...cur, ...f };
      delete ex.start;
      base.exceptions = base.exceptions || {};
      base.exceptions[panelOccurrence.date] = ex;
    } else {
      applyEventEdit(base, f);
    }
  } else {
    applyEventEdit(base, f);
  }

  save();
  renderCalendar(); renderTodos(); renderSettingsLists();
  showDetailsMode();
  openEventPanel(currentPanelId);
}

function hideEventPanel() {
  if (eventPanel) eventPanel.classList.add('hidden');
  currentPanelId = null;
  panelOccurrence = null;
}

// --- Mark done (a single occurrence keeps its own done flag) ---
function togglePanelDone() {
  if (panelKind === 'event' && panelOccurrence) {
    const base = store.events.find((e) => e.id === panelOccurrence.baseId);
    if (!base) return;
    base.occurrencesDone = base.occurrencesDone || {};
    const d = panelOccurrence.date;
    if (base.occurrencesDone[d]) delete base.occurrencesDone[d];
    else base.occurrencesDone[d] = true;
    save();
    renderCalendar(); renderTodos();
    openEventPanel(currentPanelId);
    return;
  }
  const item = panelItem();
  if (!item) return;
  item.done = !item.done;
  // Mirror to the paired to-do/event (Canvas items exist as both).
  if (item.dedupeKey) {
    const other = (panelKind === 'event' ? store.todos : store.events).find((x) => x.dedupeKey === item.dedupeKey);
    if (other) other.done = item.done;
  }
  // Marking an item done is a "useful" label for the learned filter.
  if (item.done) mlLabel(item, true);
  save();
  renderCalendar(); renderTodos();
  if (panelKind === 'event') openEventPanel(item.id); else openTodoPanel(item.id);
}

// --- Delete = move to 'dismissed' (kept as a tombstone) + 5-second Undo toast ---
// Applies to every event and task, manual or synced. Dismissed items are hidden
// everywhere and listed under Settings > Dismissed, where they can be restored.
function refreshAll() {
  renderCalendar(); renderTodos(); renderSettingsLists();
}

function dismissItem(item, label) {
  const prev = { status: item.status, dismissedAt: item.dismissedAt };
  item.status = 'dismissed';
  item.dismissedAt = new Date().toISOString();
  // Deleting/dismissing is a "not useful" label for the learned filter.
  const learned = mlLabel(item, false);
  save();
  refreshAll();
  hideEventPanel();
  showToast(`${label} deleted`, () => {
    item.status = prev.status;
    item.dismissedAt = prev.dismissedAt;
    if (learned) mlLabel(item, true);      // undoing a delete means keep it
    save();
    refreshAll();
  });
}

async function deleteFromPanel() {
  // A single occurrence of a recurring event: ask before touching the series.
  if (panelKind === 'event' && panelOccurrence) {
    const base = store.events.find((e) => e.id === panelOccurrence.baseId);
    if (!base) return;
    const recurring = base.recurrence && base.recurrence.freq && base.recurrence.freq !== 'none';
    if (recurring) {
      const scope = await askScope('Delete recurring event', 'Remove only this date, or delete the whole series?');
      if (!scope) return;
      if (scope === 'one') {
        base.exceptions = base.exceptions || {};
        base.exceptions[panelOccurrence.date] = { ...(base.exceptions[panelOccurrence.date] || {}), cancelled: true };
        if (base.occurrencesDone) delete base.occurrencesDone[panelOccurrence.date];
        save();
        renderCalendar(); renderTodos();
        hideEventPanel();
        showToast('One occurrence removed', null);
        return;
      }
      hideEventPanel();
      dismissItem(base, 'Event');
      return;
    }
  }
  const item = panelItem();
  if (!item) return;
  console.log('[ui] delete', panelKind, item.id);
  dismissItem(item, panelKind === 'todo' ? 'Task' : 'Event');
}

// --- Block a Gmail sender ---
function blockThisSender() {
  const item = panelItem();
  if (!item || !item.sender) return;
  const email = item.sender;
  const blocked = splitCSV(store.settings.gmail.blockedSenders);
  if (!blocked.includes(email)) blocked.push(email);
  store.settings.gmail.blockedSenders = blocked.join(', ');
  let n = 0;
  for (const ev of store.events) {
    if (ev.source === 'gmail' && senderMatches(ev.sender, email)) {
      ev.status = 'dismissed';
      ev.dismissedAt = new Date().toISOString();
      mlLabel(ev, false);                 // blocking a sender = not useful
      n++;
    }
  }
  save();
  renderCalendar(); renderEmails(); renderTodos(); renderSettingsLists(); renderFilterFields();
  hideEventPanel();
  showToast(`Blocked ${email} \u00B7 ${n} event(s) dismissed`, null);
}

// --- Day list (the "+N more" link) ---
function openDayList(date) {
  const dateStr = typeof date === 'string' ? date : toISODate(date);
  dayListDate = dateStr;
  setText('day-title', prettyDate(dateStr));
  const next = Recur.toISO(Recur.addDays(Recur.parseISO(dateStr), 1));
  const events = [];
  for (const e of activeEvents()) {
    const rec = e.recurrence;
    if (!rec || !rec.freq || rec.freq === 'none') {
      if (e.start === dateStr) events.push(e);
    } else {
      for (const occ of Recur.occurrences(e, dateStr, next)) events.push(occ.view);
    }
  }
  events.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  setHTML('day-list', events.length ? events.map((e) => `
    <li><button class="day-item" data-action="open-event" data-id="${e.id}">
      <span class="src-dot" style="background:${SOURCE_COLORS[e.source] || SOURCE_COLORS.manual}"></span>
      <span class="di-time">${esc(timeLabel(e))}</span>
      <span class="di-title" title="${esc(e.title)}">${esc(e.title)}</span>
    </button></li>`).join('') : '<li class="empty-note">No events.</li>');
  if (dayPanel) dayPanel.classList.remove('hidden');
}

// --- Toast ---
let toastTimer = null;
let toastUndo = null;
function showToast(msg, undoFn) {
  setText('toast-msg', msg);
  toastUndo = undoFn || null;
  toggleHidden('toast-undo', !toastUndo);
  if (toastEl) toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (toastEl) toastEl.classList.add('hidden'); }, 5000);
}

// ---------------------------------------------------------------------------
// 6c. Settings lists: Suggested / Dismissed / Gmail cleanup review
// ---------------------------------------------------------------------------
function setEventStatus(id, status) {
  const ev = store.events.find((e) => e.id === id);
  if (!ev) return;
  ev.status = status;
  if (status === 'active') delete ev.dismissedAt;
  else ev.dismissedAt = new Date().toISOString();
  // Teach the learned filter from the decision you just made.
  if (status === 'active') mlLabel(ev, true);
  else if (status === 'dismissed') mlLabel(ev, false);
  save();
  renderCalendar(); renderTodos(); renderSettingsLists();
}

function restoreItem(id, kind) {
  const item = (kind === 'todo' ? store.todos : store.events).find((x) => x.id === id);
  if (!item) return;
  item.status = 'active';
  delete item.dismissedAt;
  // Restoring (from "Dismissed" or "Filtered out") counts as a useful label.
  mlLabel(item, true);
  save();
  renderCalendar(); renderTodos(); renderSettingsLists();
}

function renderSettingsLists() {
  // --- Suggested (non-trusted senders, the learned filter, or AI) ---
  const sug = store.events.filter((e) => e.status === 'suggested');
  setHTML('suggested-list', sug.length ? sug.map((e) => `
    <li class="mini-item">
      <span class="mi-dot" style="background:${SOURCE_COLORS[e.source] || SOURCE_COLORS.manual}"></span>
      <span class="mi-text" title="${esc(e.title)}${e.mlReason ? ' \u2014 ' + esc(e.mlReason) : ''}">${esc(e.title)} &middot; ${esc(formatDue(e.start))} &middot; ${esc(e.sender || '')}${e.mlReason ? ' &middot; ' + esc(e.mlReason) : ''}</span>
      <button class="btn small" data-action="accept-event" data-id="${e.id}">Accept</button>
      <button class="btn small" data-action="dismiss-event" data-id="${e.id}">Dismiss</button>
    </li>`).join('') : '<li class="empty-note">No suggested events.</li>');

  // --- Filtered out (hidden by the learned filter; restoring counts as a label) ---
  const filt = store.events.filter((e) => e.status === 'filtered');
  setHTML('filtered-list', filt.length ? filt.map((e) => `
    <li class="mini-item">
      <span class="mi-dot" style="background:${SOURCE_COLORS[e.source] || SOURCE_COLORS.manual}"></span>
      <span class="mi-text" title="${esc(e.title)}${e.mlReason ? ' \u2014 ' + esc(e.mlReason) : ''}">${esc(e.title)} &middot; ${esc(formatDue(e.start))}${typeof e.mlScore === 'number' ? ' &middot; ' + Math.round(e.mlScore * 100) + '%' : ''}${e.mlReason ? ' &middot; ' + esc(e.mlReason) : ''}</span>
      <button class="btn small" data-action="restore-item" data-id="${e.id}" data-kind="event">Restore</button>
    </li>`).join('') : '<li class="empty-note">Nothing filtered out.</li>');

  // --- Dismissed (tombstones you can restore) ---
  const dis = [
    ...store.events.filter((e) => e.status === 'dismissed').map((item) => ({ item, kind: 'event' })),
    ...store.todos.filter((t) => t.status === 'dismissed').map((item) => ({ item, kind: 'todo' }))
  ];
  setHTML('dismissed-list', dis.length ? dis.map(({ item, kind }) => `
    <li class="mini-item">
      <span class="mi-dot" style="background:${SOURCE_COLORS[item.source] || SOURCE_COLORS.manual}"></span>
      <span class="mi-text" title="${esc(item.title)}">${esc(item.title)} &middot; ${esc(formatDue(item.start || item.due))}</span>
      <button class="btn small" data-action="restore-item" data-id="${item.id}" data-kind="${kind}">Restore</button>
    </li>`).join('') : '<li class="empty-note">Nothing dismissed.</li>');
}

// --- Gmail re-sync preview (review before anything is created) ---
// settings.gmailPreview exists while a review is pending. While it exists,
// syncGmail() only refreshes the table; it does NOT create calendar events.
function renderCleanup() {
  const pv = store.settings.gmailPreview;
  const section = el('cleanup-section');
  if (!section) return;
  if (!pv) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  const rows = pv.rows || [];
  const willCreate = rows.filter((r) => r.willCreate).length;
  const trustedNone = rows.filter((r) => !r.willCreate && r.reason !== 'not a trusted sender').length;
  setText('cleanup-count',
    `Removed ${pv.removedOld || 0} old Gmail event(s). ${willCreate} row(s) will be created. ` +
    `${trustedNone} trusted email(s) produced no events (reasons below). ` +
    'Nothing is created until you click Apply.');

  // Order: rows to create, then trusted emails with no events, then untrusted.
  const rank = (r) => (r.willCreate ? 0 : r.reason === 'not a trusted sender' ? 2 : 1);
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b));

  setHTML('cleanup-list', sorted.length
    ? sorted.map((r) => {
      const useful = r.useful === null || r.useful === undefined ? '-' : (r.useful ? 'Yes' : 'No');
      return `
      <tr class="${rank(r) === 2 ? 'untrusted' : ''}">
        <td title="${esc(r.subject)}">${esc(r.subject)}</td>
        <td title="${esc(r.title)}">${esc(r.title)}</td>
        <td>${esc(r.date || '-')}</td>
        <td>${esc(r.time || '-')}</td>
        <td>${esc(r.parsedBy || 'rules')}</td>
        <td>${esc(r.category || '-')}</td>
        <td>${useful}</td>
        <td title="${esc(r.sourceQuote || '')}">${esc(r.sourceQuote || '-')}</td>
        <td class="${r.willCreate ? 'yes' : 'no'}" title="${esc(r.reason)}">${r.willCreate ? 'Yes' : 'No: ' + esc(r.reason)}</td>
        <td><button class="btn small" data-action="save-row-links" data-key="${esc(r.key)}" title="Save this email's links">+ Links</button></td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="10" class="empty-note">No matching Gmail emails.</td></tr>');
}

// Apply: create the rows marked willCreate. Nothing else changes.
function applyCleanup() {
  const pv = store.settings.gmailPreview;
  if (!pv) return;
  let created = 0;
  for (const row of (pv.rows || [])) {
    if (!row.willCreate || !row.event) continue;
    // Skip anything already present, including dismissed tombstones.
    if (store.events.some((e) => e.dedupeKey === row.event.dedupeKey)) continue;
    store.events.push({ id: uid(), done: false, notes: '', ...row.event });
    created++;
  }
  const removed = pv.removedOld || 0;
  delete store.settings.gmailPreview;
  addAiLinksFromEmails(store.emails);
  save();
  renderCalendar(); renderEmails(); renderSettingsLists(); renderCleanup();
  showToast(`Removed ${removed} old Gmail event(s) \u00B7 created ${created}`, null);
  return { removed, created };
}

function cancelCleanup() {
  delete store.settings.gmailPreview;
  save();
  renderCleanup();
  showToast('Preview cancelled \u00B7 no events created', null);
}

// ---------------------------------------------------------------------------
// 7. Canvas sync + merge (dedupe by uid)
// ---------------------------------------------------------------------------

// Merge synced Canvas items into events + todos without creating duplicates.
// The actual work is done by Sync.mergeItems (see sync.js).
function mergeCanvas(items) {
  Sync.mergeItems(store, 'canvas', items);
}

// Short slug used to build stable dedupe keys.
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Turn emails/dates into calendar events.
// Dedupe key = "gmail:<message-id>:<date>:<time>:<title>". Including the message
// id keeps each day's newsletter separate, and the date/title keeps the several
// events inside one newsletter distinct.
//
// Only auto-managed Gmail events (SUGGESTED / FILTERED) that are no longer
// detected get pruned (filters changed). ACTIVE (accepted) and DISMISSED
// (tombstones) events are always kept.
function mergeGmailEvents(emails) {
  const items = [];
  for (const e of (emails || [])) {
    const events = e.events || (e.event ? [e.event] : []);
    for (const ev of events) {
      if (ev.useful === false || ev.status === 'skipped') continue;   // AI said skip
      const uid = `${e.uid}:${ev.start}:${ev.time || 'allday'}:${slugify(ev.title || e.subject)}`;
      // When the learned filter is on it decides the status from its score;
      // otherwise the rule/AI status is used exactly as before.
      const mlStatus = mlStatusFor(ev);
      const item = {
        uid,
        title: ev.title || e.subject,
        start: ev.start,
        time: ev.time,
        endTime: ev.endTime || '',
        location: ev.location || '',
        category: ev.category || '',
        sourceQuote: ev.sourceQuote || '',
        course: e.fromEmail,
        sender: e.fromEmail,
        messageId: e.uid,
        status: mlStatus || ev.status || e.status || 'active',
        mlText: ev.text || ''
      };
      if (typeof ev.mlScore === 'number') {
        item.mlScore = ev.mlScore;
        item.mlClass = ev.mlClass || '';
        item.mlReason = ev.mlReason || '';
      }
      items.push(item);
    }
  }
  const keep = new Set(items.map((i) => 'gmail:' + i.uid));
  // Only the auto-managed statuses ('suggested' / 'filtered') are pruned and
  // recreated on a sync. Accepted ('active') events and dismissed tombstones
  // are always kept.
  store.events = store.events.filter((ev) =>
    ev.source !== 'gmail' || (ev.status !== 'suggested' && ev.status !== 'filtered') || keep.has(ev.dedupeKey));
  Sync.mergeItems(store, 'gmail', items, { makeTodo: false });
}

// Put AI-extracted links into the Links section (deduped by url).
function addAiLinksFromEmails(emails) {
  let added = 0;
  for (const e of (emails || [])) {
    for (const l of (e.aiLinks || [])) {
      const url = String(l.url || '');
      if (!/^https?:\/\//i.test(url)) continue;
      if (store.links.some((x) => x.url === url)) continue;
      store.links.push({
        id: uid(), title: l.title || e.subject || url, url,
        category: l.category || 'Other', notes: `From ${e.fromEmail || 'email'}`,
        deadline: '', addedAt: new Date().toISOString()
      });
      added++;
    }
  }
  if (added) renderLinks();
  return added;
}

async function syncCanvas() {
  const res = await window.widgetAPI.canvasSync();
  if (!res.ok) { setStatus('Canvas: ' + res.error); return; }

  mergeCanvas(res.items);
  store.settings.canvas = { lastSync: new Date().toISOString(), count: res.items.length };
  save();
  renderTodos();
  renderCalendar();
  setStatus(`Canvas: ${res.items.length} items`);
}

async function syncGmail() {
  const filters = store.settings.gmail || {};
  const lcfg = store.settings.llm || {};
  const res = await window.widgetAPI.gmailFetch(filters, store.settings.processedMessageIds || null, {
    enabled: !!lcfg.enabled,
    model: lcfg.model || 'gemini-2.5-flash-lite',
    cache: store.llmCache || {}
  }, {
    // Heads-up only: the model and the examples stay in the main process.
    enabled: mlEnabled()
  });
  if (!res.ok) { setStatus('Gmail: ' + res.error); return; }
  // Remember which messages were processed, so the next sync skips them.
  if (res.cache) store.settings.processedMessageIds = res.cache;
  if (res.llmCache) store.llmCache = res.llmCache;
  store.emails = res.emails || [];
  if (store.settings.gmailPreview) {
    // Review pending: refresh the table only. Creating events waits for Apply.
    store.settings.gmailPreview.rows = res.preview || [];
    store.settings.gmailPreview.refreshedAt = new Date().toISOString();
  } else {
    mergeGmailEvents(store.emails);
    addAiLinksFromEmails(store.emails);
  }
  store.settings.gmailMeta = {
    lastSync: new Date().toISOString(), count: store.emails.length,
    ai: res.aiStats || null, ml: res.mlStats || null
  };
  save();
  renderEmails();
  renderCalendar();
  renderCleanup();
  if (res.aiStats && res.aiStats.limitReached) setStatus('AI limit reached, using basic parsing');
  else if (lcfg.enabled && res.aiHasKey === false) setStatus('AI sorting needs an API key');
}

// Discord messages that mention a date become purple calendar events.
function mergeDiscordEvents(messages) {
  const items = [];
  for (const m of (messages || [])) {
    if (!m.event) continue;
    items.push({ uid: m.uid, title: m.content, start: m.event.start, time: m.event.time, course: m.channelName });
  }
  const keep = new Set(items.map((i) => 'discord:' + i.uid));
  store.events = store.events.filter((ev) => ev.source !== 'discord' || keep.has(ev.dedupeKey));
  Sync.mergeItems(store, 'discord', items, { makeTodo: false });
}
async function syncDiscord() {
  const limit = (store.settings.discord || {}).limit || 25;
  const res = await window.widgetAPI.discordFetch(limit);
  if (!res.ok) { setStatus('Discord: ' + res.error); return; }
  store.discord = res.messages || [];
  mergeDiscordEvents(store.discord);
  store.settings.discordMeta = {
    lastSync: new Date().toISOString(),
    count: store.discord.length,
    emptyCount: res.emptyCount || 0
  };
  save();
  renderDiscord();
  renderCalendar();
  if (res.emptyCount > 0 && store.discord.length === 0) {
    setStatus('Discord: no text \u2014 enable Message Content Intent');
  }
}

async function removeDiscordItems() {
  Sync.removeSource(store, 'discord');
  store.discord = [];
  store.settings.discordMeta = {};
  save();
  renderDiscord();
  renderCalendar();
}

async function removeCanvasItems() {
  Sync.removeSource(store, 'canvas');
  store.settings.canvas = { lastSync: null, count: 0 };
  save();
  renderTodos();
  renderCalendar();
}

// ---------------------------------------------------------------------------
// 8. View / theme
// ---------------------------------------------------------------------------
function setView(mode) {
  currentView = mode;
  store.settings.viewMode = mode;

  document.getElementById('view-compact').classList.toggle('hidden', mode !== 'compact');
  document.getElementById('view-expanded').classList.toggle('hidden', mode !== 'expanded');
  const linksView = document.getElementById('view-links');
  if (linksView) linksView.classList.toggle('hidden', mode !== 'links');
  const focusView = document.getElementById('view-focus');
  if (focusView) focusView.classList.toggle('hidden', mode !== 'focus');
  const teamView = document.getElementById('view-team');
  if (teamView) teamView.classList.toggle('hidden', mode !== 'team');
  const brief = document.getElementById('morning-brief');
  if (brief) brief.classList.toggle('brief-suppressed', mode === 'focus' || mode === 'links');
  const teamBtn = document.getElementById('teamBtn');
  if (teamBtn) teamBtn.classList.toggle('active', mode === 'team');

  const toggle = document.getElementById('viewToggle');
  toggle.innerHTML = mode === 'expanded' ? '&#9636;' : '&#9638;';
  toggle.title = mode === 'expanded' ? 'Collapse to summary' : 'Expand to calendar';

  window.widgetAPI.setView(mode);
  save();
  if (mode === 'expanded' && calendar) setTimeout(() => { calendar.updateSize(); updateCalMode(); }, 60);
  if (mode === 'links') renderLinks();
  if (mode === 'focus') {
    if (typeof focusUpdateChip === 'function') focusUpdateChip();
    if (typeof focusRefreshPicker === 'function') focusRefreshPicker();
  }
  if (mode === 'team') renderTeam();
}

function applyTheme() {
  const mode = store.settings.theme || 'auto';
  const root = document.documentElement;
  root.classList.remove('theme-light', 'theme-dark');
  if (mode === 'light') root.classList.add('theme-light');
  if (mode === 'dark') root.classList.add('theme-dark');
  document.getElementById('theme').textContent = { auto: '\u{1F317}', light: '\u2600\uFE0F', dark: '\u{1F319}' }[mode];
}

// ---------------------------------------------------------------------------
// 9. Refresh / auto-refresh
// ---------------------------------------------------------------------------
async function refresh() {
  setStatus('Refreshing\u2026');
  await load();
  if (canvasConnected) await syncCanvas();
  if (gmailConnected) await syncGmail();
  if (discordConnected) await syncDiscord();
  if (!canvasConnected && !gmailConnected && !discordConnected) {
    renderTodos(); renderEmails(); renderDiscord(); renderCalendar();
  }
  setStatus('Updated ' + new Date().toLocaleTimeString());
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const mins = Math.max(1, Number(store.settings.refreshMinutes) || 15);
  refreshTimer = setInterval(refresh, mins * 60 * 1000);
}

// ---------------------------------------------------------------------------
// 10. Settings modal
// ---------------------------------------------------------------------------
const settingsModal = document.getElementById('settings-modal');
const canvasUrlInput = document.getElementById('canvas-url');
const canvasStatusEl = document.getElementById('canvas-status');
const canvasConnectBtn = document.getElementById('canvas-connect');
const canvasDisconnectBtn = document.getElementById('canvas-disconnect');
const refreshMinutesInput = document.getElementById('refresh-minutes');
const fDeadlineWindow = document.getElementById('f-deadline-window');
const llmEnabled = document.getElementById('llm-enabled');
const llmModel = document.getElementById('llm-model');
const llmKey = document.getElementById('llm-key');
const mlEnabledInput = document.getElementById('ml-enabled');
const timerWorkInput = document.getElementById('timer-work');
const timerBreakInput = document.getElementById('timer-break');
const timerNotifyInput = document.getElementById('timer-notify');
const timerSoundInput = document.getElementById('timer-sound');

const gmailClientId = document.getElementById('gmail-client-id');
const gmailClientSecret = document.getElementById('gmail-client-secret');
const gmailStatusEl = document.getElementById('gmail-status');
const gmailConnectBtn = document.getElementById('gmail-connect');
const gmailDisconnectBtn = document.getElementById('gmail-disconnect');
const fKeywords = document.getElementById('f-keywords');
const fExclude = document.getElementById('f-exclude');
const fSenders = document.getElementById('f-senders');
const fLabel = document.getElementById('f-label');
const fMax = document.getElementById('f-max');
const fDomains = document.getElementById('f-domains');
const fNames = document.getElementById('f-names');
const fTrusted = document.getElementById('f-trusted');
const fDays = document.getElementById('f-days');

const discordTokenInput = document.getElementById('discord-token');
const discordChannelInput = document.getElementById('discord-channel');
const discordStatusEl = document.getElementById('discord-status');
const discordConnectBtn = document.getElementById('discord-connect');
const discordDisconnectBtn = document.getElementById('discord-disconnect');

function updateCanvasUI() {
  if (canvasConnected) {
    const c = store.settings.canvas || {};
    const when = c.lastSync ? new Date(c.lastSync).toLocaleString() : 'not yet synced';
    canvasStatusEl.textContent = `Connected \u00B7 ${c.count || 0} items \u00B7 ${when}`;
    canvasConnectBtn.textContent = 'Reconnect';
    canvasDisconnectBtn.classList.remove('hidden');
    canvasUrlInput.placeholder = 'Leave blank to keep the current feed';
  } else {
    canvasStatusEl.textContent = 'Not connected.';
    canvasConnectBtn.textContent = 'Connect';
    canvasDisconnectBtn.classList.add('hidden');
  }
}

async function openSettings() {
  const st = await window.widgetAPI.canvasStatus();
  canvasConnected = st.connected;
  updateCanvasUI();

  const gst = await window.widgetAPI.gmailStatus();
  gmailConnected = gst.connected;
  gmailEmail = gst.email;
  updateGmailUI();

  // Fill the filter inputs from saved settings.
  const gf = store.settings.gmail || {};
  fKeywords.value = gf.keywords || '';
  if (fExclude) fExclude.value = gf.excludeKeywords || '';
  fDomains.value = gf.domains || '';
  fNames.value = gf.names || '';
  fTrusted.value = gf.trustedSenders || '';
  fSenders.value = gf.senders || '';
  fLabel.value = gf.label || '';
  fMax.value = gf.maxResults || 15;
  fDays.value = gf.days || 30;

  const dst = await window.widgetAPI.discordStatus();
  discordConnected = dst.connected;
  discordChannel = dst.channelName;
  updateDiscordUI();

  refreshMinutesInput.value = store.settings.refreshMinutes;
  if (fDeadlineWindow) fDeadlineWindow.value = store.settings.deadlineWindowDays || 2;

  // AI sorting fields.
  const lcfg = store.settings.llm || {};
  const lstat = await window.widgetAPI.llmStatus();
  if (llmEnabled) llmEnabled.checked = !!lcfg.enabled;
  if (llmModel) llmModel.value = lcfg.model || lstat.defaultModel || 'gemini-2.5-flash-lite';
  if (llmKey) llmKey.value = '';
  setText('llm-status', lstat.hasKey ? 'API key saved' : 'No API key yet');
  updateGeminiControls();
  toggleHidden('llm-test-output', true);

  // Learned relevance filter (on-device).
  const mcfg = store.settings.ml || {};
  if (mlEnabledInput) mlEnabledInput.checked = !!mcfg.enabled;
  await mlRefreshStatus();

  // Focus timer settings.
  const tcfg = store.settings.timer || {};
  if (timerWorkInput) timerWorkInput.value = tcfg.work || 25;
  if (timerBreakInput) timerBreakInput.value = tcfg.break || 5;
  if (timerNotifyInput) timerNotifyInput.checked = tcfg.notify !== false;
  if (timerSoundInput) timerSoundInput.checked = tcfg.sound !== false;

  renderSettingsLists();
  renderCleanup();
  settingsModal.classList.remove('hidden');
}

function updateDiscordUI() {
  if (discordConnected) {
    discordStatusEl.textContent = 'Connected' + (discordChannel ? ' to #' + discordChannel : '');
    discordConnectBtn.textContent = 'Reconnect';
    discordDisconnectBtn.classList.remove('hidden');
  } else {
    discordStatusEl.textContent = 'Not connected.';
    discordConnectBtn.textContent = 'Connect';
    discordDisconnectBtn.classList.add('hidden');
  }
}

function updateGmailUI() {
  if (gmailConnected) {
    gmailStatusEl.textContent = 'Connected' + (gmailEmail ? ' as ' + gmailEmail : '');
    gmailConnectBtn.textContent = 'Reconnect';
    gmailDisconnectBtn.classList.remove('hidden');
  } else {
    gmailStatusEl.textContent = 'Not connected.';
    gmailConnectBtn.textContent = 'Connect';
    gmailDisconnectBtn.classList.add('hidden');
  }
}

// A Gmail message id to use as the "Test AI" sample (a saved gmail event or email).
function sampleGmailId() {
  const ev = (store.events || []).find((e) => e.source === 'gmail' && e.messageId);
  if (ev) return ev.messageId;
  const em = (store.emails || []).find((e) => e.uid);
  return em ? em.uid : null;
}

function saveGmailFilters() {
  // Spread the old object first so fields without an input here
  // (blockedSenders, cleanupDone) survive a save.
  store.settings.gmail = {
    ...store.settings.gmail,
    keywords: fKeywords.value,
    excludeKeywords: fExclude ? fExclude.value : store.settings.gmail.excludeKeywords,
    domains: fDomains.value,
    names: fNames.value,
    trustedSenders: fTrusted.value,
    senders: fSenders.value,
    label: fLabel.value,
    maxResults: Math.max(1, Math.min(500, Number(fMax.value) || 200)),
    days: Math.max(30, Number(fDays.value) || 30)
  };
  fMax.value = store.settings.gmail.maxResults;
  fDays.value = store.settings.gmail.days;
  save();
}
function closeSettings() { settingsModal.classList.add('hidden'); }

function wireSettings() {
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });

  canvasConnectBtn.addEventListener('click', async () => {
    const url = canvasUrlInput.value.trim();
    if (!url) { canvasStatusEl.textContent = 'Paste your Canvas Calendar Feed link (it ends in .ics)'; return; }
    canvasStatusEl.textContent = 'Testing the link\u2026';
    const res = await window.widgetAPI.canvasSetUrl(url);
    // res.error is already a clear reason (bad link, HTTP 401/404, network error).
    if (!res.ok) { canvasStatusEl.textContent = res.error; return; }
    canvasConnected = true;
    canvasUrlInput.value = '';
    await syncCanvas();
    updateCanvasUI();
    canvasStatusEl.textContent = `Connected: ${res.count} event${res.count === 1 ? '' : 's'} found`;
  });

  canvasDisconnectBtn.addEventListener('click', async () => {
    await window.widgetAPI.canvasDisconnect();
    canvasConnected = false;
    await removeCanvasItems();
    updateCanvasUI();
    setStatus('Canvas disconnected');
  });

  refreshMinutesInput.addEventListener('change', () => {
    const mins = Math.max(1, Number(refreshMinutesInput.value) || 15);
    store.settings.refreshMinutes = mins;
    refreshMinutesInput.value = mins;
    save();
    startAutoRefresh();
  });

  if (fDeadlineWindow) fDeadlineWindow.addEventListener('change', () => {
    const days = Math.max(1, Math.min(14, Number(fDeadlineWindow.value) || 2));
    store.settings.deadlineWindowDays = days;
    fDeadlineWindow.value = days;
    save();
    renderTodos();
  });

  // --- AI sorting (Gemini) ---
  if (llmEnabled) llmEnabled.addEventListener('change', () => {
    store.settings.llm = { ...(store.settings.llm || {}), enabled: llmEnabled.checked };
    save();
    setStatus(llmEnabled.checked ? 'AI sorting on' : 'AI sorting off');
  });

  on('llm-save', 'click', async () => {
    const model = (llmModel && llmModel.value.trim()) || 'gemini-2.5-flash-lite';
    store.settings.llm = { enabled: !!(llmEnabled && llmEnabled.checked), model };
    save();
    if (llmKey && llmKey.value.trim()) {
      const r = await window.widgetAPI.llmSetKey(llmKey.value.trim());
      if (!r.ok) { setText('llm-status', 'Error: ' + r.error); return; }
      llmKey.value = '';
      setText('llm-status', 'API key saved');
    } else {
      setText('llm-status', 'Saved');
    }
  });

  on('llm-test', 'click', async () => {
    const model = (llmModel && llmModel.value.trim()) || 'gemini-2.5-flash-lite';
    setText('llm-status', 'Testing AI\u2026');
    const r = await window.widgetAPI.llmTest(sampleGmailId(), model);
    const out = el('llm-test-output');
    if (!r.ok) {
      setText('llm-status', 'Error: ' + r.error);
      if (out) { out.textContent = ''; out.classList.add('hidden'); }
      return;
    }
    setText('llm-status', `AI ok \u00B7 ${r.validated.events.length} event(s), ${r.validated.links.length} link(s)`);
    if (out) { out.textContent = JSON.stringify(r.validated, null, 2).slice(0, 4000); out.classList.remove('hidden'); }
  });

  // --- Learned relevance filter (on-device) ---
  if (mlEnabledInput) mlEnabledInput.addEventListener('change', async () => {
    store.settings.ml = { ...(store.settings.ml || {}), enabled: mlEnabledInput.checked };
    if (mlEnabledInput.checked) {
      // Back-fill examples from the existing Gmail history, once.
      const added = mlSeedFromHistory();
      save();
      if (added) console.log(`[ml] seeded ${added} example(s) from history`);
      mlAskTrain();          // trains only once the cold-start line is crossed
    } else {
      save();
    }
    await mlRefreshStatus();
    renderSettingsLists();
    renderCalendar();
    setStatus(mlEnabledInput.checked ? 'Learned filter on' : 'Learned filter off');
  });

  on('ml-train', 'click', async () => {
    const list = store.mlExamples || [];
    const cs = mlState.coldStart || 40;
    const pos = list.filter((x) => x.label === 1).length;
    if (list.length < cs || !pos || pos === list.length) {
      setText('ml-status-text', `Need at least ${cs} labelled examples with both classes (${list.length} now).`);
      return;
    }
    setText('ml-status-text', 'Training\u2026');
    const st = await window.widgetAPI.mlTrain(list, true);
    if (st) mlState = st;
    renderMlStatus();
  });

  on('ml-reset', 'click', async () => {
    if (!window.confirm('Reset the learned filter?\n\nThis clears the trained model and every saved example. Your events, tasks and settings are not touched.')) return;
    await window.widgetAPI.mlReset();
    store.mlExamples = [];
    // Keep `seeded` so it does not immediately re-fill from history.
    store.settings.ml = { ...(store.settings.ml || {}), seeded: true };
    save();
    await mlRefreshStatus();
    renderSettingsLists();
    renderCalendar();
    setStatus('Learned filter reset');
  });

  // --- Focus timer settings (work / break lengths) ---
  if (timerWorkInput) timerWorkInput.addEventListener('change', () => {
    const m = Math.max(1, Math.min(99, Number(timerWorkInput.value) || 25));
    store.settings.timer = { ...(store.settings.timer || {}), work: m };
    timerWorkInput.value = m;
    save();
    if (typeof focusApplySettings === 'function') focusApplySettings();
  });
  if (timerBreakInput) timerBreakInput.addEventListener('change', () => {
    const m = Math.max(1, Math.min(99, Number(timerBreakInput.value) || 5));
    store.settings.timer = { ...(store.settings.timer || {}), break: m };
    timerBreakInput.value = m;
    save();
    if (typeof focusApplySettings === 'function') focusApplySettings();
  });
  if (timerNotifyInput) timerNotifyInput.addEventListener('change', () => {
    store.settings.timer = { ...(store.settings.timer || {}), notify: timerNotifyInput.checked };
    save();
    if (timerNotifyInput.checked) ensureNotifyPermission();
  });
  if (timerSoundInput) timerSoundInput.addEventListener('change', () => {
    store.settings.timer = { ...(store.settings.timer || {}), sound: timerSoundInput.checked };
    save();
  });

  // --- Gmail ---
  document.getElementById('gmail-save').addEventListener('click', async () => {
    const res = await window.widgetAPI.gmailSetCredentials(gmailClientId.value.trim(), gmailClientSecret.value.trim());
    if (!res.ok) { gmailStatusEl.textContent = 'Error: ' + res.error; return; }
    gmailClientSecret.value = '';
    gmailConnected = false; gmailEmail = null;
    updateGmailUI();
    gmailStatusEl.textContent = 'Keys saved. Click Connect.';
  });

  gmailConnectBtn.addEventListener('click', async () => {
    gmailStatusEl.textContent = 'Waiting for Google sign-in in your browser\u2026';
    const res = await window.widgetAPI.gmailConnect();
    if (!res.ok) { gmailStatusEl.textContent = 'Error: ' + res.error; return; }
    gmailConnected = true; gmailEmail = res.email;
    updateGmailUI();
    await syncGmail();
  });

  gmailDisconnectBtn.addEventListener('click', async () => {
    await window.widgetAPI.gmailDisconnect();
    gmailConnected = false; gmailEmail = null;
    store.emails = [];
    save(); renderEmails(); updateGmailUI();
  });

  [fKeywords, fDomains, fNames, fTrusted, fSenders, fLabel, fMax, fDays].forEach((el) => {
    el.addEventListener('change', async () => {
      saveGmailFilters();
      if (gmailConnected) await syncGmail();
    });
  });

  // --- Discord ---
  discordConnectBtn.addEventListener('click', async () => {
    const token = discordTokenInput.value.trim();
    const channel = discordChannelInput.value.trim();
    if (!token || !channel) { discordStatusEl.textContent = 'Enter bot token and channel ID.'; return; }
    discordStatusEl.textContent = 'Testing\u2026';
    const res = await window.widgetAPI.discordSetConfig(token, channel);
    if (!res.ok) { discordStatusEl.textContent = 'Error: ' + res.error; return; }
    discordTokenInput.value = '';
    discordConnected = true;
    discordChannel = res.channelName;
    updateDiscordUI();
    await syncDiscord();
  });

  discordDisconnectBtn.addEventListener('click', async () => {
    await window.widgetAPI.discordDisconnect();
    discordConnected = false;
    discordChannel = null;
    await removeDiscordItems();
    updateDiscordUI();
    setStatus('Discord disconnected');
  });

  // --- Backup / export (events, tasks and links) ---
  const exportBtn = document.getElementById('export-data');
  if (exportBtn) exportBtn.addEventListener('click', async () => {
    const res = await window.widgetAPI.exportStore();
    if (!res || !res.ok) {
      if (res && res.error !== 'cancelled') setText('export-status', res ? res.error : 'Export failed');
      return;
    }
    setText('export-status', `Exported ${res.events} events, ${res.todos} tasks, ${res.links} links`);
  });
}

// ---------------------------------------------------------------------------
// 11. Wire up the rest of the UI
// ---------------------------------------------------------------------------
function wireUI() {
  document.getElementById('min').addEventListener('click', () => window.widgetAPI.minimize());
  document.getElementById('close').addEventListener('click', () => window.widgetAPI.close());
  document.getElementById('refresh').addEventListener('click', refresh);

  document.getElementById('pin').addEventListener('click', async () => {
    const onTop = await window.widgetAPI.toggleAlwaysOnTop();
    store.settings.alwaysOnTop = onTop;
    document.getElementById('pin').classList.toggle('active', onTop);
    save();
  });

  const order = ['auto', 'light', 'dark'];
  document.getElementById('theme').addEventListener('click', () => {
    const next = order[(order.indexOf(store.settings.theme) + 1) % order.length];
    store.settings.theme = next;
    applyTheme();
    save();
  });

  document.getElementById('viewToggle').addEventListener('click', () => {
    setView(currentView === 'expanded' ? 'compact' : 'expanded');
  });

  const linksBtn = document.getElementById('linksBtn');
  if (linksBtn) linksBtn.addEventListener('click', () => {
    setView(currentView === 'links' ? 'compact' : 'links');
  });

  // Tomato button: open the Focus timer, or go back to the calendar/tasks.
  const focusBtn = document.getElementById('focusBtn');
  if (focusBtn) focusBtn.addEventListener('click', () => {
    console.log('[ui] focus button click; current view =', currentView);
    setView(currentView === 'focus' ? 'expanded' : 'focus');
  });

  const teamBtnClick = document.getElementById('teamBtn');
  if (teamBtnClick) teamBtnClick.addEventListener('click', () => {
    setView(currentView === 'team' ? 'compact' : 'team');
  });
  on('team-run', 'click', () => {
    if (!window.widgetAPI.teamRun) return;
    window.widgetAPI.teamRun().then(applyTeam).catch((err) => console.warn('[team] ' + err.message));
  });
  const pendingList = document.getElementById('team-pending');
  if (pendingList) pendingList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const key = btn.dataset.key;
    if (btn.dataset.action === 'edit-proposal') {
      const form = btn.closest('.pending-item').querySelector('.pending-edit');
      if (form) form.classList.toggle('hidden');
      return;
    }
    if (btn.dataset.action === 'approve-proposal' || btn.dataset.action === 'reject-proposal') {
      decideProposal(key, btn.dataset.action === 'reject-proposal' ? 'reject' : 'approve');
    }
  });

  // Repeats controls: show/hide the weekday and "Ends" options.
  if (evRepeat) evRepeat.addEventListener('change', syncRepeatVisibility);
  if (evEnd) evEnd.addEventListener('change', syncRepeatVisibility);
  const linkAdd = document.getElementById('link-add');
  if (linkAdd) linkAdd.addEventListener('click', () => openLinkModal(null));
  if (linkModal) linkModal.addEventListener('click', (e) => { if (e.target === linkModal) closeLinkModal(); });
  on('lm-save', 'click', saveLinkFromModal);
  on('lm-cancel', 'click', closeLinkModal);
  on('lm-delete', 'click', () => { if (editingLinkId) deleteLink(editingLinkId); });

  document.querySelectorAll('.todo-form').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = form.querySelector('.todo-title').value.trim();
      const due = form.querySelector('.todo-due').value;
      if (!title) return;
      store.todos.push({ id: uid(), title, course: '', due, done: false, source: 'manual', dedupeKey: null });
      save();
      renderTodos();
      form.reset();
      form.querySelector('.todo-title').focus();
    });
  });

  document.body.addEventListener('change', (e) => {
    const box = e.target.closest('[data-action="toggle"]');
    if (!box) return;
    setTaskDone(box.dataset.id, box.checked);
  });
  document.body.addEventListener('click', (e) => {
    const mail = e.target.closest('[data-action="open-email"]');
    if (mail) {
      if (mail.dataset.url) window.widgetAPI.openExternal(mail.dataset.url);
      return;
    }
    const del = e.target.closest('[data-action="delete-todo"]');
    if (!del) return;
    const todo = store.todos.find((t) => t.id === del.dataset.id);
    if (todo) dismissItem(todo, 'Task');
  });

  document.getElementById('ev-save').addEventListener('click', saveEventFromModal);
  document.getElementById('ev-cancel').addEventListener('click', closeModal);
  evDelete.addEventListener('click', deleteEventFromModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  evTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveEventFromModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeSettings(); } });
}

// ---------------------------------------------------------------------------
// 12. Start up
// ---------------------------------------------------------------------------
async function init() {
  await load();

  // Learned relevance filter: refresh the stats line, back-fill examples from
  // history once, and queue a train if it is due. No-op while it is off.
  await mlInit();

  // Focus timer + music, now that the saved settings are loaded.
  // Focus timer + music, now that the saved settings are loaded (focus.js).
  if (typeof focusInit === 'function') focusInit();

  applyTheme();
  const onTop = await window.widgetAPI.setAlwaysOnTop(!!store.settings.alwaysOnTop);
  store.settings.alwaysOnTop = onTop;
  document.getElementById('pin').classList.toggle('active', onTop);

  initCalendar();
  renderTodos();
  renderEmails();
  renderDiscord();
  renderLinks();
  setView(store.settings.viewMode || 'compact');
  if (window.widgetAPI.onTeamUpdate) window.widgetAPI.onTeamUpdate(applyTeam);
  if (window.widgetAPI.teamState) {
    try { applyTeam(await window.widgetAPI.teamState()); }
    catch (err) { console.warn('[team] ' + err.message); }
  }

  // Canvas: if connected, pull fresh data in the background.
  const st = await window.widgetAPI.canvasStatus();
  canvasConnected = st.connected;
  if (canvasConnected) await syncCanvas();

  // Gmail: same idea.
  const gst = await window.widgetAPI.gmailStatus();
  gmailConnected = gst.connected;
  gmailEmail = gst.email;
  if (gmailConnected) await syncGmail();

  // Discord: read the channel.
  const dst = await window.widgetAPI.discordStatus();
  discordConnected = dst.connected;
  discordChannel = dst.channelName;
  if (discordConnected) await syncDiscord();

  startAutoRefresh();
  setStatus('Ready \u00B7 ' + [canvasConnected ? 'Canvas on' : 'Canvas off',
    gmailConnected ? 'Gmail on' : 'Gmail off',
    discordConnected ? 'Discord on' : 'Discord off'].join(' \u00B7 '));
  console.log('Widget renderer ready (Stage 6).');
}

// Attach a listener if the element exists (missing markup logs a warning, never throws).
function on(id, evt, fn) {
  const n = document.getElementById(id);
  if (n) n.addEventListener(evt, fn);
  else console.warn('[renderer] missing element #' + id + ' (' + evt + ' not wired)');
}

function hideToast() {
  clearTimeout(toastTimer);
  if (toastEl) toastEl.classList.add('hidden');
}

function wirePanels() {
  // --- Event / task details panel ---
  on('evm-close', 'click', hideEventPanel);
  on('evm-done', 'click', togglePanelDone);
  on('evm-delete', 'click', deleteFromPanel);
  on('evm-block', 'click', blockThisSender);
  on('evm-save-link', 'click', savePanelToLinks);
  on('evm-open', 'click', () => {
    const url = el('evm-open') && el('evm-open').dataset.url;
    if (url) window.widgetAPI.openExternal(url);
  });
  on('evm-edit', 'click', () => {
    toggleHidden('evm-view', true);
    toggleHidden('evm-editview', false);
  });
  on('ee-cancel', 'click', showDetailsMode);
  on('ee-save', 'click', saveEditForm);
  if (eventPanel) eventPanel.addEventListener('click', (e) => { if (e.target === eventPanel) hideEventPanel(); });

  // --- Recurring "this event / all events" chooser ---
  on('choice-one', 'click', () => closeChoice('one'));
  on('choice-all', 'click', () => closeChoice('all'));
  on('choice-cancel', 'click', () => closeChoice(null));
  const choiceEl = el('choice-modal');
  if (choiceEl) choiceEl.addEventListener('click', (e) => { if (e.target === choiceEl) closeChoice(null); });

  // --- Day list ---
  on('day-close', 'click', () => { if (dayPanel) dayPanel.classList.add('hidden'); });
  on('day-add', 'click', () => {
    const d = dayListDate || todayStr();
    if (dayPanel) dayPanel.classList.add('hidden');
    openEventModal(d, null);
  });
  if (dayPanel) dayPanel.addEventListener('click', (e) => { if (e.target === dayPanel) dayPanel.classList.add('hidden'); });

  // --- Undo toast ---
  on('toast-undo', 'click', () => {
    const undo = toastUndo;
    toastUndo = null;
    hideToast();
    if (undo) undo();
  });

  // --- Gmail preview buttons ---
  on('cleanup-apply', 'click', applyCleanup);
  on('cleanup-cancel', 'click', cancelCleanup);

  // --- Clickable items: day list, to-do titles, Suggested / Dismissed lists ---
  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const id = t.dataset.id;
    console.log('[ui] click', t.dataset.action, id || '');
    switch (t.dataset.action) {
      case 'open-event':   if (dayPanel) dayPanel.classList.add('hidden'); openEventPanel(id); break;
      case 'open-todo':    openTodoPanel(id); break;
      case 'accept-event': setEventStatus(id, 'active'); break;
      case 'dismiss-event': setEventStatus(id, 'dismissed'); break;
      case 'restore-item': restoreItem(id, t.dataset.kind); break;
      case 'open-link':    if (t.dataset.url) window.widgetAPI.openExternal(t.dataset.url); break;
      case 'edit-link':    openLinkModal(id); break;
      case 'delete-link':  deleteLink(id); break;
      case 'filter-links': linkFilter = t.dataset.cat; renderLinks(); break;
      case 'save-row-links': saveRowToLinks(t.dataset.key); break;
    }
  });

  // Escape also closes the details and day panels.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hideEventPanel();
    if (dayPanel) dayPanel.classList.add('hidden');
  });
}

wireUI();
wireSettings();
wirePanels();
init();
