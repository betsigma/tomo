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
  assert.ok(m.text.includes('Meeting this Friday at 3pm'), 'embed text is passed on for the Analyst');
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
  assert.deepStrictEqual(ids, ['overdue', 'soon', 'far']);
  assert.strictEqual(built.sent, 3);
  assert.strictEqual(built.eligible, 3);
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

console.log('\n13. Reality check: actual minutes versus the Analyst estimate');
const Reality = require('./reality.js');

check('a finished focus block records minutes and drops junk', () => {
  const log = { sessions: [] };
  Reality.addSession(log, { taskId: 'lab', minutes: 25, at: '2026-10-25T10:00:00.000Z' });
  Reality.addSession(log, { taskId: 'lab', minutes: 25, at: '2026-10-25T11:00:00.000Z' });
  Reality.addSession(log, { taskId: '', minutes: 25 });
  Reality.addSession(log, { taskId: 'lab', minutes: 0 });
  Reality.addSession(log, { taskId: 'lab', minutes: 500 });
  assert.strictEqual(log.sessions.length, 2);
  assert.strictEqual(log.sessions[0].minutes, 25);
});

check('estimate history pairs each estimate with the minutes actually spent', () => {
  const tasks = [
    { id: 'lab', effort_estimate_minutes: 40 },
    { id: 'essay', effort_estimate_minutes: 60 },
    { id: 'unread', effort_estimate_minutes: 30 }
  ];
  const log = { sessions: [
    { taskId: 'lab', minutes: 25 },
    { taskId: 'lab', minutes: 25 },
    { taskId: 'essay', minutes: 30 }
  ] };
  assert.deepStrictEqual(Reality.estimateHistory(tasks, log), [
    { task_id: 'lab', estimated_minutes: 40, actual_minutes: 50 },
    { task_id: 'essay', estimated_minutes: 60, actual_minutes: 30 }
  ]);
});

check('the card says how far estimates usually are', () => {
  const history = [
    { task_id: 'a', estimated_minutes: 100, actual_minutes: 120 },
    { task_id: 'b', estimated_minutes: 50, actual_minutes: 40 }
  ];
  assert.strictEqual(Reality.offLabel(history), 'your estimates are usually 20% off');
  assert.strictEqual(Reality.offLabel([]), null);
});

checkAsync('the Planner receives focus history built from the ranked tasks', async () => {
  const dir = tmpData();
  const seen = [];
  const client = fakeTeamClient({
    MAIL: { ok: true, source: 'live', output: { important_emails: [], events: [] } },
    ANALYST: { ok: true, source: 'live', output: { tasks: [{ id: 'lab', effort_estimate_minutes: 40, priority_rank: 1 }], crunch_weeks: [] } },
    PLANNER: { ok: true, source: 'mock', output: { proposals: [], adjustment_note: '' } },
    DIGEST: { ok: true, source: 'mock', output: { morning_brief: 'Hi.', team_digest: ['a', 'b', 'c'] } }
  });
  const orig = client.run;
  client.run = async (role, input, opts) => {
    seen.push({ role, input });
    return orig(role, input, opts);
  };
  const orch = createOrchestrator({
    client, dataDir: dir,
    loadStore: () => ({ events: [], settings: {}, todos: [openTodo('lab', '2026-10-24')] }),
    emit: () => {}, log: () => {}, now: () => new Date(2026, 9, 24, 12, 0, 0),
    getEstimateHistory: (tasks) => Reality.estimateHistory(tasks, { sessions: [{ taskId: 'lab', minutes: 50 }] })
  });
  try { await orch.runTeam('schedule'); }
  finally { orch.stop(); }
  const planner = seen.find((c) => c.role === 'PLANNER');
  assert.ok(planner, 'planner did not run');
  assert.deepStrictEqual(planner.input.estimate_history, [
    { task_id: 'lab', estimated_minutes: 40, actual_minutes: 50 }
  ]);
});

console.log('\n14. Approval inbox: only an approval enters the calendar');
const Inbox = require('./inbox.js');

