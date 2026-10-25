// creaoClient.js
// ---------------------------------------------------------------------------
// Triggers a CREAO agent by ROLE and reads back its result.
//
// API (App-scoped API Trigger, docs.creao.ai/pro/api-trigger):
//   POST {BASE}/apps/{appId}/runs            body {"inputs": {...}}  -> {id, status:"pending"}
//   GET  {BASE}/apps/{appId}/runs/{runId}    poll until completed | failed | cancelled
//   Auth: "Authorization: Bearer <capi_ key>" (one key per agent)
//   GET  {BASE}/runs/{runId}/artifacts/download?artifactId=…  -> 302 to storage
// Webhooks are not used: CREAO refuses localhost URLs, so a desktop app polls.
// A completed run carries result.text / result.chatText and, for some agents,
// result.artifacts (files). The JSON is looked for in that order.
//
// Each role has its OWN App ID and key in .env (CREAO_APP_ID_<ROLE>,
// CREAO_KEY_<ROLE>). A role with a missing key, or CREAO_MODE=mock, uses the
// sample JSON in /mock instead. Keys stay in this module: they are never
// logged, returned, or sent to the renderer.
//
// Cost guards: results are cached by a hash of the input (an unchanged input
// never re-runs), MAIL results also expire after a TTL (its input never changes
// but the inbox does), and each role is capped at N live runs per hour.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validate } = require('./schemaCheck');

const BASE_URL = 'https://agent.creao.ai/api/v1';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const ROLE_INFO = {
  MAIL:    { name: 'Important Mail Scanner',  file: 'mail',    payloadInput: false, ttlMinutes: 60 },
  ANALYST: { name: 'Deadline & Task Analyst', file: 'analyst', payloadInput: true,  ttlMinutes: null },
  PLANNER: { name: 'Planner',                 file: 'planner', payloadInput: true,  ttlMinutes: null },
  DIGEST:  { name: 'Digest Writer',           file: 'digest',  payloadInput: true,  ttlMinutes: null }
};
const ROLES = Object.keys(ROLE_INFO);

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

// Key order must not change the hash, so objects are serialized sorted.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function hashOf(v) {
  return crypto.createHash('sha256').update(stableStringify(v)).digest('hex').slice(0, 24);
}

// Pull the first JSON object out of an agent reply. Handles a bare object, a
// ```json fenced block, or prose wrapped around the JSON.
function extractJson(reply) {
  if (reply && typeof reply === 'object') return reply;
  const text = String(reply || '').trim();
  if (!text) return null;
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { /* keep looking */ }

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }

  // Scan for a balanced {...} starting at each "{", respecting strings.
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

// Where the agent's reply lives in a run. The docs show result.text and
// result.chatText (webhook payload); a few other spots are checked defensively.
function runReply(run) {
  if (!run || typeof run !== 'object') return null;
  const r = run.result;
  if (r && typeof r === 'object') {
    if (r.text) return r.text;
    if (r.chatText) return r.chatText;
    if (r.output) return r.output;
    return r;
  }
  if (typeof r === 'string') return r;
  return run.output || run.text || null;
}

// The existing Mail Scanner may still answer in the older shape
// {important:[{title: sender, subtitle: subject, importance, reason}]}. Map that
// onto the documented contract so both validate.
function normalizeMail(out) {
  if (!out || typeof out !== 'object' || Array.isArray(out.important_emails)) return out;
  if (!Array.isArray(out.important)) return out;
  return {
    important_emails: out.important.map((m) => ({
      subject: String(m.subtitle || m.subject || ''),
      sender: String(m.title || m.sender || ''),
      summary: String(m.summary || m.reason || ''),
      importance: typeof m.importance === 'number' ? Math.max(0, Math.min(100, m.importance <= 1 ? m.importance * 100 : m.importance)) : 50,
      reason: String(m.reason || ''),
      event_date: m.event_date || null,
      link: m.link || null
    })),
    events: Array.isArray(out.events) ? out.events : []
  };
}

