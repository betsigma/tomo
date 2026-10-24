// llm.js
// ---------------------------------------------------------------------------
// OPTIONAL AI step for Gmail newsletters, using Google Gemini's REST API with
// Node's built-in fetch (no new dependencies). Runs in the MAIN process only —
// the API key never leaves it and is never returned to the renderer.
//
// The actual provider call is isolated in callModel(...), so a local model
// (e.g. Ollama) can be swapped in later by replacing just that function.
//
// Exports are pure where possible (cleanForAI / buildPrompt / validateResult /
// hashText) so they can be unit-tested in plain Node.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const { stripUrls } = require('./titles');

// A current, free-tier Flash-Lite model. The user can change it in Settings.
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const MAX_TEXT = 6000;    // characters of email text we ever send

const CATEGORIES = ['Internship', 'MESA', 'Club', 'Class', 'Deadline', 'Info'];
const CATEGORY_SET = new Set(CATEGORIES);

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------
function normWs(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

// Remove tracking parameters but keep the base link useful.
function stripTrackingParams(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_eid|mc_cid|ref|source|igshid)/i.test(k)) u.searchParams.delete(k);
    }
    const q = u.searchParams.toString();
    u.search = q ? '?' + q : '';
    return u.toString();
  } catch { return url; }
}

// Turn an email body into plain text with the tracking junk removed, then cap
// it. Real links are moved into a short "Links found" list at the end so the
// model can still categorise them (they are otherwise stripped from the body).
function cleanForAI(body, urls = []) {
  let s = String(body || '');
  s = s.replace(/\r\n?/g, '\n');
  s = stripUrls(s);                                   // drop urls + www + bare domains
  s = s.replace(/\[image[^\]]*\]/gi, ' ');
  s = s.replace(/\S{80,}/g, ' ');                     // long tracking tokens / hashes
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  const links = [];
  const seen = new Set();
  for (const u of (urls || [])) {
    const clean = stripTrackingParams(String(u || '').trim());
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) continue;
    seen.add(clean);
    links.push(clean);
    if (links.length >= 8) break;
  }
  const tail = links.length ? `\n\nLinks found in this email:\n${links.map((u) => '- ' + u).join('\n')}` : '';
  return (s + tail).slice(0, MAX_TEXT);
}

// Short stable hash of the text we sent (used as the cache key with the id).
function hashText(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
function buildPrompt({ text, subject = '', receivedDate = '', today = '' }) {
  return `You extract calendar events and useful links from a school email.
Return ONLY JSON with this exact shape:
{"events":[{"title":"","date":"YYYY-MM-DD","startTime":"HH:MM or null","endTime":"HH:MM or null","allDay":true,"location":"","category":"Internship|MESA|Club|Class|Deadline|Info","useful":true,"sourceQuote":""}],"links":[{"title":"","url":"","category":""}]}

Rules:
- Only include an event if the email states an EXPLICIT date. Never guess a date or time.
- Use the email's received date to resolve "tomorrow", "this Wednesday", etc.
- title must be a short name (a few words), never a sentence, and must NOT contain the date.
- startTime/endTime are 24-hour "HH:MM" only when a clock time is stated; otherwise null and allDay true.
- Set useful=false for voting, surveys, ads, and generic announcements.
- Put internship, scholarship and application links in "links" with a category. Only use the links listed below.
- sourceQuote must be copied EXACTLY from the email text and must contain the date.

Today: ${today}
Email received: ${receivedDate}
Subject: ${subject}

Email text:
${text}`;
}

// ---------------------------------------------------------------------------
// Provider (swap only this function for a local model)
// ---------------------------------------------------------------------------
// Returns the model's text answer. Throws an Error with .code === 'RATE_LIMIT'
// on HTTP 429 so the caller can back off / stop.
async function callModel({ prompt, model = DEFAULT_MODEL, apiKey, fetchImpl = fetch, timeoutMs = 60000 }) {
  if (!apiKey) { const e = new Error('Missing API key'); e.code = 'NO_KEY'; throw e; }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // Ask Gemini for JSON directly (no Markdown fences).
        generationConfig: { responseMimeType: 'application/json', temperature: 0 }
      }),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) { const e = new Error('AI rate limit (429)'); e.code = 'RATE_LIMIT'; e.status = 429; throw e; }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(`AI HTTP ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`);
    e.code = 'HTTP'; e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || '').join('');
}