function inboxOutputs() {
  return {
    PLANNER: { proposals: [{ task_id: 'lab', title: 'Lab block', start: '2026-10-24T13:00', end: '2026-10-24T13:40', reason: 'Free after lecture' }] },
    MAIL: {
      important_emails: [{ subject: 'Aid', summary: 'Upload the form.', reason: 'Deadline Friday', event_date: '2026-10-25' }],
      events: [{ title: 'Aid deadline', date: '2026-10-25', start_time: '17:00', location: 'Portal', source_subject: 'Aid' }]
    },
    ANALYST: { tasks: [
      { id: 'email-1', title: 'Upload aid form', due_date: '2026-10-25', summary: 'One missing document.', urgency_reason: 'Due Friday', source: 'email' },
      { id: 'canvas-1', title: 'Lab 5', due_date: '2026-10-24', summary: 'Write the report.', urgency_reason: 'Due today', source: 'canvas' }
    ] }
  };
}

check('pending proposals are planner blocks, mail dates, and email tasks only', () => {
  const items = Inbox.listProposals(inboxOutputs());
  assert.deepStrictEqual(items.map((p) => p.kind), ['block', 'mail', 'email-task']);
  assert.strictEqual(items[0].key, 'agent:block:lab:2026-10-24T13:00');
  assert.strictEqual(items[0].reason, 'Free after lecture');
  assert.strictEqual(items[1].summary, 'Upload the form.');
  assert.strictEqual(items[2].summary, 'One missing document.');
});

check('a rejected proposal stays out of the calendar and out of Pending', () => {
  const store = { events: [], todos: [] };
  const proposal = Inbox.listProposals(inboxOutputs())[0];
  Inbox.rejectProposal(store, proposal, () => 'tomb');
  assert.strictEqual(store.events.length, 1);
  assert.strictEqual(store.events[0].status, 'dismissed');
  assert.strictEqual(store.events[0].dedupeKey, proposal.key);
  assert.strictEqual(store.events[0].source, 'agent');
  assert.deepStrictEqual(Inbox.pendingProposals(inboxOutputs(), store).map((p) => p.key).includes(proposal.key), false);
});

check('approve adds one calendar event; edit keeps the same key', () => {
  const store = { events: [], todos: [] };
  const proposal = Inbox.listProposals(inboxOutputs())[1];
  Inbox.approveProposal(store, proposal, { title: 'Aid office', time: '16:30' }, () => 'ev1');
  Inbox.approveProposal(store, proposal, null, () => 'ev2');
  assert.strictEqual(store.events.length, 1);
  assert.strictEqual(store.events[0].status, 'active');
  assert.strictEqual(store.events[0].source, 'agent');
  assert.strictEqual(store.events[0].title, 'Aid office');
  assert.strictEqual(store.events[0].time, '16:30');
  assert.strictEqual(store.events[0].start, '2026-10-25');
  assert.strictEqual(store.events[0].dedupeKey, proposal.key);
  assert.strictEqual(Inbox.pendingProposals(inboxOutputs(), store).some((p) => p.key === proposal.key), false);
});

console.log('\n15. Track 1: live email list comes only from the Mail Scanner');
const Feed = require('./agentFeed.js');

check('live mode ignores the local Gmail list', () => {
  const view = Feed.emailList({
    globalMode: 'live',
    mail: { status: 'done', mode: 'live' },
    mailOutput: { important_emails: [{ subject: 'Aid', sender: 'finaid@deanza.edu', summary: 'Upload it', link: 'https://example.edu' }], events: [] },
    localEmails: [{ subject: 'Local newsletter', from: 'news@school.edu' }]
  });
  assert.deepStrictEqual(view.emails.map((e) => e.subject), ['Aid']);
  assert.strictEqual(view.banner, null);
});

check('a missing or failed Mail Scanner does not fall back to local Gmail', () => {
  const view = Feed.emailList({
    globalMode: 'live',
    mail: { status: 'error', mode: 'live' },
    mailOutput: null,
    localEmails: [{ subject: 'Local newsletter', from: 'news@school.edu' }]
  });
  assert.deepStrictEqual(view.emails, []);
  assert.strictEqual(view.banner, 'Mail Scanner offline');
});

