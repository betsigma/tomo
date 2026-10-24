// env.js
// ---------------------------------------------------------------------------
// Tiny .env loader (no dependency). Reads KEY=VALUE lines from the project's
// .env into process.env without overriding variables that are already set.
// It never prints values: callers only ever ask "is this set?".
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadEnv(file = path.join(__dirname, '.env')) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const vars = parseEnv(text);
  for (const k of Object.keys(vars)) {
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = vars[k];
  }
  return true;
}

module.exports = { loadEnv, parseEnv };