// ---------------------------------------------------------------------------
// Validation (never trust the model)
// ---------------------------------------------------------------------------
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// Does the quote actually contain the date in some written form?
function dateAppearsInQuote(dateISO, quote) {
  const m = String(dateISO || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const q = normWs(quote).toLowerCase();
  const mon = MONTHS[mo - 1];
  const abr = mon.slice(0, 3);
  const dd = String(d);
  const pad = String(d).padStart(2, '0');
  const candidates = [
    dateISO,
    `${mon} ${dd}`, `${mon} ${pad}`, `${abr} ${dd}`, `${abr} ${pad}`, `${abr}. ${dd}`, `${abr}. ${pad}`,
    `${mo}/${dd}`, `${mo}/${pad}`, `${pad}/${dd}`, `${mo}-${dd}`, `${mo}-${pad}`, `${pad}-${dd}`
  ];
  return candidates.some((c) => q.includes(c));
}

function normTime(v) {
  const s = String(v == null ? '' : v).trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : '';
}

// Validate the model's JSON against the email text. Anything wrong is dropped.
// Returns { ok, events, links, dropped, reason }.
function validateResult(raw, { text = '', now = new Date(), allowedUrls = [] } = {}) {
  let obj = raw;
  if (typeof raw === 'string') {
    // JSON mode should return bare JSON, but strip any code fences just in case.
    const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { obj = JSON.parse(s); }
    catch { return { ok: false, events: [], links: [], dropped: 0, reason: 'invalid JSON' }; }
  }
  if (!obj || typeof obj !== 'object') {
    return { ok: false, events: [], links: [], dropped: 0, reason: 'not an object' };
  }

  const hay = normWs(text);
  const hayLower = hay.toLowerCase();
  const nowT = now.getTime();
  const minT = nowT - 14 * 86400000;    // 14 days back
  const maxT = nowT + 120 * 86400000;   // 120 days ahead

  const events = [];
  let dropped = 0;
  for (const ev of (Array.isArray(obj.events) ? obj.events : [])) {
    const title = normWs(ev && ev.title);
    const date = String((ev && ev.date) || '').trim();
    const quote = normWs(ev && ev.sourceQuote);

    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !quote) { dropped++; continue; }
    if (!hayLower.includes(quote.toLowerCase())) { dropped++; continue; }   // quote not in email
    if (!dateAppearsInQuote(date, quote)) { dropped++; continue; }          // date not in quote
    const t = new Date(`${date}T00:00:00`).getTime();
    if (isNaN(t) || t < minT || t > maxT) { dropped++; continue; }          // outside window

    const startTime = normTime(ev.startTime);
    const endTime = normTime(ev.endTime);
    events.push({
      title: title.slice(0, 90),
      start: date,
      date,
      time: startTime,
      startTime,
      endTime,
      allDay: !startTime,
      location: normWs(ev.location) || '',
      category: CATEGORY_SET.has(ev.category) ? ev.category : 'Info',
      useful: ev.useful !== false,
      sourceQuote: quote,
      source: 'ai'
    });
  }

  const links = [];
  const seen = new Set();
  const allowed = new Set((allowedUrls || []).map((u) => String(u)));
  for (const l of (Array.isArray(obj.links) ? obj.links : [])) {
    const url = String((l && l.url) || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    // Only keep links we actually saw in the email (never invented ones).
    if (allowed.size && !allowed.has(url)) continue;
    seen.add(url);
    links.push({
      title: normWs(l.title) || url,
      url,
      category: normWs(l.category) || 'Other'
    });
  }

  return { ok: true, events, links, dropped, reason: '' };
}

module.exports = {
  DEFAULT_MODEL,
  CATEGORIES,
  MAX_TEXT,
  cleanForAI,
  hashText,
  buildPrompt,
  callModel,
  validateResult,
  dateAppearsInQuote
};