check('mock mode uses agent sample data and says mock', () => {
  const view = Feed.emailList({
    globalMode: 'mock',
    mail: { status: 'mock', mode: 'mock' },
    mailOutput: { important_emails: [{ subject: 'Demo aid', sender: 'a@b.edu', summary: 'Demo' }], events: [] },
    localEmails: [{ subject: 'Local newsletter', from: 'news@school.edu' }],
    localSyncEnabled: false
  });
  assert.deepStrictEqual(view.emails.map((e) => e.subject), ['Demo aid']);
  assert.strictEqual(view.banner, 'mock');
});

check('the local Gmail list is used only when that restore setting is on and mode is not live', () => {
  const local = [{ subject: 'Local newsletter', from: 'news@school.edu' }];
  const restored = Feed.emailList({
    globalMode: 'mock', mail: { status: 'mock', mode: 'mock' }, mailOutput: null,
    localEmails: local, localSyncEnabled: true
  });
  assert.strictEqual(restored.kind, 'local');
  assert.strictEqual(restored.emails[0].subject, 'Local newsletter');
  const blocked = Feed.emailList({
    globalMode: 'live', mail: { status: 'done', mode: 'live' },
    mailOutput: { important_emails: [], events: [] },
    localEmails: local, localSyncEnabled: true
  });
  assert.notStrictEqual(blocked.kind, 'local');
});

check('live mode hides email events that came from the local Gmail sync', () => {
  const events = [
    { id: '1', source: 'gmail', title: 'Parsed from Gmail' },
    { id: '2', source: 'canvas', title: 'Quiz' },
    { id: '3', source: 'agent', title: 'Approved block' }
  ];
  assert.deepStrictEqual(Feed.visibleEvents(events, 'live').map((e) => e.id), ['2', '3']);
  assert.strictEqual(Feed.visibleEvents(events, 'mock').length, 3);
});

check('task order uses the Analyst only when agent ranks exist', () => {
  const todos = [{ id: 'b', title: 'B' }, { id: 'a', title: 'A' }, { id: 'c', title: 'C' }];
  assert.deepStrictEqual(Feed.orderTodos(todos, null).map((t) => t.id), ['b', 'a', 'c']);
  assert.deepStrictEqual(
    Feed.orderTodos(todos, [{ id: 'a', priority_rank: 1 }, { id: 'b', priority_rank: 2 }]).map((t) => t.id),
    ['a', 'b', 'c']
  );
});

checkAsync('CREAO_MODE=live never requests Google', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
  };
  let threw = false;
  try {
    await llm.callModel({
      prompt: 'Please rank this private email body',
      apiKey: 'gemini-secret',
      fetchImpl,
      creaoMode: 'live'
    });
  } catch { threw = true; }
  assert.deepStrictEqual(urls, []);
  assert.strictEqual(threw, true);
});

console.log('\n16. Pending cards: one task, not one block');
const T = require('./teamInputs.js');

check('duplicate Canvas titles with the same course and due date merge', () => {
  const tasks = [
    { id: 'short', title: 'Midterm [F26 CIS D022A 06Z Online]', due_date: '2026-11-02', course: '', description: null },
    { id: 'long', title: 'Week 5 Assignments - Midterm [F26 CIS D022A 06Z Online]', due_date: '2026-11-02', course: '', description: 'write the midterm' },
    { id: 'other', title: 'Lab 3 [F26 PHYS 4A 01Y]', due_date: '2026-11-02', course: '', description: null }
  ];
  const result = T.mergeDuplicateTasks(tasks);
  assert.deepStrictEqual(result.tasks.map((t) => t.id), ['long', 'other']);
  assert.strictEqual(result.merged.length, 1);
  assert.strictEqual(result.merged[0].kept, 'Week 5 Assignments - Midterm [F26 CIS D022A 06Z Online]');
  assert.strictEqual(result.merged[0].dropped, 'Midterm [F26 CIS D022A 06Z Online]');
});

