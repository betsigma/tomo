// scripts/test-creao.js
// ---------------------------------------------------------------------------
// npm run test:creao [-- --role=ANALYST]       one agent (spends credits)
// npm run test:creao -- --only MAIL,DIGEST     those agents only (also --only=MAIL,DIGEST)
// npm run test:creao -- --recheck              re-read the last test's runs (free)
//
// Tests each CONFIGURED agent one at a time with a small sample input and
// reports which ones work. Run IDs are saved to data/creao-last-test.json so
// --recheck can re-inspect them with plain GETs.
// Prints the SHAPE of the final run object (keys + types, no values) so the
// response format can be checked against the docs. Never prints keys or IDs.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'env.js')).loadEnv(path.join(ROOT, '.env'));
const { createClient, ROLES, ROLE_INFO, extractJson, runReply } = require(path.join(ROOT, 'creaoClient.js'));

const recheck = process.argv.includes('--recheck');
const LAST_FILE = path.join(ROOT, 'data', 'creao-last-test.json');
const lastRuns = (() => { try { return JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch { return {}; } })();
const client = createClient({ rootDir: ROOT, log: () => {} });

// Which agents this invocation should test. --only MAIL,DIGEST (or --only=MAIL,DIGEST)
// selects that list. --role=ANALYST still selects one. No flag selects every role.
// Unknown names, a missing value, or both flags together return no roles, so a typo
// never falls through to a full paid run. Order follows knownRoles, not the flag.
function selectRoles(argv, knownRoles) {
  const onlyFlag = argv.find((a) => a === '--only' || a.startsWith('--only='));
  const roleFlag = argv.find((a) => a.startsWith('--role='));
  if (onlyFlag && roleFlag) return { roles: [], error: 'Use either --only or --role, not both.' };
  if (!onlyFlag && !roleFlag) return { roles: knownRoles.slice() };

  let raw = '';
  if (onlyFlag) {
    if (onlyFlag.startsWith('--only=')) raw = onlyFlag.slice('--only='.length);
    else {
      const next = argv[argv.indexOf('--only') + 1];
      if (!next || next.startsWith('-')) {
        return { roles: [], error: `Missing roles after --only. Use one of ${knownRoles.join(', ')}.` };
      }
      raw = next;
    }
  } else {
    raw = roleFlag.slice('--role='.length);
    if (!String(raw).trim()) return { roles: knownRoles.slice() };
  }

  const names = String(raw).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const unknown = names.filter((n) => !knownRoles.includes(n));
  if (!names.length || unknown.length) {
    return { roles: [], error: `Unknown role "${unknown.join(', ') || raw}". Use one of ${knownRoles.join(', ')}.` };
  }
  const wanted = new Set(names);
  return { roles: knownRoles.filter((r) => wanted.has(r)) };
}

// Keys + types only, a few levels deep. Strings show their length, not content.
function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `array(${v.length}) of ${shape(v[0], depth + 1)}` : 'array(0)';
  if (typeof v === 'string') return `string(${v.length})`;
  if (typeof v !== 'object') return typeof v;
  if (depth > 3) return 'object{…}';
  const pad = '  '.repeat(depth + 2);
  return '{\n' + Object.keys(v).map((k) => `${pad}${k}: ${shape(v[k], depth + 1)}`).join('\n') + '\n' + '  '.repeat(depth + 1) + '}';
}

// Small sample inputs that follow each contract (built from the mock chain).
function sampleInput(role) {
  const analyst = client.loadMock('ANALYST');
  const planner = client.loadMock('PLANNER');
  const today = new Date().toISOString().slice(0, 10);
  if (role === 'MAIL') return { lookback_hours: 24, max_results: 5 };
  if (role === 'ANALYST') return {
    tasks: [
      { id: 't1', title: 'Lab 5: Projectile Motion report', due_date: today, course: 'PHYS 4A',
        description: 'Write a 2-page report with a data table, error analysis and a conclusion.' },
      { id: 't2', title: 'Reading response 4', due_date: today, course: 'ENGL 1A', description: null }
    ],
    important_emails: [{ subject: 'Financial aid: action required by Friday', summary: 'Upload one missing document.', event_date: today }],
    discord_messages: [{ id: 'd1', channel: 'announcements', posted_at: new Date().toISOString(),
      text: 'Women in STEM general meeting\nThis Thursday, 5-6pm in S34. Officer elections!' }],
    today
  };
  if (role === 'PLANNER') return {
    ranked_tasks: analyst.tasks.slice(0, 2),
    calendar: [{ start: `${today}T09:00`, end: `${today}T10:15`, title: 'PHYS 4A lecture' }],
    free_windows: [{ start: `${today}T13:00`, end: `${today}T18:00` }],
    estimate_history: [{ task_id: 'old-lab', estimated_minutes: 90, actual_minutes: 110 }]
  };
  return { ranked_tasks: analyst.tasks, crunch_weeks: analyst.crunch_weeks, proposed_blocks: planner.proposals };
}

