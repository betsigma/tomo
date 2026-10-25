// test-features.js
// ---------------------------------------------------------------------------
// Plain-Node checks for the pure logic behind the new features (no Electron).
// Run with:  node test-features.js
// Covers:
//   1. weekly Monday 3 PM event -> every Monday of the month, respects an end date
//   2. deleting ONE occurrence leaves the others
//   3. a location added to a Canvas event survives a re-sync (overrides)
//   4. a MESA email shows in the preview table, with its links for "Save to Links"
//   9. learned relevance filter: the pure maths (classify / shouldTrain / logistic)
//  10. learned filter wiring: text capture, preview statuses, cold start
// ---------------------------------------------------------------------------

const assert = require('assert');
const Recur = require('./src/recur.js');
const Sync = require('./src/sync.js');
const { buildPreviewRows } = require('./gmail.js');
const { extractUrls } = require('./titles.js');

let pass = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok  - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

// Same idea for checks that need await (the learned-filter wiring). They are
// collected here and run at the very end, before the summary.
const asyncChecks = [];
function checkAsync(name, fn) { asyncChecks.push({ name, fn }); }

// A weekly "every Monday at 3:00 PM" event, first Monday = 2026-10-05.
const mondayEvent = {
  id: 'mon1', title: 'Study group', time: '15:00', source: 'manual',
  start: '2026-10-05',
  recurrence: { freq: 'weekly', weekdays: [1], until: '', count: null }
};