check('proposals group into one card and flag blocks after the due date', () => {
  const proposals = [
    { task_id: 'lab', title: 'Lab 5', start: '2026-10-24T09:00', end: '2026-10-24T09:45', reason: 'first' },
    { task_id: 'lab', title: 'Lab 5', start: '2026-10-24T09:00', end: '2026-10-24T09:45', reason: 'dup' },
    { task_id: 'lab', title: 'Lab 5', start: '2026-10-24T10:00', end: '2026-10-24T10:45', reason: 'second' },
    { task_id: 'lab', title: 'Lab 5', start: '2026-10-26T09:00', end: '2026-10-26T09:45', reason: 'late' },
    { task_id: 'lab', title: 'Lab 5', start: '2026-10-27T09:00', end: '2026-10-27T09:45', reason: 'later' }
  ];
  const cards = Inbox.groupProposals(proposals, { lab: '2026-10-26' });
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].count, 4);
  assert.strictEqual(cards[0].totalMinutes, 180);
  assert.strictEqual(cards[0].blocks[0].label, 'Part 1/4 · 09:00-09:45 (45 min)');
  assert.strictEqual(cards[0].blocks[2].afterDeadline, false);
  assert.strictEqual(cards[0].blocks[3].afterDeadline, true);
});

check('a new team run replaces older pending blocks for the same task', () => {
  const previous = [
    { task_id: 'lab', title: 'Lab 5', start: '2026-10-24T09:00', end: '2026-10-24T09:45' },
    { task_id: 'essay', title: 'Essay', start: '2026-10-25T11:00', end: '2026-10-25T11:40' }
  ];
  const next = [
    { task_id: 'lab', title: 'Lab 5', start: '2026-10-24T13:00', end: '2026-10-24T13:40' }
  ];
  const replaced = Inbox.replacePending(previous, next);
  assert.deepStrictEqual(replaced.map((p) => p.task_id + p.start), [
    'essay2026-10-25T11:00',
    'lab2026-10-24T13:00'
  ]);
});

check('the morning brief is split into bullets', () => {
  const bullets = Inbox.briefBullets('Lab is due Friday. Start the essay tonight. Ask if you get stuck.');
  assert.deepStrictEqual(bullets, [
    'Lab is due Friday.',
    'Start the essay tonight.',
    'Ask if you get stuck.'
  ]);
});

console.log('\n17. One task list: approved agent tasks + manual tasks');
const visibleTasks = (todos, opts) => Feed.taskList(todos, opts);

check('live offline shows manual tasks only', () => {
  const todos = [
    { id: 'm1', title: 'Manual', source: 'manual', done: false },
    { id: 'a1', title: 'Agent', source: 'agent', done: false }
  ];
  const view = Feed.taskList(todos, { globalMode: 'live', analystOffline: true });
  assert.deepStrictEqual(view.tasks.map((t) => t.id), ['m1']);
  assert.strictEqual(view.banner, 'Task Analyst offline');
});

check('live online shows approved and manual tasks', () => {
  const todos = [
    { id: 'm1', title: 'Manual', source: 'manual', done: false },
    { id: 'a1', title: 'Agent', source: 'agent', done: false }
  ];
  const view = Feed.taskList(todos, { globalMode: 'live', analystOffline: false });
  assert.deepStrictEqual(view.tasks.map((t) => t.id), ['m1', 'a1']);
  assert.strictEqual(view.banner, null);
});

check('the Analyst pool comes from archived Canvas inputs, not the task list', () => {
  const store = {
    todos: [{ id: 'm1', title: 'Manual', source: 'manual', due: '2026-10-24', done: false }],
    archived: { legacy_canvas: [
      { id: 'c1', title: 'Lab 5', due: '2026-10-24', course: 'PHYS 4A', dedupeKey: 'canvas:c1' }
    ] },
    events: []
  };
  const built = T.buildAnalystInput(store, {}, [], new Date(2026, 9, 24, 12));
  assert.deepStrictEqual(built.input.tasks.map((t) => t.id), ['c1']);
});

check('approving the same Analyst task twice keeps one task and updates it', () => {
  const store = { events: [], todos: [] };
  const proposal = { id: 'c1', title: 'Lab 5', due: '2026-10-24', priority_rank: 2, summary: 'Write it', effort_estimate_minutes: 40, source: 'canvas' };
  Inbox.approveTask(store, proposal, null, () => 't1');
  Inbox.approveTask(store, proposal, { title: 'Lab 5 (edited)' }, () => 't2');
  assert.strictEqual(store.todos.length, 1);
  assert.strictEqual(store.todos[0].id, 'c1');
  assert.strictEqual(store.todos[0].source, 'agent');
  assert.strictEqual(store.todos[0].title, 'Lab 5 (edited)');
});