// Where could the JSON be? Report each place: its shape and whether it validates.
async function diagnose(role, run, runId) {
  const r = (run && run.result) || {};
  const places = [['result.text', r.text], ['result.chatText', r.chatText]];
  for (const a of (Array.isArray(r.artifacts) ? r.artifacts : [])) {
    console.log(`  ${role}: artifact type=${a.type} title=${a.title}`);
  }
  for (const [label, val] of places) {
    if (val == null) continue;
    const parsed = extractJson(val);
    let verdict = 'no JSON';
    if (parsed) { try { client.checkOutput(role, parsed); verdict = 'VALID'; } catch (e) { verdict = e.message; } }
    console.log(`  ${role}: ${label} -> ${verdict}`);
    if (parsed) console.log(`      shape: ${shape(parsed, 1)}`);
  }
  try {
    const { from } = await client.outputFromRun(role, run, runId);
    return { ok: true, note: `valid JSON (from ${from})` };
  } catch (err) {
    return { ok: false, note: err.message };
  }
}

async function testRole(role) {
  if (!client.configured(role)) return { role, result: 'SKIPPED', note: `no CREAO_APP_ID_${role} / CREAO_KEY_${role} -> app uses mock` };
  try {
    let run, runId;
    if (recheck) {
      runId = lastRuns[role];
      if (!runId) return { role, result: 'SKIPPED', note: 'no saved run; run without --recheck first' };
      run = await client.getRun(role, runId);
    } else {
      let lastStatus = '';
      ({ run, runId } = await client.runLive(role, client.toInputs(role, sampleInput(role)), (s) => {
        if (s.runStatus && s.runStatus !== lastStatus) { lastStatus = s.runStatus; console.log(`  ${role}: ${s.runStatus}`); }
      }));
      lastRuns[role] = runId;
      fs.mkdirSync(path.dirname(LAST_FILE), { recursive: true });
      fs.writeFileSync(LAST_FILE, JSON.stringify(lastRuns, null, 2));
    }
    console.log(`  ${role}: run object shape:`);
    console.log(`    ${shape(run)}`);
    if (run.status !== 'completed') return { role, result: 'FAILED', note: `run ${run.status}${run.errorCode ? ' (' + run.errorCode + ')' : ''}` };
    const d = await diagnose(role, run, runId);
    return { role, result: d.ok ? 'OK' : 'BAD OUTPUT', note: d.note };
  } catch (err) {
    return { role, result: 'FAILED', note: String(err.message || err) };
  }
}

if (require.main === module) (async () => {
  const picked = selectRoles(process.argv, ROLES);
  if (picked.error || !picked.roles.length) {
    console.error(picked.error || `Unknown role. Use one of ${ROLES.join(', ')}.`);
    process.exit(2);
  }
  const roles = picked.roles;
  if (String(process.env.CREAO_MODE || '').toLowerCase() === 'mock') {
    console.log('Note: CREAO_MODE=mock (the app will use mocks), but configured agents are still tested live here.\n');
  }
  const results = [];
  for (const role of roles) {
    console.log(`Testing ${role} (${ROLE_INFO[role].name})...`);
    results.push(await testRole(role));
  }
  console.log('\nResults');
  for (const r of results) console.log(`  ${r.role.padEnd(8)} ${r.result.padEnd(11)} ${r.note}`);
  if (results.some((r) => r.result === 'FAILED' || r.result === 'BAD OUTPUT')) process.exitCode = 1;
})();

module.exports = { selectRoles };