console.log('\n1. Recurrence: every Monday, end date, count');
check('weekly Monday shows on every Monday of October 2026', () => {
  const dates = Recur.expand(mondayEvent, '2026-10-01', '2026-11-01');
  assert.deepStrictEqual(dates, ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
});
check('respects an end date (until 2026-10-19)', () => {
  const ev = { ...mondayEvent, recurrence: { freq: 'weekly', weekdays: [1], until: '2026-10-19', count: null } };
  assert.deepStrictEqual(Recur.expand(ev, '2026-10-01', '2026-11-01'),
    ['2026-10-05', '2026-10-12', '2026-10-19']);
});
check('respects "after N times" (count = 2)', () => {
  const ev = { ...mondayEvent, recurrence: { freq: 'weekly', weekdays: [1], until: '', count: 2 } };
  assert.deepStrictEqual(Recur.expand(ev, '2026-10-01', '2026-11-01'), ['2026-10-05', '2026-10-12']);
});
check('a plain (non-recurring) event draws once', () => {
  const ev = { id: 'x', start: '2026-10-07', time: '' };
  assert.deepStrictEqual(Recur.expand(ev, '2026-10-01', '2026-11-01'), ['2026-10-07']);
});

console.log('\n2. Delete one occurrence, keep the rest');
check('removing 2026-10-19 leaves the other three Mondays', () => {
  const ev = { ...mondayEvent, exceptions: { '2026-10-19': { cancelled: true } } };
  const dates = Recur.occurrences(ev, '2026-10-01', '2026-11-01').map((o) => o.date);
  assert.deepStrictEqual(dates, ['2026-10-05', '2026-10-12', '2026-10-26']);
});
check('editing one occurrence keeps the others and marks only that one done', () => {
  const ev = {
    ...mondayEvent,
    exceptions: { '2026-10-12': { location: 'E36' } },
    occurrencesDone: { '2026-10-12': true }
  };
  const occ = Recur.occurrences(ev, '2026-10-01', '2026-11-01');
  assert.strictEqual(occ.length, 4);
  const edited = occ.find((o) => o.date === '2026-10-12');
  assert.strictEqual(edited.view.location, 'E36');
  assert.strictEqual(edited.done, true);
  assert.strictEqual(occ.filter((o) => o.done).length, 1);
});

console.log('\n3. A location edit on a Canvas event survives re-sync');
check('override wins over the (empty) feed value after re-sync', () => {
  const store = { events: [], todos: [], overrides: {} };
  const feed = [{ uid: 'assign-1', title: 'Quiz 3', start: '2026-10-20', time: '10:00', location: '' }];
  Sync.mergeItems(store, 'canvas', feed);
  assert.strictEqual(store.events.length, 1);
  // The user edits the room on the synced event.
  store.overrides['canvas:assign-1'] = { location: 'E36' };
  // The next sync hands us the same (empty) location again.
  Sync.mergeItems(store, 'canvas', feed);
  assert.strictEqual(store.events.length, 1, 'no duplicate created');
  assert.strictEqual(store.events[0].location, 'E36', 'event kept the edit');
  assert.strictEqual(store.todos[0].location, 'E36', 'task kept the edit too');
});

console.log('\n4. The MESA email shows in the preview table / Links');
check('a trusted MESA email becomes a preview row with its links', () => {
  const email = {
    uid: 'm1', subject: 'MESA Scholarship Info Session Oct 20',
    fromEmail: 'mesa@deanza.edu', from: 'MESA',
    link: 'https://mail.google.com/mail/u/0/#all/m1',
    urls: ['https://deanza.edu/mesa/apply'],
    pass: true, trusted: true, reason: 'trusted-sender(mesa@deanza.edu)',
    events: [{ title: 'MESA Scholarship Info Session', start: '2026-10-20', time: '15:00', source: 'heading' }],
    diag: { reason: 'ok' }
  };
  const rows = buildPreviewRows([email]);
  const row = rows.find((r) => r.subject.includes('MESA'));
  assert.ok(row, 'a MESA row exists');
  assert.strictEqual(row.willCreate, true);
  assert.ok(row.links.includes('https://mail.google.com/mail/u/0/#all/m1'), 'has the email link');
  assert.ok(row.links.includes('https://deanza.edu/mesa/apply'), 'has the URL from the section');
});
check('extractUrls finds body links and drops image/tracking noise', () => {
  const urls = extractUrls('Apply at https://deanza.edu/x . Banner https://cdn.site.com/logo.png here.');
  assert.ok(urls.includes('https://deanza.edu/x'), 'kept the real link (no trailing dot)');
  assert.ok(!urls.some((u) => u.endsWith('.png')), 'dropped the image');
});

console.log('\n5. Canvas to-do gets its due date (bug #1)');
check('start is copied into due + time for a synced to-do', () => {
  const store = { events: [], todos: [], overrides: {} };
  Sync.mergeItems(store, 'canvas', [{ uid: 'a1', title: 'Essay', start: '2026-10-12', time: '23:59' }]);
  assert.strictEqual(store.todos[0].due, '2026-10-12', 'due populated from start');
  assert.strictEqual(store.todos[0].time, '23:59', 'time carried over');
  // A re-sync must keep it populated, not blank it.
  Sync.mergeItems(store, 'canvas', [{ uid: 'a1', title: 'Essay', start: '2026-10-12', time: '23:59' }]);
  assert.strictEqual(store.todos[0].due, '2026-10-12');
});
check('an explicit due is not overwritten by start', () => {
  const store = { events: [], todos: [], overrides: {} };
  Sync.mergeItems(store, 'canvas', [{ uid: 'a2', title: 'X', start: '2026-10-12', due: '2026-10-14' }]);
  assert.strictEqual(store.todos[0].due, '2026-10-14');
});

console.log('\n6. Discord follow-forward label (bug #4)');
check('a channel-label-only message is skipped (empty content)', () => {
  const { normalizeDiscordMessage } = require('./discord.js');
  const m = normalizeDiscordMessage({ id: '1', content: 'Women In Stem De Anza #announcements', author: { username: 'Beoz' } }, 'announcements');
  assert.strictEqual(m.content, '');
});
check('an embed title is preferred over the message text', () => {
  const { normalizeDiscordMessage } = require('./discord.js');
  const m = normalizeDiscordMessage({
    id: '2', content: 'Women In Stem De Anza #announcements',
    embeds: [{ title: 'Meeting this Friday at 3pm' }], author: { username: 'Beoz' }
  }, 'announcements');
  assert.strictEqual(m.content, 'Meeting this Friday at 3pm');
  assert.ok(m.event, 'date detected from embed title');
});
check('a real first line is used when there is no embed', () => {
  const { normalizeDiscordMessage } = require('./discord.js');
  const m = normalizeDiscordMessage({ id: '3', content: 'Women In Stem De Anza #announcements\nFood drive starts Monday', author: { username: 'Beoz' } }, 'announcements');
  assert.strictEqual(m.content, 'Food drive starts Monday');
});

console.log('\n7. AI result validation (never trust the model)');
const llm = require('./llm.js');
const now = new Date('2026-10-13T12:00:00');
const emailText = 'MESA Scholarship Info Session is on October 20, 2026 at 3:00 PM in room E36.';
check('cleanForAI strips body urls and appends the link list', () => {
  const clean = llm.cleanForAI('Apply here https://deanza.edu/mesa now.', ['https://deanza.edu/mesa/apply']);
  assert.ok(!/deanza\.edu\/mesa now/.test(clean), 'url removed from body');
  assert.ok(clean.includes('Links found in this email:'), 'link list appended');
  assert.ok(clean.includes('https://deanza.edu/mesa/apply'));
});
check('a valid event is accepted and dated in-window', () => {
  const r = llm.validateResult({
    events: [{ title: 'MESA Info Session', date: '2026-10-20', startTime: '15:00', endTime: null,
      allDay: false, location: 'E36', category: 'MESA', useful: true,
      sourceQuote: 'MESA Scholarship Info Session is on October 20, 2026 at 3:00 PM in room E36.' }],
    links: [{ title: 'Apply', url: 'https://deanza.edu/mesa/apply', category: 'Scholarship' }]
  }, { text: emailText, now, allowedUrls: ['https://deanza.edu/mesa/apply'] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.events.length, 1);
  assert.strictEqual(r.events[0].time, '15:00');
  assert.strictEqual(r.links.length, 1);
});
check('a quote not present in the email is rejected', () => {
  const r = llm.validateResult({ events: [{ title: 'X', date: '2026-10-20', sourceQuote: 'This sentence is not in the email.' }] }, { text: emailText, now });
  assert.strictEqual(r.events.length, 0);
  assert.ok(r.dropped >= 1);
});
check('a date that is not in the quote is rejected', () => {
  const r = llm.validateResult({ events: [{ title: 'X', date: '2026-11-05', sourceQuote: 'MESA Scholarship Info Session is on October 20, 2026 at 3:00 PM in room E36.' }] }, { text: emailText, now });
  assert.strictEqual(r.events.length, 0);
});
check('a date outside -14/+120 days is rejected', () => {
  const r = llm.validateResult({ events: [{ title: 'X', date: '2027-06-01', sourceQuote: 'MESA Scholarship Info Session is on October 20, 2026 at 3:00 PM in room E36.' }] }, { text: emailText, now });
  assert.strictEqual(r.events.length, 0);
});
check('invalid JSON is reported, not trusted', () => {
  const r = llm.validateResult('not json at all', { text: emailText, now });
  assert.strictEqual(r.ok, false);
});
check('an invented link (not seen in the email) is dropped', () => {
  const r = llm.validateResult({ links: [{ url: 'https://evil.example/x', category: 'Info' }] }, { text: emailText, now, allowedUrls: ['https://deanza.edu/mesa/apply'] });
  assert.strictEqual(r.links.length, 0);
});
check('preview row shows AI columns (parsed by / category / useful / quote)', () => {
  const { buildPreviewRows } = require('./gmail.js');
  const rows = buildPreviewRows([{
    uid: 'm9', subject: 'MESA newsletter', fromEmail: 'mesa@deanza.edu', pass: true, trusted: true, aiUsed: true,
    events: [{ title: 'MESA Info Session', start: '2026-10-20', time: '15:00', category: 'MESA', useful: true,
      sourceQuote: 'on October 20, 2026', status: 'active', source: 'ai' }],
    aiLinks: []
  }]);
  assert.strictEqual(rows[0].parsedBy, 'AI');
  assert.strictEqual(rows[0].category, 'MESA');
  assert.strictEqual(rows[0].useful, true);
  assert.strictEqual(rows[0].sourceQuote, 'on October 20, 2026');
  assert.strictEqual(rows[0].willCreate, true);
});

console.log('\n8. Focus tab: shared tasks + pomodoro counts');
check('a Canvas item becomes a paired event AND to-do with the same dedupeKey', () => {
  const store = { events: [], todos: [], overrides: {} };
  Sync.mergeItems(store, 'canvas', [{ uid: 'c1', title: 'Essay', start: '2026-10-20', time: '23:59' }]);
  assert.strictEqual(store.events.length, 1);
  assert.strictEqual(store.todos.length, 1);
  assert.strictEqual(store.events[0].dedupeKey, store.todos[0].dedupeKey, 'pairing key matches');
});
check('a pomodoro count on a task survives a Canvas re-sync', () => {
  const store = { events: [], todos: [], overrides: {} };
  const feed = [{ uid: 'c2', title: 'Lab', start: '2026-10-21' }];
  Sync.mergeItems(store, 'canvas', feed);
  store.todos[0].pomodoros = 4;
  Sync.mergeItems(store, 'canvas', feed);        // re-sync
  assert.strictEqual(store.todos[0].pomodoros, 4, 'count kept');
  assert.strictEqual(store.todos.length, 1, 'no duplicate');
});
check('mirroring done by dedupeKey keeps event and to-do in step (Focus <-> calendar)', () => {
  const store = { events: [], todos: [], overrides: {} };
  Sync.mergeItems(store, 'canvas', [{ uid: 'c3', title: 'Quiz', start: '2026-10-22' }]);
  const key = store.todos[0].dedupeKey;
  // What the renderer does when a task is ticked in the Focus tab:
  store.todos[0].done = true;
  const ev = store.events.find((e) => e.dedupeKey === key);
  ev.done = store.todos[0].done;
  assert.strictEqual(ev.done, true, 'calendar event follows the to-do');
  // And the reverse (ticked from the calendar/details panel):
  ev.done = false;
  store.todos[0].done = ev.done;
  assert.strictEqual(store.todos[0].done, false, 'to-do follows the event');
});

console.log('\n9. Learned relevance filter: pure maths + rules');
const ml = require('./ml.js');
check('classify: thresholds map to normal / suggested / hidden', () => {
  assert.strictEqual(ml.classify(0.9).cls, 'normal');
  assert.strictEqual(ml.classify(0.5).cls, 'suggested');
  assert.strictEqual(ml.classify(0.1).cls, 'hidden');
});
check('classify: a deadline word or a timed appointment is never hidden', () => {
  assert.strictEqual(ml.classify(0.05, { deadlineWord: true }).cls, 'suggested');
  assert.strictEqual(ml.classify(0.05, { timedAppointment: true }).cls, 'suggested');
});
check('shouldTrain: cold start and both-classes gates', () => {
  assert.strictEqual(ml.shouldTrain({ labeled: 20, pos: 10, neg: 10 }).train, false);
  assert.strictEqual(ml.shouldTrain({ labeled: 50, pos: 50, neg: 0 }).train, false);
  assert.strictEqual(ml.shouldTrain({ labeled: 50, pos: 25, neg: 25 }).train, true);
});
check('shouldTrain: retrains only after ~10 new labels', () => {
  assert.strictEqual(ml.shouldTrain({ labeled: 45, pos: 20, neg: 25, lastTrained: 40 }).train, false);
  assert.strictEqual(ml.shouldTrain({ labeled: 51, pos: 20, neg: 31, lastTrained: 40 }).train, true);
  assert.strictEqual(ml.shouldTrain({ labeled: 41, pos: 20, neg: 21, lastTrained: 40 }, { force: true }).train, true);
});
check('logistic regression separates two clear clusters', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 20; i++) {
    X.push([2 + (i % 3) * 0.01, 2]); y.push(1);   // right/top cluster = useful
    X.push([-2 - (i % 3) * 0.01, -2]); y.push(0); // left/bottom cluster = not useful
  }
  const model = ml.fit(X, y);
  assert.ok(model, 'a model was fitted');
  assert.strictEqual(ml.accuracyOf(model, X, y), 1);
  assert.ok(ml.predict(model, [2, 2]) > 0.5, 'useful side scores high');
  assert.ok(ml.predict(model, [-2, -2]) < 0.5, 'not-useful side scores low');
});
check('trainAndEvaluate reports a held-out accuracy once past the cold start', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 20; i++) {
    X.push([3 + i * 0.01, 1]); y.push(1);
    X.push([-3 - i * 0.01, -1]); y.push(0);
  }
  const r = ml.trainAndEvaluate(X, y);
  assert.ok(r.model, 'final model exists');
  assert.ok(r.testPos > 0 && r.testNeg > 0, 'held-out set has both classes');
  assert.ok(r.accuracy !== null && r.accuracy >= 0.8, 'accuracy is measured and high');
});
check('buildExampleText trims and caps the text', () => {
  const long = 'x'.repeat(2000);
  const t = ml.buildExampleText({ subject: 'Hello', title: 'World', text: long });
  assert.ok(t.startsWith('Hello | World'));
  assert.ok(t.length <= ml.MAX_TEXT);
});
check('dedupeExamples keeps one row per text', () => {
  const d = ml.dedupeExamples([{ text: 'a', label: 1 }, { text: 'a', label: 0 }, { text: 'b', label: 1 }]);
  assert.strictEqual(d.length, 2);
});