check('a rerun updates summary and priority on the approved task', () => {
  const store = { events: [], todos: [{ id: 'c1', source: 'agent', agentTaskId: 'c1', summary: 'old', priority_rank: 5 }] };
  Inbox.applyTaskUpdates(store, { ANALYST: { tasks: [{ id: 'c1', summary: 'new', priority_rank: 1, effort_estimate_minutes: 50 }] } });
  assert.strictEqual(store.todos[0].summary, 'new');
  assert.strictEqual(store.todos[0].priority_rank, 1);
});

check('rejected tasks are remembered and not proposed again', () => {
  const store = { events: [], todos: [], agentRejects: [] };
  const proposal = { id: 'c2', title: 'Essay', due: '2026-10-26' };
  Inbox.rejectTask(store, proposal, () => 'x');
  assert.deepStrictEqual(store.agentRejects, ['c2']);
  const pending = Inbox.pendingTaskProposals({ ANALYST: { tasks: [proposal] } }, store);
  assert.strictEqual(pending.length, 0);
});

check('the task inbox shows only unapproved Analyst tasks', () => {
  const store = { events: [], todos: [{ id: 'c1', source: 'agent', agentTaskId: 'c1' }], agentRejects: [] };
  const pending = Inbox.pendingTaskProposals({ ANALYST: { tasks: [
    { id: 'c1', title: 'Done already' },
    { id: 'c2', title: 'New one' }
  ] } }, store);
  assert.deepStrictEqual(pending.map((p) => p.id), ['c2']);
});

check('Analyst tasks join the list automatically, and reject removes one', () => {
  const store = { events: [], todos: [], agentRejects: [] };
  const outputs = { ANALYST: { tasks: [
    { id: 'c1', title: 'Lab 5', due_date: '2026-10-26', priority_rank: 1 },
    { id: 'c2', title: 'Essay', due_date: '2026-10-27', priority_rank: 2 }
  ] } };
  assert.strictEqual(Inbox.autoAddTasks(store, outputs), 2);
  assert.deepStrictEqual(store.todos.map((t) => t.id), ['c1', 'c2']);
  assert.strictEqual(Inbox.autoAddTasks(store, outputs), 0);
  Inbox.rejectTask(store, { id: 'c1' });
  assert.deepStrictEqual(store.todos.map((t) => t.id), ['c2']);
  assert.strictEqual(Inbox.autoAddTasks(store, outputs), 0);
});

console.log('\n18. Spam, hidden mail, and the deadline scope');
check('hidden mail and spam senders stay out of the list', () => {
  const view = Feed.emailList({
    globalMode: 'live',
    mail: { status: 'done', mode: 'live' },
    mailOutput: { important_emails: [
      { subject: 'Aid', sender: 'finaid@deanza.edu', category: 'important' },
      { subject: 'Deal', sender: 'shop@example.com', category: 'advertisement' },
      { subject: 'Junk', sender: 'spam@example.com' },
      { subject: 'Hidden one', sender: 'news@example.com' }
    ], events: [] },
    hiddenKeys: ['news@example.com::Hidden one'],
    spamSenders: ['spam@example.com']
  });
  assert.deepStrictEqual(view.emails.map((e) => e.subject), ['Aid']);
  assert.deepStrictEqual(view.spam.map((e) => e.subject), ['Deal']);
  assert.deepStrictEqual(view.hidden.map((e) => e.subject), ['Junk', 'Hidden one']);
});

check('mail without a category counts as important', () => {
  const view = Feed.emailList({
    globalMode: 'live', mail: { status: 'done', mode: 'live' },
    mailOutput: { important_emails: [{ subject: 'No category', sender: 'a@b.edu' }], events: [] }
  });
  assert.deepStrictEqual(view.emails.map((e) => e.subject), ['No category']);
});

