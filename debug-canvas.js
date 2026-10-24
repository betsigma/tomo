// debug-canvas.js
// ---------------------------------------------------------------------------
// Standalone Canvas feed debugger. Runs in PLAIN NODE — it does not require
// main.js or Electron, so it works even when the app cannot start.
//
// Usage:
//   node debug-canvas.js <https://...ics | webcal://... | path\to\file.ics> [--title="Paper 2"]
//   node debug-canvas.js                 (uses the saved feed URL, if readable)
//
// The full URL is NEVER printed: only its host. A private feed token lives in
// the URL, so logs show the domain only.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { normalizeCalendar } = require('./canvas');

// Just the host, for safe logging.
function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return '(unknown host)'; }
}

function normalizeUrl(s) {
  // Trim whitespace and accept a copied "webcal://" link.
  return String(s || '').trim().replace(/^webcal:\/\//i, 'https://');
}

// This script's OWN fetch helper (Node's built-in fetch), so it never depends on
// main.js or Electron. Errors carry the HTTP status or a network reason.
async function fetchText(url) {
  console.log('[debug] fetching from', hostOf(url));   // host only, never the token
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    const why = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || 'request failed';
    throw new Error('Network error: ' + why);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : ''));
  return res.text();
}

// Fall back to the URL saved by the app. "enc:" values can only be decrypted
// inside Electron, so those report as unavailable here.
function savedFeedUrl() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'secrets.json'), 'utf8'));
    const v = s.canvasFeed;
    if (!v) return null;
    if (v.startsWith('plain:')) return Buffer.from(v.slice(6), 'base64').toString('utf8');
    return null;
  } catch { return null; }
}

async function loadText(src) {
  if (/^(https?|webcal):\/\//i.test(src)) return fetchText(normalizeUrl(src));
  const p = path.resolve(src);
  console.log('[debug] reading file', path.basename(p));
  return fs.readFileSync(p, 'utf8');
}

(async () => {
  const args = process.argv.slice(2);
  const titleArg = ((args.find((a) => a.startsWith('--title=')) || '').slice(8) || '').trim();
  let src = args.find((a) => !a.startsWith('--'));

  if (!src) {
    src = savedFeedUrl();
    if (src) console.log('[debug] using the saved feed URL');
  }
  if (!src) {
    console.error('No feed given and none saved. Usage: node debug-canvas.js <url|file.ics> [--title="..."]');
    process.exit(1);
  }

  const text = await loadText(src);
  const items = normalizeCalendar(text);
  const matches = titleArg
    ? items.filter((i) => i.title.toLowerCase().includes(titleArg.toLowerCase()))
    : items;

  console.log(`\n${items.length} event(s) parsed` + (titleArg ? ` · ${matches.length} matching "${titleArg}"` : '') + '\n');
  for (const it of matches) {
    console.log(`${it.start}  ${(it.time || 'all-day').padEnd(8)}  ${it.title}${it.course ? '  [' + it.course + ']' : ''}`);
    if (it.location) console.log(`           location: ${it.location}`);
    if (it.url) console.log(`           url: ${it.url}`);
    if (it.description) console.log(`           desc: ${it.description.slice(0, 200)}`);
  }
  if (titleArg && !matches.length) console.log('(no title contained that text)');
})().catch((err) => {
  // Real error, never a generic failure.
  console.error('[debug] ' + ((err && err.message) || err));
  process.exit(1);
});