console.log('\n10. Learned filter wiring (no network, no Transformers.js needed)');
check('analyzeEmail attaches the training text to every parsed item', () => {
  const { analyzeEmail } = require('./gmail.js');
  const soon = new Date(Date.now() + 5 * 86400000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dstr = `${months[soon.getMonth()]} ${soon.getDate()}`;
  const body = `MESA Scholarship Info Session\n\nJoin us on ${dstr} in room E36.`;
  const { events } = analyzeEmail(body, new Date(), { subject: 'MESA news' });
  assert.ok(events.length >= 1, 'an event was parsed');
  assert.ok(events[0].text && events[0].text.includes('MESA Scholarship Info Session'), 'text present');
});
check('buildPreviewRows carries the learned-filter fields and status', () => {
  const { buildPreviewRows } = require('./gmail.js');
  const rows = buildPreviewRows([{
    uid: 'm20', subject: 'MESA newsletter', fromEmail: 'mesa@deanza.edu', pass: true, trusted: true,
    events: [{ title: 'MESA Info Session', start: '2026-10-20', time: '', source: 'heading', text: 'MESA newsletter MESA Info Session',
      mlScore: 0.11, mlClass: 'hidden', mlReason: 'looks like ones you skip (11%)' }]
  }]);
  assert.strictEqual(rows[0].mlScore, 0.11);
  assert.strictEqual(rows[0].event.status, 'filtered');
  assert.ok(/learned filter/.test(rows[0].reason));
});
checkAsync('fetchPreview scores items end to end with an injected scorer', async () => {
  // A tiny fake of the Gmail API: one trusted email with one explicit date.
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const soon = new Date(Date.now() + 5 * 86400000);
  const dstr = `${months[soon.getMonth()]} ${soon.getDate()}`;
  const body = `MESA Scholarship Info Session\n\nJoin us on ${dstr} in room E36.`;
  const b64 = Buffer.from(body, 'utf8').toString('base64');
  const message = {
    id: 'msg-1',
    payload: {
      headers: [
        { name: 'From', value: 'MESA <mesa@deanza.edu>' },
        { name: 'Subject', value: 'MESA news' }
      ],
      parts: [{ mimeType: 'text/plain', body: { data: b64 } }]
    },
    snippet: 'MESA Scholarship Info Session'
  };
  const gmailApi = {
    users: { messages: {
      list: async () => ({ data: { messages: [{ id: 'msg-1' }] } }),
      get: async () => ({ data: message })
    } }
  };
  const filters = { trustedSenders: 'mesa@deanza.edu', keywords: '', domains: '', names: '', senders: '', maxResults: 5, days: 30 };

  const low = await require('./gmail.js').fetchPreview(gmailApi, filters, null, null, {
    enabled: true, score: async (texts) => texts.map(() => 0.1)
  });
  assert.ok(low.mlStats.enabled && low.mlStats.scored >= 1, 'items were scored');
  const lowRow = low.preview.find((r) => r.title);
  assert.strictEqual(lowRow.event.status, 'filtered', 'a low score parks the item as filtered');

  const high = await require('./gmail.js').fetchPreview(gmailApi, filters, null, null, {
    enabled: true, score: async (texts) => texts.map(() => 0.85)
  });
  const highRow = high.preview.find((r) => r.title);
  assert.strictEqual(highRow.event.status, 'active', 'a high score keeps it as a normal event');

  const off = await require('./gmail.js').fetchPreview(gmailApi, filters, null, null, null);
  assert.strictEqual(off.mlStats.enabled, false);
  assert.strictEqual(off.preview.find((r) => r.title).event.mlScore, '', 'untouched when the filter is off');
});
checkAsync('RelevanceModel: cold start needs no model download', async () => {
  const os = require('os');
  const pathMod = require('path');
  const fsm = require('fs');
  const dir = fsm.mkdtempSync(pathMod.join(os.tmpdir(), 'ml-test-'));
  const model = new ml.RelevanceModel({ dataDir: dir, log: () => {} });
  assert.strictEqual(model.status().trainedOn, 0);
  assert.strictEqual(model.status().modelReady, false);
  // Below the cold start there should be no training and no model.
  const st = await model.train([{ text: 'a', label: 1 }, { text: 'b', label: 0 }]);
  assert.strictEqual(st.modelReady, false);
  assert.ok(/cold-start/.test(st.pendingReason), 'still in cold start');
  // No trained model -> no scores (the caller falls back to the rules).
  assert.strictEqual(await model.scoreTexts(['anything']), null);
  // Reset wipes everything back to the start.
  model.reset();
  assert.strictEqual(model.status().trainedOn, 0);
});

// --- voting-email exclusion + long Canvas descriptions ---
const gm = require('./gmail.js');
const filtersBase = { trustedSenders: 'communications@deanza.edu', domains: 'deanza.edu', keywords: '' };

check('exclusion: a trusted voter-registration email is rejected with the keyword', () => {
  const v = gm.screenEmail({ fromEmail: 'communications@deanza.edu', subject: 'Register to vote by Oct 21', body: '' },
    { ...filtersBase, excludeKeywords: gm.DEFAULT_EXCLUDE_KEYWORDS });
  assert.strictEqual(v.pass, false);
  assert.strictEqual(v.excluded, 'register to vote');
});

check('exclusion: only the START of the body is checked', () => {
  const body = 'Club fair this Friday in the quad. '.repeat(40) + 'Bring your ballot questions.';
  const v = gm.screenEmail({ fromEmail: 'communications@deanza.edu', subject: 'Weekly news', body },
    { ...filtersBase, excludeKeywords: gm.DEFAULT_EXCLUDE_KEYWORDS });
  assert.strictEqual(v.pass, true, 'late mention must not exclude');
});

check('exclusion: an empty list disables it; missing list uses the defaults', () => {
  const email = { fromEmail: 'communications@deanza.edu', subject: 'Election Day reminder', body: '' };
  assert.strictEqual(gm.screenEmail(email, { ...filtersBase, excludeKeywords: '' }).pass, true);
  assert.strictEqual(gm.excludedKeyword(email.subject, '', undefined), 'election day');
});

check('Canvas descriptions keep up to ~4,000 characters', () => {
  const { normalizeCalendar } = require('./canvas.js');
  const long = 'Write a reflection essay. '.repeat(300);   // ~7,800 chars
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a1', 'DTSTART;VALUE=DATE:20261101',
    'SUMMARY:Essay 2 (ENGL 1A)', 'DESCRIPTION:' + long, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const [item] = normalizeCalendar(ics);
  assert.ok(item.description.length > 3900 && item.description.length <= 4000, 'len=' + item.description.length);
});

// --- CREAO client (offline: fake fetch, temp data dir) ---
const creao = require('./creaoClient.js');
const osC = require('os'), fsC = require('fs'), pathC = require('path');
const tmpData = () => fsC.mkdtempSync(pathC.join(osC.tmpdir(), 'creao-test-'));
const FAKE_KEY = 'capi_test_SECRET_123';

// A fake CREAO API: POST creates a run, GETs report running then completed with `reply`.
function fakeCreao(reply, { failStatus = null, calls = [] } = {}) {
  let polls = 0;
  return async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body });
    if (failStatus) return { ok: false, status: failStatus, text: async () => '{"error":"NOPE"}' };
    if (init.method === 'POST') return { ok: true, status: 200, text: async () => '{"id":"run-1","status":"pending"}' };
    polls++;
    const run = polls < 2 ? { id: 'run-1', status: 'running' } : { id: 'run-1', status: 'completed', result: { text: reply } };
    return { ok: true, status: 200, text: async () => JSON.stringify(run) };
  };
}
const liveEnv = (role) => ({ CREAO_MODE: 'live', CREAO_POLL_MS: '1',
  [`CREAO_APP_ID_${role}`]: 'app-123', [`CREAO_KEY_${role}`]: FAKE_KEY });

