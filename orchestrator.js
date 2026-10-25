// orchestrator.js
// ---------------------------------------------------------------------------
// Runs the agent team in order and hands each agent's output to the next:
//
//   Mail Scanner -> Deadline & Task Analyst -> Planner -> Digest Writer
//
// Triggered on a schedule (every N hours) and by the "Run team" button. Lives
// in the main process; the renderer only receives the public state via `emit`.
// State (statuses, handoffs, outputs, the Analyst's per-task cache) is kept in
// data/agent-team.json so the tab opens instantly with the last results.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const T = require('./teamInputs');
const Inbox = require('./inbox');
const { excludedKeyword } = require('./gmail');

const ORDER = ['MAIL', 'ANALYST', 'PLANNER', 'DIGEST'];

function createOrchestrator(opts) {
  const { client, dataDir, loadStore } = opts;
  const emit = opts.emit || (() => {});
  const log = opts.log || ((m) => console.log(m));
  const now = opts.now || (() => new Date());
  const onExcluded = opts.onExcluded || (() => {});
  const getEstimateHistory = opts.getEstimateHistory || (() => []);
  const file = path.join(dataDir, 'agent-team.json');

  let timer = null;
  let running = false;
  let state = load();

  function blankNode() { return { status: 'idle', at: null, source: null, cached: false, error: null, handoff: null }; }
  function load() {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    const nodes = {};
    for (const r of ORDER) nodes[r] = { ...blankNode(), ...((s.nodes || {})[r] || {}) };
    // A run cannot survive an app restart.
    for (const r of ORDER) if (nodes[r].status === 'running') nodes[r].status = 'idle';
    return {
      nodes,
      outputs: s.outputs || {},
      analystCache: s.analystCache || {},
      lastRun: s.lastRun || null,
      nextRunAt: null,
      intervalHours: s.intervalHours || 3,
      analystSent: s.analystSent || null
    };
  }
  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(file + '.tmp', file);
    } catch (err) { log('[team] could not save state: ' + err.message); }
  }

  // What the renderer sees (no per-task cache internals).
  function publicState() {
    const cs = client.status();
    const modes = Object.fromEntries(cs.roles.map((r) => [r.role, r]));
    return {
      running,
      order: ORDER,
      nodes: Object.fromEntries(ORDER.map((r) => [r, {
        ...state.nodes[r],
        name: modes[r].name,
        mode: modes[r].mode,               // 'live' | 'mock' (key missing or CREAO_MODE=mock)
        runsLastHour: modes[r].runsLastHour
      }])),
      globalMode: cs.globalMode,
      maxRunsPerHour: cs.maxRunsPerHour,
      outputs: state.outputs,
      lastRun: state.lastRun,
      nextRunAt: state.nextRunAt,
      intervalHours: state.intervalHours,
      analystSent: state.analystSent || null
    };
  }
  function update(role, patch) {
    if (role) state.nodes[role] = { ...state.nodes[role], ...patch };
    emit(publicState());
  }

  // Map a creaoClient result onto a node status.
  function finish(role, r, handoff) {
    const status = !r.ok ? 'error' : r.source === 'mock' ? 'mock' : 'done';
    const error = r.ok ? null : (r.error || 'Unknown error') + (r.output ? ' — showing the last good result.' : '');
    update(role, { status, at: now().toISOString(), source: r.source, cached: !!r.cached, error, handoff });
  }

  async function step(role, input, force) {
    update(role, { status: 'running', error: null });
    return client.run(role, input, { force, onStatus: () => {} });
  }

  // A failed agent stops the chain. Earlier outputs stay. The error is caught
  // below, so a bad reply never crashes the app.
  function halt(role, result, why) {
    finish(role, { ...(result || {}), ok: false, error: (result && result.error) || why }, null);
    throw new Error(why);
  }

  // Run the whole team once. `force` skips the input-hash cache (the hourly
  // cap still applies). Never throws.
  async function runTeam(trigger = 'manual', { force = false } = {}) {
    if (running) return publicState();
    running = true;
    const startedAt = now();
    for (const r of ORDER) update(r, { status: 'idle', handoff: state.nodes[r].handoff });
    log(`[team] run started (${trigger})`);

    try {
      const store = loadStore();
      const excludeList = store.settings && store.settings.gmail ? store.settings.gmail.excludeKeywords : undefined;

      // 1) Mail Scanner
      const mail = await step('MAIL', { lookback_hours: 24, max_results: 10 }, force);
      if (!mail.ok || !mail.output) halt('MAIL', mail, 'Mail Scanner failed');
      const dropped = [];
      const emails = mail.output.important_emails.filter((m) => {
        const kw = excludedKeyword(m.subject, m.summary, excludeList);
        if (kw) dropped.push({ subject: m.subject, sender: m.sender, keyword: kw });
        return !kw;
      });
      const droppedSubjects = new Set(dropped.map((m) => m.subject));
      const mailEvents = mail.output.events.filter((e) => !droppedSubjects.has(e.source_subject) &&
        !excludedKeyword(e.title + ' ' + e.source_subject, '', excludeList));
      if (dropped.length) onExcluded(dropped);
      state.outputs.MAIL = { important_emails: emails, events: mailEvents };
      finish('MAIL', mail, `${emails.length} important email${emails.length === 1 ? '' : 's'} · ${mailEvents.length} date${mailEvents.length === 1 ? '' : 's'}`);

      // 2) Deadline & Task Analyst (only new/changed tasks carry a description)
      const built = T.buildAnalystInput(store, state.analystCache, emails, now());
      const aIn = built.input;
      const hashes = built.hashes;
      state.analystSent = { sent: built.sent, eligible: built.eligible };
      const fresh = aIn.tasks.filter((t) => t.description !== null).length;
      const analyst = await step('ANALYST', aIn, force);
      if (!analyst.ok || !analyst.output) halt('ANALYST', analyst, 'Deadline & Task Analyst failed');
      let ranked = analyst.output.tasks;
      if (analyst.source === 'live' || analyst.source === 'cache') {
        const merged = T.mergeAnalyst(analyst.output, aIn, hashes, state.analystCache);
        ranked = merged.tasks;
        if (analyst.ok && analyst.source === 'live') state.analystCache = merged.cache;
      }
      state.outputs.ANALYST = { tasks: ranked, crunch_weeks: analyst.output.crunch_weeks };
      finish('ANALYST', analyst, `sent ${built.sent} of ${built.eligible} · ${ranked.length} ranked task${ranked.length === 1 ? '' : 's'} (${fresh} with new text) · ${analyst.output.crunch_weeks.length} crunch week${analyst.output.crunch_weeks.length === 1 ? '' : 's'}`);

      // 3) Planner (proposals only; checked against the real calendar)
      const calendar = T.buildCalendar(store, now());
      const team = (store.settings && store.settings.team) || {};
      const windows = T.freeWindows(calendar, now(), { dayStart: team.dayStart, dayEnd: team.dayEnd });
      const pIn = {
        ranked_tasks: ranked.slice(0, 12),
        calendar,
        free_windows: windows,
        estimate_history: getEstimateHistory(ranked)
      };
      const planner = await step('PLANNER', pIn, force);
      if (!planner.ok || !planner.output) halt('PLANNER', planner, 'Planner failed');
      // Mock samples are not tied to the real calendar, so only live output is rule-checked.
      const checked = planner.source === 'mock'
        ? { kept: planner.output.proposals, dropped: [] }
        : T.checkProposals(planner.output.proposals, calendar, windows);
      const previous = (state.outputs.PLANNER && state.outputs.PLANNER.proposals) || [];
      state.outputs.PLANNER = {
        proposals: Inbox.replacePending(previous, checked.kept),
        adjustment_note: planner.output.adjustment_note,
        dropped: checked.dropped
      };
      finish('PLANNER', planner, `${checked.kept.length} study block${checked.kept.length === 1 ? '' : 's'} proposed` +
        (checked.dropped.length ? ` (${checked.dropped.length} dropped by rule check)` : ''));

      // 4) Digest Writer
      const digest = await step('DIGEST', {
        ranked_tasks: ranked, crunch_weeks: analyst.output.crunch_weeks, proposed_blocks: checked.kept
      }, force);
      if (!digest.ok || !digest.output) halt('DIGEST', digest, 'Digest Writer failed');
      state.outputs.DIGEST = digest.output;
      finish('DIGEST', digest, `morning brief + ${digest.output.team_digest.length} digest bullets`);

      state.lastRun = { at: startedAt.toISOString(), finishedAt: now().toISOString(), trigger, ok: true };
    } catch (err) {
      log('[team] run stopped: ' + err.message);
      state.lastRun = { at: startedAt.toISOString(), finishedAt: now().toISOString(), trigger, ok: false, error: err.message };
    } finally {
      running = false;
      persist();
      scheduleNext();
      emit(publicState());
    }
    return publicState();
  }

  // ----- schedule -----
  function scheduleNext() {
    clearTimeout(timer);
    const ms = state.intervalHours * 3600000;
    const last = state.lastRun ? new Date(state.lastRun.at).getTime() : 0;
    // Overdue (or never run): go shortly after start-up instead of immediately.
    const at = Math.max(Date.now() + 30000, last + ms);
    state.nextRunAt = new Date(at).toISOString();
    timer = setTimeout(() => runTeam('schedule'), at - Date.now());
  }
  function seedMocks() {
    const cs = client.status();
    if (cs.globalMode !== 'mock' || state.outputs.MAIL || typeof client.loadMock !== 'function') return;
    try {
      state.outputs.MAIL = client.loadMock('MAIL');
      state.outputs.ANALYST = client.loadMock('ANALYST');
      state.outputs.PLANNER = client.loadMock('PLANNER');
      state.outputs.DIGEST = client.loadMock('DIGEST');
      for (const r of ORDER) {
        if (state.nodes[r].status === 'idle') state.nodes[r].status = 'mock';
      }
    } catch { /* mock files are optional for tests */ }
  }
  function start(intervalHours) {
    if (intervalHours) state.intervalHours = Math.max(1, Math.min(24, Number(intervalHours) || 3));
    seedMocks();
    scheduleNext();
    emit(publicState());
  }
  function stop() { clearTimeout(timer); timer = null; }

  return { runTeam, start, stop, getState: publicState, ORDER };
}

module.exports = { createOrchestrator, ORDER };