// The Digest Writer sometimes returns team_digest as one string, or one long
// paragraph, instead of 3-6 short bullets. Split it into lines or bullet marks,
// then into its own sentences if still too few or too long; trim any sentence
// over 200 characters at a word. Nothing is invented: if the text has fewer than
// three sentences, the schema still rejects it and the last good reply is kept.
const tidyBullet = (s) => String(s).replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim();
function normalizeDigest(out) {
  if (!out || typeof out !== 'object') return out;
  const raw = out.team_digest;
  const fine = Array.isArray(raw) && raw.length >= 3 && raw.length <= 6 && raw.every((s) => typeof s === 'string' && s.length <= 200);
  if (fine || (!Array.isArray(raw) && typeof raw !== 'string')) return out;
  let items = [].concat(raw).flatMap((s) => String(s).split(/\r?\n|(?:^|\s)[•·]\s+/)).map(tidyBullet).filter(Boolean);
  if (items.length < 3 || items.some((s) => s.length > 200)) {
    items = items.flatMap((s) => s.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)).map(tidyBullet).filter(Boolean);
  }
  items = items.map((s) => (s.length > 200 ? s.slice(0, 199).replace(/\s+\S*$/, '') + '…' : s)).slice(0, 6);
  return { ...out, team_digest: items };
}

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Mock files use {{day+N}} (today + N) and {{week+N}} (Monday of this week + N
// weeks) so the offline demo always shows current dates.
function resolveMockTokens(text, now = new Date()) {
  return String(text).replace(/\{\{(day|week)([+-]\d+)\}\}/g, (_, unit, n) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (unit === 'day') d.setDate(d.getDate() + Number(n));
    else { d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 * Number(n)); }
    return localDate(d);
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
function createClient(opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const dataDir = opts.dataDir || path.join(rootDir, 'data');
  const cacheFile = path.join(dataDir, 'creao-cache.json');
  const env = opts.env || process.env;
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const now = opts.now || (() => new Date());
  const log = opts.log || ((m) => console.log(m));
  const inflight = new Map();

  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const settings = () => ({
    globalMode: String(env.CREAO_MODE || 'live').trim().toLowerCase() === 'mock' ? 'mock' : 'live',
    maxRunsPerHour: num(env.CREAO_MAX_RUNS_PER_HOUR, 4),
    pollMs: num(env.CREAO_POLL_MS, 3000),
    timeoutMs: num(env.CREAO_TIMEOUT_MS, 180000)
  });

  const creds = (role) => ({
    appId: String(env[`CREAO_APP_ID_${role}`] || '').trim(),
    key: String(env[`CREAO_KEY_${role}`] || '').trim()
  });
  const configured = (role) => { const c = creds(role); return !!(c.appId && c.key); };
  const modeOf = (role) => (settings().globalMode === 'mock' || !configured(role) ? 'mock' : 'live');

  // ----- cache file -----
  function loadCache() {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      return { roles: c.roles || {}, runLog: c.runLog || {}, errors: c.errors || {} };
    } catch { return { roles: {}, runLog: {}, errors: {} }; }
  }
  function saveCache(c) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf8');
      fs.renameSync(tmp, cacheFile);
    } catch (err) { log('[creao] could not save cache: ' + err.message); }
  }

  function schemaFor(role) {
    return JSON.parse(fs.readFileSync(path.join(rootDir, 'schemas', ROLE_INFO[role].file + '.json'), 'utf8'));
  }
  function loadMock(role) {
    const raw = fs.readFileSync(path.join(rootDir, 'mock', ROLE_INFO[role].file + '.json'), 'utf8');
    return JSON.parse(resolveMockTokens(raw, now()));
  }

  // Normalize + validate one parsed output. Throws a friendly error on failure.
  function checkOutput(role, parsed) {
    if (!parsed) throw new Error('The agent reply contained no JSON object.');
    const out = role === 'MAIL' ? normalizeMail(parsed) : role === 'DIGEST' ? normalizeDigest(parsed) : parsed;
    const errors = validate(schemaFor(role), out);
    if (errors.length) {
      const e = new Error('Reply did not match the schema: ' + errors.slice(0, 3).join('; '));
      e.schemaErrors = errors;
      throw e;
    }
    return out;
  }

  // ----- HTTP -----
  async function http(method, url, key, body) {
    const res = await doFetch(url, {
      method,
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const hint = res.status === 401 ? ' (key missing, invalid or revoked)'
        : res.status === 404 ? ' (App ID not found for this key)'
        : res.status === 402 ? ' (out of credits?)' : '';
      const code = json && (json.error || json.errorCode || json.code);
      const e = new Error(`HTTP ${res.status}${hint}${code ? ' ' + code : ''}`);
      e.status = res.status;
      throw e;
    }
    return json;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Download one artifact's text. The CREAO endpoint answers 302 to a temporary
  // storage URL; that hop is fetched WITHOUT the Authorization header so the key
  // never leaves CREAO.
  async function downloadArtifact(role, runId, artifactId) {
    const { key } = creds(role);
    const url = `${BASE_URL}/runs/${encodeURIComponent(runId)}/artifacts/download?artifactId=${encodeURIComponent(artifactId)}`;
    let res = await doFetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + key }, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers && res.headers.get && res.headers.get('location');
      if (!loc) throw new Error('Artifact redirect had no location.');
      res = await doFetch(loc, { method: 'GET' });
    }
    if (!res.ok) throw new Error(`Artifact download HTTP ${res.status}`);
    const text = await res.text();
    return text.slice(0, 2000000);
  }

  // Try each place a run can carry the agent's JSON; return the first output
  // that validates. Throws the first validation error if none does.
  async function outputFromRun(role, finished, runId) {
    const r = (finished && finished.result) || {};
    const candidates = [runReply(finished)];
    if (r.chatText && r.chatText !== candidates[0]) candidates.push(r.chatText);
    let firstErr = null;
    for (const c of candidates) {
      try { return { output: checkOutput(role, extractJson(c)), from: 'text' }; }
      catch (err) { firstErr = firstErr || err; }
    }
    const arts = Array.isArray(r.artifacts) ? r.artifacts : [];
    const ordered = [...arts].sort((a, b) => Number(/json/i.test(b.type + b.title)) - Number(/json/i.test(a.type + a.title)));
    let artifactErr = null;
    for (const a of ordered.slice(0, 3)) {
      try {
        const text = await downloadArtifact(role, runId, a.id);
        return { output: checkOutput(role, extractJson(text)), from: 'artifact' };
      } catch (err) { artifactErr = artifactErr || err; }
    }
    // When the agent attached a file, its problem is the useful one: the text is
    // often just a summary of that file.
    if (artifactErr) artifactErr.message = 'Attached file: ' + artifactErr.message;
    throw artifactErr || firstErr || new Error('The agent reply contained no JSON object.');
  }

  // Start a run and poll it to a terminal state. Returns the final run object.
  async function runLive(role, inputs, onStatus) {
    const { appId, key } = creds(role);
    const { pollMs, timeoutMs } = settings();
    const runsUrl = `${BASE_URL}/apps/${encodeURIComponent(appId)}/runs`;

    const created = await http('POST', runsUrl, key, { inputs });
    const runId = created && created.id;
    if (!runId) throw new Error('CREAO did not return a run id.');
    onStatus({ state: 'running', runStatus: created.status || 'pending', runId });

    const deadline = Date.now() + timeoutMs;
    let run = created;
    while (!TERMINAL.has(run && run.status)) {
      if (Date.now() > deadline) {
        const e = new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the agent.`);
        e.runId = runId;
        throw e;
      }
      await sleep(pollMs);
      run = await http('GET', `${runsUrl}/${encodeURIComponent(runId)}`, key);
      onStatus({ state: 'running', runStatus: run && run.status, runId });
    }
    if (run.status !== 'completed') {
      const e = new Error(`Agent run ${run.status}${run.errorCode ? ' (' + run.errorCode + ')' : ''}.`);
      e.runId = runId;
      throw e;
    }
    return { run, runId };
  }

  function toInputs(role, input) {
    return ROLE_INFO[role].payloadInput ? { payload: JSON.stringify(input) } : input;
  }

  // Run one role. Never throws: returns
  //   { ok, output, source: 'live'|'mock'|'cache', mode, cached, stale, error, at, runId }
  // On failure `output` is the last good cached result (stale: true) when there
  // is one, otherwise the mock sample, so the app always has something to show.
  async function run(role, input, runOpts = {}) {
    if (!ROLE_INFO[role]) throw new Error('Unknown CREAO role: ' + role);
    if (inflight.has(role)) return inflight.get(role);
    const p = runInner(role, input, runOpts).finally(() => inflight.delete(role));
    inflight.set(role, p);
    return p;
  }

  async function runInner(role, input, { force = false, onStatus = () => {} } = {}) {
    const info = ROLE_INFO[role];
    const mode = modeOf(role);
    const hash = hashOf({ role, mode, input });
    const cache = loadCache();
    const prev = cache.roles[role] || null;
    const t = now();

    const ttlOk = !info.ttlMinutes || (prev && t - new Date(prev.at) < info.ttlMinutes * 60000);
    if (!force && prev && prev.hash === hash && ttlOk) {
      return { ok: true, output: prev.output, source: 'cache', mode, cached: true, at: prev.at, runId: prev.runId || null };
    }

    const remember = (output, source, runId = null) => {
      cache.roles[role] = { hash, at: t.toISOString(), output, source, runId };
      delete cache.errors[role];
      saveCache(cache);
      return { ok: true, output, source, mode, cached: false, at: t.toISOString(), runId };
    };
    const fallback = (message, extra = {}) => {
      cache.errors[role] = { at: t.toISOString(), message };
      saveCache(cache);
      log(`[creao] ${role} failed: ${message}`);
      if (prev) return { ok: false, error: message, output: prev.output, source: prev.source, mode, stale: true, at: prev.at, ...extra };
      let output = null;
      try { output = checkOutput(role, loadMock(role)); } catch { /* no mock either */ }
      return { ok: false, error: message, output, source: 'mock', mode, stale: true, at: null, ...extra };
    };

    if (mode === 'mock') {
      try { return remember(checkOutput(role, loadMock(role)), 'mock'); }
      catch (err) { return fallback('Mock data is invalid: ' + err.message); }
    }

    // Hourly cap (live runs only).
    const { maxRunsPerHour } = settings();
    const recent = (cache.runLog[role] || []).filter((x) => t - new Date(x) < 3600000);
    if (recent.length >= maxRunsPerHour) {
      return fallback(`Run cap reached (${maxRunsPerHour}/hour). Showing the last result.`, { rateLimited: true });
    }
    cache.runLog[role] = [...recent, t.toISOString()];
    saveCache(cache);

    try {
      const { run: finished, runId } = await runLive(role, toInputs(role, input), onStatus);
      const { output, from } = await outputFromRun(role, finished, runId);
      log(`[creao] ${role} completed (run ${runId}, JSON from ${from})`);
      return remember(output, 'live', runId);
    } catch (err) {
      return fallback(String((err && err.message) || err), { runId: err && err.runId });
    }
  }

  // Safe summary for the UI: never includes App IDs or keys.
  function status() {
    const cache = loadCache();
    const t = now();
    const s = settings();
    return {
      globalMode: s.globalMode,
      maxRunsPerHour: s.maxRunsPerHour,
      roles: ROLES.map((role) => {
        const prev = cache.roles[role];
        return {
          role,
          name: ROLE_INFO[role].name,
          configured: configured(role),
          mode: modeOf(role),
          lastRunAt: prev ? prev.at : null,
          lastSource: prev ? prev.source : null,
          lastError: cache.errors[role] || null,
          runsLastHour: (cache.runLog[role] || []).filter((x) => t - new Date(x) < 3600000).length
        };
      })
    };
  }

  function lastOutput(role) {
    const prev = loadCache().roles[role];
    return prev ? prev.output : null;
  }

  // Re-read a finished run by id (a GET; costs no credits). Used by test:creao.
  async function getRun(role, runId) {
    const { appId, key } = creds(role);
    return http('GET', `${BASE_URL}/apps/${encodeURIComponent(appId)}/runs/${encodeURIComponent(runId)}`, key);
  }

  return { run, status, lastOutput, modeOf, configured, toInputs, runLive, getRun, outputFromRun, checkOutput, loadMock };
}

// The local Gmail path still runs. Gemini is the only call this turns off,
// and only while the Mail Scanner itself is live.
function geminiAllowed(checkboxOn, mailMode) {
  if (mailMode === 'live') return false;
  return !!checkboxOn;
}

module.exports = {
  createClient, ROLES, ROLE_INFO, BASE_URL, geminiAllowed,
  extractJson, runReply, normalizeMail, normalizeDigest, resolveMockTokens, stableStringify, hashOf
};