check('extractJson: bare, fenced, and prose-wrapped replies', () => {
  assert.deepStrictEqual(creao.extractJson('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(creao.extractJson('Here you go:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepStrictEqual(creao.extractJson('Sure! {"a":"x}y","b":{"c":3}} Hope that helps.'), { a: 'x}y', b: { c: 3 } });
  assert.strictEqual(creao.extractJson('no json here'), null);
});

check('every mock file validates against its schema (tokens resolved)', () => {
  const c = creao.createClient({ dataDir: tmpData(), env: {}, log: () => {} });
  for (const role of creao.ROLES) c.checkOutput(role, c.loadMock(role));
  assert.ok(!/\{\{/.test(JSON.stringify(c.loadMock('PLANNER'))), 'tokens resolved');
});

check('legacy Mail Scanner shape maps onto the contract', () => {
  const out = creao.normalizeMail({ important: [{ title: 'a@deanza.edu', subtitle: 'Hi', importance: 0.8, reason: 'r' }] });
  assert.strictEqual(out.important_emails[0].sender, 'a@deanza.edu');
  assert.strictEqual(out.important_emails[0].importance, 80);
});

checkAsync('creao: role without a key uses mock and reports mode "mock"', async () => {
  const c = creao.createClient({ dataDir: tmpData(), env: { CREAO_MODE: 'live' }, fetch: () => { throw new Error('no network'); }, log: () => {} });
  const r = await c.run('DIGEST', { x: 1 });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.source, 'mock');
  assert.strictEqual(c.status().roles.find((x) => x.role === 'DIGEST').mode, 'mock');
});

checkAsync('creao: live run posts inputs.payload, polls, validates; same input is cached', async () => {
  const calls = [];
  const reply = 'Result:\n' + JSON.stringify({ morning_brief: 'Hi.', team_digest: ['a', 'b', 'c'] });
  const c = creao.createClient({ dataDir: tmpData(), env: liveEnv('DIGEST'), fetch: fakeCreao(reply, { calls }), log: () => {} });
  const r1 = await c.run('DIGEST', { ranked_tasks: [] });
  assert.strictEqual(r1.ok, true); assert.strictEqual(r1.source, 'live');
  assert.ok(calls[0].url.endsWith('/apps/app-123/runs') && calls[0].method === 'POST');
  assert.strictEqual(calls[0].auth, 'Bearer ' + FAKE_KEY);
  assert.deepStrictEqual(JSON.parse(JSON.parse(calls[0].body).inputs.payload), { ranked_tasks: [] });
  const n = calls.length;
  const r2 = await c.run('DIGEST', { ranked_tasks: [] });
  assert.strictEqual(r2.source, 'cache'); assert.strictEqual(calls.length, n, 'no new HTTP calls');
});

checkAsync('creao: invalid reply falls back to last good result; errors never contain the key', async () => {
  const dir = tmpData();
  const good = JSON.stringify({ morning_brief: 'Hi.', team_digest: ['a', 'b', 'c'] });
  await creao.createClient({ dataDir: dir, env: liveEnv('DIGEST'), fetch: fakeCreao(good), log: () => {} }).run('DIGEST', { v: 1 });
  const logs = [];
  const c = creao.createClient({ dataDir: dir, env: liveEnv('DIGEST'), fetch: fakeCreao('{"morning_brief":5}'), log: (m) => logs.push(m) });
  const r = await c.run('DIGEST', { v: 2 });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stale, true);
  assert.strictEqual(r.output.morning_brief, 'Hi.');
  const r401 = await creao.createClient({ dataDir: dir, env: liveEnv('DIGEST'), fetch: fakeCreao('', { failStatus: 401 }), log: (m) => logs.push(m) }).run('DIGEST', { v: 3 });
  assert.ok(/401/.test(r401.error));
  const all = JSON.stringify([r, r401, logs, fsC.readFileSync(pathC.join(dir, 'creao-cache.json'), 'utf8')]);
  assert.ok(!all.includes(FAKE_KEY), 'key leaked');
});

checkAsync('creao: hourly run cap stops live runs', async () => {
  const env = { ...liveEnv('DIGEST'), CREAO_MAX_RUNS_PER_HOUR: '1' };
  const good = JSON.stringify({ morning_brief: 'Hi.', team_digest: ['a', 'b', 'c'] });
  const c = creao.createClient({ dataDir: tmpData(), env, fetch: fakeCreao(good), log: () => {} });
  assert.strictEqual((await c.run('DIGEST', { v: 1 })).ok, true);
  const r = await c.run('DIGEST', { v: 2 });
  assert.strictEqual(r.rateLimited, true); assert.strictEqual(r.output.morning_brief, 'Hi.');
});

checkAsync('creao: JSON in an artifact is downloaded without forwarding the key on redirect', async () => {
  const calls = [];
  const good = JSON.stringify({ morning_brief: 'Hi.', team_digest: ['a', 'b', 'c'] });
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, auth: init.headers && init.headers.Authorization });
    const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (init.method === 'POST') return json({ id: 'run-9', status: 'pending' });
    if (url.includes('/artifacts/download')) return { ok: false, status: 302, headers: { get: () => 'https://storage.example/x.json' }, text: async () => '' };
    if (url.startsWith('https://storage.example/')) return { ok: true, status: 200, text: async () => good };
    return json({ id: 'run-9', status: 'completed', result: { text: '{"task_count":3}', artifacts: [{ id: 'art-1', type: 'application/json', title: 'digest.json' }] } });
  };
  const c = creao.createClient({ dataDir: tmpData(), env: liveEnv('DIGEST'), fetch: fetchFn, log: () => {} });
  const r = await c.run('DIGEST', { v: 1 });
  assert.strictEqual(r.ok, true, r.error); assert.strictEqual(r.output.team_digest.length, 3);
  const storageHop = calls.find((x) => x.url.startsWith('https://storage.example/'));
  assert.ok(storageHop && !storageHop.auth, 'no Authorization on the storage hop');
});