check('the planning horizon comes from settings', () => {
  const now = new Date(2026, 9, 24, 12);
  const store = { events: [], todos: [], archived: { legacy_canvas: [
    { id: 'soon', title: 'Soon', due: '2026-10-26', course: 'PHYS 4A', dedupeKey: 'canvas:soon' },
    { id: 'late', title: 'Late', due: '2026-11-10', course: 'PHYS 4A', dedupeKey: 'canvas:late' }
  ] } };
  const short = teamInputs.buildAnalystInput(store, {}, [], now, { horizonDays: 7 });
  const wide = teamInputs.buildAnalystInput(store, {}, [], now, { horizonDays: 21 });
  assert.deepStrictEqual(short.input.tasks.map((t) => t.id), ['soon']);
  assert.deepStrictEqual(wide.input.tasks.map((t) => t.id), ['soon', 'late']);
});

checkAsync('the orchestrator uses the saved planning horizon', async () => {
  const dir = tmpData();
  const seen = [];
  const client = fakeTeamClient({
    MAIL: { ok: true, source: 'live', output: { important_emails: [], events: [] } },
    ANALYST: { ok: true, source: 'live', output: { tasks: [], crunch_weeks: [] } },
    PLANNER: { ok: true, source: 'mock', output: { proposals: [], adjustment_note: '' } },
    DIGEST: { ok: true, source: 'mock', output: { morning_brief: 'Hi.', team_digest: ['a', 'b', 'c'] } }
  });
  const orig = client.run;
  client.run = async (role, input, opts) => { seen.push({ role, input }); return orig(role, input, opts); };
  const orch = createOrchestrator({
    client, dataDir: dir,
    loadStore: () => ({
      events: [], todos: [], settings: { team: { horizonDays: 21 } },
      archived: { legacy_canvas: [{ id: 'late', title: 'Late', due: '2026-11-10', course: 'PHYS 4A', dedupeKey: 'canvas:late' }] }
    }),
    emit: () => {}, log: () => {}, now: () => new Date(2026, 9, 24, 12, 0, 0)
  });
  try { await orch.runTeam('schedule'); }
  finally { orch.stop(); }
  const analyst = seen.find((c) => c.role === 'ANALYST');
  assert.deepStrictEqual(analyst.input.tasks.map((t) => t.id), ['late']);
});

check('study blocks wait for approval, and edit keeps the key', () => {
  const store = { events: [], todos: [] };
  const outputs = { PLANNER: { proposals: [
    { task_id: 'lab', title: 'Lab 5', start: '2026-10-24T09:00', end: '2026-10-24T09:45', reason: 'free' }
  ] } };
  assert.strictEqual(typeof Inbox.autoAddProposals, 'undefined', 'blocks are never auto-added');
  assert.strictEqual(Inbox.pendingProposals(outputs, store).length, 1, 'the block waits in the inbox');
  assert.strictEqual(store.events.length, 0, 'nothing on the calendar yet');
  Inbox.approveProposal(store, Inbox.listProposals(outputs)[0], null, () => 'ev1');
  assert.strictEqual(Inbox.pendingProposals(outputs, store).length, 0, 'approved blocks leave the inbox');
  const key = store.events[0].dedupeKey;
  Inbox.editProposal(store, Inbox.listProposals(outputs)[0], { title: 'Lab 5 v2', time: '10:00' });
  assert.strictEqual(store.events.length, 1);
  assert.strictEqual(store.events[0].title, 'Lab 5 v2');
  assert.strictEqual(store.events[0].time, '10:00');
  assert.strictEqual(store.events[0].dedupeKey, key);
});

