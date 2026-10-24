// scripts/test-creao.js
// ---------------------------------------------------------------------------
// npm run test:creao [-- --role=ANALYST]
//
// Tests each CONFIGURED agent one at a time with a small sample input and
// reports which ones work. Each live test spends CREAO credits (one run).
// Prints the SHAPE of the final run object (keys + types, no values) so the
// response format can be checked against the docs. Never prints keys or IDs.
// ---------------------------------------------------------------------------

const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'env.js')).loadEnv(path.join(ROOT, '.env'));
const { createClient, ROLES, ROLE_INFO, extractJson, runReply } = require(path.join(ROOT, 'creaoClient.js'));

const only = (process.argv.find((a) => a.startsWith('--role=')) || '').slice(7).toUpperCase();
const client = createClient({ rootDir: ROOT, log: () => {} });

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

async function testRole(role) {
  if (!client.configured(role)) return { role, result: 'SKIPPED', note: `no CREAO_APP_ID_${role} / CREAO_KEY_${role} -> app uses mock` };
  const started = Date.now();
  let lastStatus = '';
  try {
    const { run } = await client.runLive(role, client.toInputs(role, sampleInput(role)), (s) => {
      if (s.runStatus && s.runStatus !== lastStatus) { lastStatus = s.runStatus; process.stdout.write(`  ${role}: ${s.runStatus}\n`); }
    });
    console.log(`  ${role}: run object shape:\n    ${shape(run)}`);
    const parsed = extractJson(runReply(run));
    try {
      client.checkOutput(role, parsed);
      return { role, result: 'OK', note: `valid JSON in ${Math.round((Date.now() - started) / 1000)}s` };
    } catch (err) {
      return { role, result: 'BAD OUTPUT', note: err.message + (parsed ? `\n      parsed shape: ${shape(parsed, 1)}` : '') };
    }
  } catch (err) {
    return { role, result: 'FAILED', note: String(err.message || err) };
  }
}

(async () => {
  const roles = only ? ROLES.filter((r) => r === only) : ROLES;
  if (!roles.length) { console.error(`Unknown role "${only}". Use one of ${ROLES.join(', ')}.`); process.exit(2); }
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