console.log('\n11. test:creao --only selects agents without calling CREAO');
const { selectRoles } = require('./scripts/test-creao.js');
const CREAO_ROLES = ['MAIL', 'ANALYST', 'PLANNER', 'DIGEST'];

check('--only MAIL,DIGEST does not select the other agents', () => {
  const picked = selectRoles(['node', 'test-creao.js', '--recheck', '--only', 'MAIL,DIGEST'], CREAO_ROLES);
  assert.deepStrictEqual(picked.roles, ['MAIL', 'DIGEST']);
  assert.ok(!picked.error);
});
check('--only is case-insensitive and trims spaces', () => {
  const picked = selectRoles(['node', 'test-creao.js', '--only', ' mail, digest '], CREAO_ROLES);
  assert.deepStrictEqual(picked.roles, ['MAIL', 'DIGEST']);
});
check('--only=DIGEST equals form selects just that agent', () => {
  const picked = selectRoles(['node', 'test-creao.js', '--only=DIGEST'], CREAO_ROLES);
  assert.deepStrictEqual(picked.roles, ['DIGEST']);
});
check('an unknown --only role selects nothing', () => {
  const picked = selectRoles(['node', 'test-creao.js', '--only', 'MAIL,NOPE'], CREAO_ROLES);
  assert.deepStrictEqual(picked.roles, []);
  assert.ok(picked.error && picked.error.includes('NOPE'));
});
check('duplicate names in --only are tested once', () => {
  const picked = selectRoles(['node', 'test-creao.js', '--only', 'MAIL,MAIL'], CREAO_ROLES);
  assert.deepStrictEqual(picked.roles, ['MAIL']);
});
check('no role flag still selects every agent', () => {
  const picked = selectRoles(['node', 'test-creao.js', '--recheck'], CREAO_ROLES);
  assert.deepStrictEqual(picked.roles, CREAO_ROLES);
  assert.ok(!picked.error);
});
check('--role=ANALYST still selects only that agent', () => {
  const picked = selectRoles(['node', 'test-creao.js', '--role=ANALYST'], CREAO_ROLES);
  assert.deepStrictEqual(picked.roles, ['ANALYST']);
});
check('--only and --role together select nothing', () => {
  const picked = selectRoles(['node', 'test-creao.js', '--only', 'MAIL', '--role=DIGEST'], CREAO_ROLES);
  assert.deepStrictEqual(picked.roles, []);
  assert.ok(picked.error);
});