check('Discord messages go to the Analyst, and its dates wait in the Inbox', () => {
  const T = require('./teamInputs.js');
  const { normalizeDiscordMessage } = require('./discord.js');
  const now = new Date(2026, 9, 25, 12, 0, 0);
  const msg = normalizeDiscordMessage({
    id: '9', timestamp: '2026-10-25T10:00:00Z', author: { username: 'Club' },
    content: 'Women in STEM meeting\nThursday Oct 29, 5pm in S34'
  }, 'announcements');
  assert.strictEqual(msg.event, undefined, 'no local date parsing');
  assert.ok(msg.text.includes('Thursday Oct 29'), 'full text, not just the first line');
  const old = { uid: 'old', content: 'Last month', text: 'Last month', timestamp: '2026-09-01T10:00:00Z' };
  const built = T.buildAnalystInput({ events: [], todos: [], discord: [msg, old] }, {}, [], now);
  assert.deepStrictEqual(built.input.discord_messages.map((m) => m.id), ['9'], 'only the last 14 days');

  const store = { events: [], todos: [] };
  const outputs = { ANALYST: { tasks: [], crunch_weeks: [], events: [
    { title: 'Women in STEM meeting', date: '2026-10-29', start_time: '17:00', end_time: '18:00', location: 'S34', summary: 'Club meeting.', source_id: '9' }
  ] } };
  const pending = Inbox.pendingProposals(outputs, store);
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].kind, 'discord');
  assert.strictEqual(store.events.length, 0, 'not on the calendar until approved');
  Inbox.approveProposal(store, pending[0], null, () => 'd1');
  assert.strictEqual(store.events[0].time, '17:00');
  assert.strictEqual(Inbox.pendingProposals(outputs, store).length, 0);
});

check('the same Discord meeting posted twice shows once, with its end time', () => {
  const ev = (end) => ({ title: 'Club meeting', date: '2026-10-29', start_time: '17:00', end_time: end, location: 'S34', summary: '', source_id: end || 'x' });
  for (const order of [[ev(''), ev('18:00')], [ev('18:00'), ev('')]]) {
    const list = Inbox.listProposals({ ANALYST: { tasks: [], crunch_weeks: [], events: order } }).filter((p) => p.kind === 'discord');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].endTime, '18:00');
  }
});

check('an Analyst task with an empty id gets a stable id from its title', () => {
  const T = require('./teamInputs.js');
  const out = T.fillTaskIds([
    { id: 't1', title: 'Lab 5' },
    { id: '', title: 'Financial aid: action required by Friday' },
    { title: 'Club dues' }
  ]);
  assert.deepStrictEqual(out.map((t) => t.id), ['t1', 'email-financial-aid-action-required-by-friday', 'email-club-dues']);
  assert.strictEqual(T.fillTaskIds([{ id: '', title: 'Club dues' }])[0].id, 'email-club-dues', 'same title, same id');
});

console.log('\n19. Weekly Discord digest');
const Discord = require('./discord.js');

check('the digest is a short bulleted message', () => {
  const msg = Discord.digestMessage(['Lab is due Friday.', 'Essay draft tonight.', 'Ask for help early.']);
  assert.ok(msg.includes('Lab is due Friday.'));
  assert.ok(msg.split('\n').length === 4, 'heading plus three bullets');
});

check('the digest stays under the Discord message limit', () => {
  const msg = Discord.digestMessage(['x'.repeat(3000)]);
  assert.ok(msg.length <= 1900);
});

check('a weekly digest is due on Monday after 9 AM, once', () => {
  const monday10 = new Date(2026, 9, 26, 10, 0, 0);
  const monday8 = new Date(2026, 9, 26, 8, 0, 0);
  const lastWeek = new Date(2026, 9, 19, 10, 0, 0).toISOString();
  const thisWeek = new Date(2026, 9, 26, 10, 30, 0).toISOString();
  assert.strictEqual(Discord.weeklyDue(null, monday10, true), true);
  assert.strictEqual(Discord.weeklyDue(null, monday8, true), false);
  assert.strictEqual(Discord.weeklyDue(lastWeek, monday10, true), true);
  assert.strictEqual(Discord.weeklyDue(thisWeek, monday10, true), false);
  assert.strictEqual(Discord.weeklyDue(lastWeek, monday10, false), false);
});

// Run the async checks, then print the summary.
(async () => {
  for (const { name, fn } of asyncChecks) {
    try { await fn(); pass++; console.log('  ok  - ' + name); }
    catch (e) { console.error('  FAIL - ' + name + '\n        ' + e.message); process.exitCode = 1; }
  }
  console.log('\n' + (process.exitCode ? 'Some tests FAILED.' : `All ${pass} checks passed.`) + '\n');
})();