console.log('\n12. Analyst input window, cap, and a failed agent stops the chain');
const teamInputs = require('./teamInputs.js');
const { createOrchestrator } = require('./orchestrator.js');

function openTodo(id, due, extra = {}) {
  return { id, title: id, due, done: false, source: 'canvas', status: 'active', course: 'PHYS', dedupeKey: null, ...extra };
}

check('Analyst input keeps 3-day overdue and 14-day tasks, and drops the rest', () => {
  const now = new Date(2026, 9, 24, 12, 0, 0);
  const store = { events: [], todos: [
    openTodo('old', '2026-10-20'),
    openTodo('overdue', '2026-10-21'),
    openTodo('soon', '2026-10-24'),
    openTodo('far', '2026-11-07'),
    openTodo('too-far', '2026-11-08'),
    openTodo('done-one', '2026-10-25', { done: true }),
    openTodo('gone', '2026-10-25', { status: 'dismissed' }),
    openTodo('manual', '2026-10-25', { source: 'manual', status: undefined })
  ] };
  const built = teamInputs.buildAnalystInput(store, {}, [], now);
  const ids = built.input.tasks.map((t) => t.id);
  assert.deepStrictEqual(ids, ['overdue', 'soon', 'manual', 'far']);
  assert.strictEqual(built.sent, 4);
  assert.strictEqual(built.eligible, 4);
});

check('Analyst input caps at 30 and reports sent of eligible', () => {
  const now = new Date(2026, 9, 24, 12, 0, 0);
  const todos = [];
  for (let i = 0; i < 31; i++) todos.push(openTodo('t' + i, '2026-10-24'));
  const built = teamInputs.buildAnalystInput({ events: [], todos }, {}, [], now);
  assert.strictEqual(built.eligible, 31);
  assert.strictEqual(built.sent, 30);
  assert.strictEqual(built.input.tasks.length, 30);
  assert.strictEqual(built.input.tasks[0].id, 't0');
  assert.strictEqual(built.input.tasks.some((t) => t.id === 't30'), false);
});

check('Gemini is not called while the Mail Scanner is live', () => {
  assert.strictEqual(creao.geminiAllowed(true, 'live'), false);
  assert.strictEqual(creao.geminiAllowed(true, 'mock'), true);
  assert.strictEqual(creao.geminiAllowed(false, 'mock'), false);
});

function fakeTeamClient(byRole) {
  const calls = [];
  const roles = ['MAIL', 'ANALYST', 'PLANNER', 'DIGEST'];
  return {
    calls,
    status() {
      return {
        globalMode: 'live', maxRunsPerHour: 4,
        roles: roles.map((role) => ({ role, name: role, mode: 'live', configured: true, runsLastHour: 0 }))
      };
    },
    async run(role, input, opts) {
      calls.push({ role, force: !!(opts && opts.force) });
      if (!byRole[role]) throw new Error('should not run ' + role);
      return byRole[role];
    }
  };
}

checkAsync('a failed agent stops the chain, keeps earlier results, and does not throw', async () => {
  const dir = tmpData();
  const client = fakeTeamClient({
    MAIL: { ok: true, source: 'live', output: { important_emails: [], events: [{ title: 'Aid', date: '2026-10-25', source_subject: 'Aid' }] } },
    ANALYST: { ok: false, source: 'mock', stale: true, error: 'bad output', output: { tasks: [], crunch_weeks: [] } }
  });
  const orch = createOrchestrator({
    client, dataDir: dir, loadStore: () => ({ todos: [], events: [], settings: {} }),
    emit: () => {}, log: () => {}, now: () => new Date(2026, 9, 24, 12, 0, 0)
  });
  let state;
  try { state = await orch.runTeam('manual', { force: true }); }
  finally { orch.stop(); }
  assert.deepStrictEqual(client.calls.map((c) => c.role), ['MAIL', 'ANALYST']);
  assert.strictEqual(client.calls[0].force, true);
  assert.strictEqual(state.nodes.MAIL.status, 'done');
  assert.strictEqual(state.nodes.ANALYST.status, 'error');
  assert.strictEqual(state.nodes.PLANNER.status, 'idle');
  assert.strictEqual(state.nodes.DIGEST.status, 'idle');
  assert.strictEqual(state.outputs.MAIL.events.length, 1);
  assert.strictEqual(state.running, false);
});

checkAsync('a full run records how many tasks were sent', async () => {
  const dir = tmpData();
  const client = fakeTeamClient({
    MAIL: { ok: true, source: 'live', output: { important_emails: [], events: [] } },
    ANALYST: { ok: true, source: 'live', output: { tasks: [], crunch_weeks: [] } },
    PLANNER: { ok: true, source: 'mock', output: { proposals: [], adjustment_note: '' } },
    DIGEST: { ok: true, source: 'mock', output: { morning_brief: 'Do the lab.', team_digest: ['a', 'b', 'c'] } }
  });
  const orch = createOrchestrator({
    client, dataDir: dir,
    loadStore: () => ({ events: [], settings: {}, todos: [openTodo('lab', '2026-10-24'), openTodo('old', '2026-10-01')] }),
    emit: () => {}, log: () => {}, now: () => new Date(2026, 9, 24, 12, 0, 0)
  });
  let state;
  try { state = await orch.runTeam('schedule'); }
  finally { orch.stop(); }
  assert.strictEqual(client.calls.every((c) => c.force === false), true);
  assert.deepStrictEqual(state.analystSent, { sent: 1, eligible: 1 });
  assert.ok(String(state.nodes.ANALYST.handoff).includes('sent 1 of 1'));
});

// Run the async checks, then print the summary.
(async () => {
  for (const { name, fn } of asyncChecks) {
    try { await fn(); pass++; console.log('  ok  - ' + name); }
    catch (e) { console.error('  FAIL - ' + name + '\n        ' + e.message); process.exitCode = 1; }
  }
  console.log('\n' + (process.exitCode ? 'Some tests FAILED.' : `All ${pass} checks passed.`) + '\n');
})();
