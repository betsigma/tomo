// gmail.js
// ---------------------------------------------------------------------------
// Gmail-specific logic that does NOT need the network:
//   - buildQuery(): turn your filters into a Gmail search string
//   - matchesFilter(): decide if an email passes your rules (with a reason)
//   - normalizeMessage()/extractBodyText(): turn a raw API message into a simple object
//   - parseNewsletter(): pull dated events out of a newsletter body
// The OAuth sign-in and the actual API calls live in main.js.
//
// The rules here are unchanged. The learned relevance filter only ADDS an
// optional step: when main.js passes an `ml` scorer (see fetchPreview step 5c),
// every parsed item also gets mlScore / mlClass / mlReason (and the trimmed
// text used to train it, ev.text). With no scorer the pipeline behaves exactly
// as before.
// ---------------------------------------------------------------------------

const chrono = require('chrono-node');
const { toLocalDate, toLocalTime } = require('./textdate');
const { stripHtml, stripUrls, cleanTitle, isJunkTitle, extractUrls } = require('./titles');
const llm = require('./llm');
const { classify } = require('./ml');

// A "deadline word" in a title makes an AI event a normal (active) event
// instead of a suggested one.
function hasDeadlineWord(title) {
  return /\b(deadline|due|due by|last day|closes?|apply by|application|expires?|register by|final day)\b/i.test(String(title || ''));
}

// The trimmed text that stands for ONE parsed item: subject + the section text
// it came from. The learned filter embeds this, and it is what gets saved as a
// training example when you accept / dismiss the item.
const ML_TEXT_MAX = 600;
function mlSectionText(subject, lines) {
  const body = (Array.isArray(lines) ? lines : [lines]).filter(Boolean).join(' ');
  return `${subject || ''} ${body}`.replace(/\s+/g, ' ').trim().slice(0, ML_TEXT_MAX);
}

// Split a comma-separated settings string into a clean array.
function splitList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Compare two names ignoring case, spaces and punctuation.
// "De Anza College" -> "deanzacollege", so it contains "deanza".
function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Does this email address belong to the given domain (or ANY subdomain)?
//   domainMatches('communications@deanza.edu', 'deanza.edu') -> true
//   domainMatches('staff@em.deanza.edu',      'deanza.edu') -> true
function domainMatches(address, domain) {
  const d = String(domain || '').toLowerCase().replace(/^@/, '').trim();
  const addr = String(address || '').toLowerCase();
  const at = addr.lastIndexOf('@');
  const host = at >= 0 ? addr.slice(at + 1) : '';
  return !!d && (host === d || host.endsWith('.' + d));
}

// ---------------------------------------------------------------------------
// Gmail search query
// ---------------------------------------------------------------------------
// We build a BROAD OR query so the newsletter is never missed, then apply the
// precise rules in matchesFilter() on our side.
//
// Rules baked in:
//   - include Promotions/Updates (we do NOT restrict to category or in:inbox)
//   - exclude spam/trash
//   - look back at least 30 days
function buildQuery(filters = {}, days = 30) {
  const or = [];

  splitList(filters.trustedSenders).forEach((s) => or.push(`from:${s}`));
  splitList(filters.domains).forEach((d) => or.push(`from:${d.replace(/^@/, '')}`));
  splitList(filters.senders).forEach((s) => or.push(`from:${s}`));
  splitList(filters.names).forEach((n) => or.push(`from:"${n}"`));
  splitList(filters.keywords).forEach((k) => or.push(`"${k}"`));

  const label = String(filters.label || '').trim();
  if (label) or.push(`label:${label}`);

  const window = `newer_than:${Math.max(30, Number(days) || 30)}d`; // at least 30 days
  const core = or.length ? `(${or.join(' OR ')})` : '';
  return [core, window, '-in:spam', '-in:trash'].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// The filter (runs on our side, on the fetched email)
// ---------------------------------------------------------------------------
// Returns { pass: true|false, reason: '<which rule matched / why not>' }.
// Priority: trusted sender -> sender domain -> sender display name ->
//           explicit sender -> keyword. ANY match passes.
function matchesFilter(email, filters = {}) {
  const fromEmail = String(email.fromEmail || '').trim();
  const fromName = String(email.from || '').trim();
  const subject = String(email.subject || '');
  const body = String(email.body || email.snippet || '');

  // 1) Trusted senders: always pass, even with no keywords.
  const trusted = splitList(filters.trustedSenders).map((s) => s.toLowerCase());
  if (trusted.includes(fromEmail.toLowerCase())) {
    return { pass: true, reason: `trusted-sender(${fromEmail})` };
  }

  // 2) Domain rule against the From address (matches subdomains too).
  for (const d of splitList(filters.domains)) {
    if (domainMatches(fromEmail, d)) return { pass: true, reason: `sender-domain(${d})` };
  }

  // 3) Display-name rule, ignoring spaces/case ("de anza" == "deanza").
  const normName = normalizeName(fromName);
  for (const n of splitList(filters.names)) {
    const needle = normalizeName(n);
    if (needle && normName.includes(needle)) return { pass: true, reason: `sender-name(${n})` };
  }

  // 4) Explicit senders (substring or domain match).
  for (const s of splitList(filters.senders)) {
    const needle = s.toLowerCase();
    if (fromEmail.toLowerCase().includes(needle) || domainMatches(fromEmail, needle)) {
      return { pass: true, reason: `sender(${s})` };
    }
  }

  // 5) Keywords anywhere in subject or body.
  const haystack = (subject + ' ' + body).toLowerCase();
  for (const k of splitList(filters.keywords)) {
    if (haystack.includes(k.toLowerCase())) return { pass: true, reason: `keyword(${k})` };
  }

  return { pass: false, reason: 'no-rule-matched' };
}

// ---------------------------------------------------------------------------
// Exclusion keywords (voting / voter-registration mail)
// ---------------------------------------------------------------------------
// Checked against the subject and the START of the body only, so a long
// newsletter that mentions "ballot" in paragraph 12 still gets through.
// The list lives in Settings (filters.excludeKeywords) and is user-editable.
const DEFAULT_EXCLUDE_KEYWORDS = 'voter registration, register to vote, ballot, polling place, election day';
const EXCLUDE_BODY_CHARS = 600;

// Returns the keyword that matched, or null.
function excludedKeyword(subject, body, keywords) {
  const list = keywords === undefined ? DEFAULT_EXCLUDE_KEYWORDS : keywords;
  const hay = (String(subject || '') + ' ' + String(body || '').slice(0, EXCLUDE_BODY_CHARS)).toLowerCase();
  for (const k of splitList(list)) {
    if (hay.includes(k.toLowerCase())) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trust (allowlist)
// ---------------------------------------------------------------------------
// A pattern may be:
//   communications@deanza.edu  -> that exact address
//   *@fhda.edu                 -> anyone at that domain (or subdomains)
//   fhda.edu                   -> same as above
function isTrusted(address, patterns) {
  const addr = String(address || '').toLowerCase();
  if (!addr) return false;
  for (const raw of splitList(patterns)) {
    const pat = raw.toLowerCase();
    if (pat.startsWith('*@')) {
      if (domainMatches(addr, pat.slice(2))) return true;
    } else if (pat.includes('@')) {
      if (addr === pat) return true;
    } else if (domainMatches(addr, pat) || addr === pat) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// full screening used by main.js
// ---------------------------------------------------------------------------
// Order:
//   1. blocked sender            -> reject
//   1b. exclusion keyword (subject + start of body) -> reject, even if trusted
//   2. non-trusted + Promotions/Social label -> reject
//   3. non-trusted + List-Unsubscribe header -> reject
//   4. sender/domain/name/keyword rules (matchesFilter)
function screenEmail(email, filters = {}) {
  const trusted = isTrusted(email.fromEmail, filters.trustedSenders);

  // 1) Blocked senders (added via "Block this sender").
  for (const b of splitList(filters.blockedSenders)) {
    const needle = b.toLowerCase();
    if (String(email.fromEmail || '').toLowerCase() === needle || domainMatches(email.fromEmail, needle)) {
      return { pass: false, trusted, reason: `blocked-sender(${b})` };
    }
  }

  const kw = excludedKeyword(email.subject, email.body || email.snippet, filters.excludeKeywords);
  if (kw) return { pass: false, trusted, excluded: kw, reason: `excluded-keyword(${kw})` };

  if (!trusted) {
    const labels = (email.labels || []).map((l) => String(l).toUpperCase());
    if (labels.includes('CATEGORY_PROMOTIONS')) return { pass: false, trusted, reason: 'skipped-category-promotions' };
    if (labels.includes('CATEGORY_SOCIAL')) return { pass: false, trusted, reason: 'skipped-category-social' };
    if (email.listUnsubscribe) return { pass: false, trusted, reason: 'skipped-list-unsubscribe' };
  }

  const r = matchesFilter(email, filters);
  return { pass: r.pass, trusted, reason: r.reason };
}

// ---------------------------------------------------------------------------
// Parsing a raw message
// ---------------------------------------------------------------------------
// Parse a "From" header like  Jane Doe <jane@school.edu>  or  jane@school.edu
function parseFrom(headerValue) {
  const v = String(headerValue || '').trim();
  const m = v.match(/^(.*)<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].trim().replace(/^"(.*)"$/, '$1');
    return { name: name || m[2].trim(), email: m[2].trim() };
  }
  return { name: v, email: v };
}

// Build a lookup of headers (names lower-cased) from a Gmail message payload.
function headerMap(msg) {
  const map = {};
  const headers = (msg.payload && msg.payload.headers) || [];
  for (const h of headers) map[String(h.name).toLowerCase()] = h.value;
  return map;
}

function decodeBase64Url(data) {
  try { return Buffer.from(String(data || ''), 'base64').toString('utf8'); }
  catch { return ''; }
}

// Walk the MIME tree and return the readable text of the email.
// Prefers text/plain, falls back to text/html (tags stripped).
function extractBodyText(payload) {
  if (!payload) return '';
  let plain = '';
  let html = '';
  const walk = (part) => {
    if (!part) return;
    const mime = String(part.mimeType || '').toLowerCase();
    const data = part.body && part.body.data;
    if (data) {
      if (mime === 'text/plain') plain += '\n' + decodeBase64Url(data);
      else if (mime === 'text/html') html += '\n' + decodeBase64Url(data);
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  if (plain.trim()) return plain;
  if (html.trim()) return stripHtml(html);
  return '';
}

// Turn one raw Gmail message into a short object for the widget.
function normalizeMessage(msg) {
  const h = headerMap(msg);
  const from = parseFrom(h.from);
  return {
    uid: msg.id,                       // stable -> dedupe key includes message id
    id: msg.id,
    from: from.name || from.email,     // display name (used by the name rule)
    fromEmail: from.email,
    subject: h.subject || '(no subject)',
    date: h.date || '',
    snippet: msg.snippet || '',
    body: '',                          // filled in by main.js via extractBodyText
    labels: Array.isArray(msg.labelIds) ? msg.labelIds : [],   // e.g. CATEGORY_PROMOTIONS
    listUnsubscribe: !!h['list-unsubscribe'],                  // marketing indicator
    link: `https://mail.google.com/mail/u/0/#all/${msg.id}`
  };
}

// ---------------------------------------------------------------------------
// Newsletter parser
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Event extraction (rules for the Gmail re-sync)
// ---------------------------------------------------------------------------
//   - TITLE = the email SUBJECT (cleaned). No subject-derived junk -> no events.
//   - DATE must be EXPLICIT in the text: a digit or a month name must be part
//     of the matched date ("Oct 16", "10/16", "October 16, 2026").
//     "Monday", "tomorrow", "next week" are rejected.
//   - TIME is kept only when the text has a clock time ("1:30pm", "13:30").
//     Otherwise the event is all-day. No time is ever invented.
//   - Dates within 7 days back and 90 days ahead only.
//   - At most opts.max (default 5) events per email.
const MAX_TITLE = 90;
const PAST = 7 * 86400000;      // dates up to 7 days ago
const FUTURE = 90 * 86400000;   // dates up to 90 days ahead
// A month name, or a numeric date like 10/16 or 2026-10-16. A bare number
// ("at 5pm", "Monday") is NOT enough.
const EXPLICIT_DATE = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b|\b\d{1,4}[\/.\-]\d{1,2}([\/.\-]\d{1,4})?\b/i;
const HAS_YEAR = /\b(19|20)\d{2}\b/;
const CLOCK_ANY = /\d\s*[ap]\.?\s?m\b|\b\d{1,2}:\d{2}\b/i;

// Clock times. Accepted: "11:30 a.m.", "3 p.m.", "8-9 p.m." (range; the start
// borrows the end's a.m./p.m.), and 24h "13:30". A bare "10:00" is NOT accepted.
const MER = '([ap])\\.?\\s?m\\b\\.?';
const RANGE_RE = new RegExp(`\\b(\\d{1,2})(?::(\\d{2}))?\\s*(?:${MER})?\\s*(?:-|to)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*${MER}`, 'i');
const SINGLE_RE = new RegExp(`\\b(\\d{1,2})(?::(\\d{2}))?\\s*${MER}`, 'i');
const H24_RE = /\b(1[3-9]|2[0-3]):([0-5]\d)\b/;

function to24(h, min, mer) {
  let hour = Number(h);
  if (hour < 1 || hour > 12) return null;
  hour = hour % 12 + (/p/i.test(mer) ? 12 : 0);
  return `${String(hour).padStart(2, '0')}:${String(Number(min || 0)).padStart(2, '0')}`;
}

function clockInWindow(w) {
  const r = RANGE_RE.exec(w);
  if (r) return to24(r[1], r[2], r[3] || r[6]);
  const s = SINGLE_RE.exec(w);
  if (s) return to24(s[1], s[2], s[3]);
  const h = H24_RE.exec(w);
  if (h) return `${h[1]}:${h[2]}`;
  return '';
}

// Fix common mojibake (UTF-8 read as Latin-1) and non-breaking spaces.
function normalizeText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/â€“|â€”/g, '-')
    .replace(/â€™|â€˜/g, "'")
    .replace(/â€œ|â€\u009d|â€/g, '"')
    .replace(/Â|\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

// Dates inside a heading ("SJSU Info Session Is Oct. 14") are shown in the Date
// column, so take them out of the title, along with the connector words left
// behind. Falls back to the full heading if nothing usable is left.
const MON_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const DATE_IN_TEXT = new RegExp(
  `\\b${MON_RE}\\.?\\s*\\d{1,2}(?:st|nd|rd|th)?\\b(?:\\.?\\s*[-\u2013]\\s*(?:${MON_RE}\\.?\\s*)?\\d{1,2}\\b)?` +
  `|\\b\\d{1,2}[\\/.\\-]\\d{1,2}(?:[\\/.\\-]\\d{2,4})?\\b`, 'gi');
function titleWithoutDates(heading) {
  let s = heading.replace(DATE_IN_TEXT, ' ').replace(/\s+/g, ' ');
  for (let i = 0; i < 3; i++) {
    s = s.replace(/^[\s\-\u2013\u2014:,.|]+|[\s\-\u2013\u2014:,.|]+$/g, '')
      .replace(/^(is|on|at|for|by|due)\s+/i, '')
      .replace(/\s+(is|on|at|for|by|due)$/i, '');
  }
  s = s.trim();
  return s.length >= 4 && !isJunkTitle(s) ? s : heading;
}

function titleFromSubject(subject) {
  const t = cleanTitle(normalizeText(subject));
  if (isJunkTitle(t)) return '';
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 3).trimEnd() + '...' : t;
}

// Body -> trimmed lines (URLs removed, so a link-only line becomes blank).
function toLines(raw) {
  return normalizeText(raw).split('\n').map((l) => stripUrls(l).replace(/\s+/g, ' ').trim());
}

// "Oct. 5-9", "Sept 15" alone are dates, not headings.
function isDateOnly(t) {
  const rest = t.toLowerCase()
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?/g, ' ')
    .replace(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?/g, ' ')
    .replace(/\b(to|and|through|thru|at)\b/g, ' ')
    .replace(/[^a-z]+/g, '');
  return rest.length < 3;
}

// A heading is a short line with no sentence punctuation, with a blank line
// above and below it. Lines that carry a date AND a time are event lines, not
// headings ("Friday, Oct. 16, from 4-5 p.m. on Zoom").
function isHeadingLine(lines, i) {
  const t = lines[i];
  if (t.length < 3 || t.length > 90) return false;
  if (t.split(' ').length > 12) return false;
  if (/[.,;?]$/.test(t)) return false;
  if (/@|https?:/i.test(t)) return false;
  if (!/^[A-Za-z0-9"'(]/.test(t)) return false;
  if (!/[A-Za-z]{3,}/.test(t)) return false;
  if (isDateOnly(t)) return false;
  if (EXPLICIT_DATE.test(t) && CLOCK_ANY.test(t)) return false;
  const prevBlank = i === 0 || lines[i - 1] === '';
  const nextBlank = i === lines.length - 1 || lines[i + 1] === '';
  return prevBlank && nextBlank;
}

// Split lines into sections. sections[0] is the text before the first heading
// (heading === null). Each later section runs until the next heading.
function splitSections(lines) {
  const sections = [];
  let cur = { heading: null, lines: [] };
  for (let i = 0; i < lines.length; i++) {
    if (isHeadingLine(lines, i)) {
      sections.push(cur);
      cur = { heading: lines[i], lines: [] };
    } else {
      cur.lines.push(lines[i]);
    }
  }
  sections.push(cur);
  return sections;
}

// Find explicit, in-window dates in a piece of text and the time that goes with
// each one. The time is searched in the text right after the date, up to the
// next date, so "Oct. 16\n11 a.m." still gets 11:00.
const WEEKDAY_BEFORE_DATE = new RegExp(
  `\\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\\.?,?\\s+(?=${MON_RE}\\.?\\s*\\d)`, 'gi');

function datesIn(raw, now) {
  const nowT = now.getTime();
  // "Wednesday, Oct. 14" -> "Oct. 14": chrono reads a bare weekday as an
  // uncertain date and then drops the real one. The explicit date stays.
  // "Oct. 14, 11 a.m." -> "Oct. 14 at 11 a.m.": chrono otherwise reads "14, 11"
  // as a 2011 date and loses the explicit date.
  const text = raw
    .replace(WEEKDAY_BEFORE_DATE, '')
    .replace(/,\s*(?=\d{1,2}(?::\d{2})?\s*[ap]\.?\s?m\b)/gi, ' at ');
  const results = chrono.parse(text, now, { forwardDate: true });
  const hits = [];
  const stats = { explicit: 0, outside: 0 };
  results.forEach((r, i) => {
    const matched = r.text.trim();
    if (!EXPLICIT_DATE.test(matched)) return;
    if (!r.start.isCertain('day') || !r.start.isCertain('month')) return;
    stats.explicit++;

    let d = r.start.date();
    if (!HAS_YEAR.test(matched)) {
      // No year written: chrono can guess badly ("Oct. 16 11" -> 2011).
      // Use the year that puts the date closest to today.
      const cands = [-1, 0, 1].map((k) => new Date(now.getFullYear() + k, d.getMonth(), d.getDate(),
        d.getHours(), d.getMinutes()));
      d = cands.reduce((best, c) => (Math.abs(c.getTime() - nowT) < Math.abs(best.getTime() - nowT) ? c : best));
    }
    const t = d.getTime();
    if (t < nowT - PAST || t > nowT + FUTURE) { stats.outside++; return; }

    const nextIdx = i + 1 < results.length ? results[i + 1].index : text.length;
    const windowText = text.slice(r.index, Math.min(nextIdx, r.index + r.text.length + 140));
    hits.push({ start: toLocalDate(d), time: clockInWindow(windowText) });
  });
  return { hits, stats };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortLabel(iso, time) {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${time ? ' ' + time : ''}`;
}

// Turn ONE email into events plus a diagnosis (why it produced none).
//   - Headings present: each section's HEADING is the title. A section with
//     several dated items gets "Heading · Oct 16 11:00" so titles never clash.
//   - No headings: a single-event email, title = subject. If it has several
//     dates, each becomes "Subject · Oct 16".
//   - Generic labels ("Tomorrow", "This Week") are not titles; their sections
//     are skipped and listed in the diagnosis.
// Rules kept: explicit date required, times only from clock text, the last 7
// days to +90 days, at most `max` events per email.
function analyzeEmail(text, now = new Date(), opts = {}) {
  const subject = opts.subject || '';
  const max = Math.max(1, Number(opts.max) || 5);
  const subjTitle = titleFromSubject(subject);
  const sections = splitSections(toLines(text));
  const headed = sections.filter((s) => s.heading !== null);

  const diag = { headings: headed.length, explicitDates: 0, outside: 0, labelSkipped: [], preambleDates: 0, capped: 0 };
  const raw = [];

  const addHits = (hits, titleFor, source, text) => {
    const byDay = hits.length;
    for (const h of hits) {
      raw.push({ title: titleFor(h, byDay), start: h.start, time: h.time, allDay: !h.time, source, text });
    }
  };

  if (!headed.length) {
    const { hits, stats } = datesIn(sections[0].lines.join('\n'), now);
    diag.explicitDates += stats.explicit;
    diag.outside += stats.outside;
    if (subjTitle) {
      addHits(hits, (h, n) => (n === 1 ? subjTitle : `${subjTitle} \u00B7 ${shortLabel(h.start, h.time)}`),
        'subject', mlSectionText(subject, sections[0].lines));
    }
  } else {
    // Text before the first heading has no title, so it is never turned into events.
    const pre = datesIn(sections[0].lines.join('\n'), now);
    diag.preambleDates = pre.hits.length;
    diag.explicitDates += pre.stats.explicit;
    diag.outside += pre.stats.outside;

    for (const sec of headed) {
      const { hits, stats } = datesIn(sec.lines.join('\n'), now);
      diag.explicitDates += stats.explicit;
      diag.outside += stats.outside;
      if (!hits.length) continue;
      const base = cleanTitle(normalizeText(sec.heading)).slice(0, MAX_TITLE);
      if (!base || isJunkTitle(base)) {
        diag.labelSkipped.push(`"${sec.heading}" (${hits.length} date${hits.length > 1 ? 's' : ''})`);
        continue;
      }
      const heading = titleWithoutDates(base);
      addHits(hits, (h, n) => (n === 1 ? heading : `${heading} \u00B7 ${shortLabel(h.start, h.time)}`),
        'heading', mlSectionText(subject, [sec.heading, ...sec.lines]));
    }
  }

  // Sort, drop duplicates (same title, day and time), enforce the cap.
  raw.sort((a, b) => (a.start + a.time).localeCompare(b.start + b.time));
  const seen = new Set();
  const unique = raw.filter((e) => {
    const k = `${e.title}|${e.start}|${e.time}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  diag.capped = Math.max(0, unique.length - max);
  const events = unique.slice(0, max);

  // Diagnosis: why no events (the preview shows this for trusted emails).
  let reason = 'ok';
  if (!events.length) {
    const why = [];
    if (!headed.length && !subjTitle) why.push('no headings and subject is not a usable title');
    if (!headed.length) why.push('no headings');
    if (diag.explicitDates === 0) why.push('no explicit date (needs a month name or 10/16 form)');
    else if (diag.outside === diag.explicitDates) why.push(`all ${diag.outside} date(s) outside window (-7 / +90 days)`);
    if (diag.preambleDates) why.push(`${diag.preambleDates} date(s) before the first heading (no title)`);
    if (diag.labelSkipped.length) why.push(`generic heading skipped: ${diag.labelSkipped.join(', ')}`);
    reason = why.join('; ') || 'no usable event';
  } else if (diag.capped) {
    reason = `ok (${diag.capped} more event(s) beyond the max of ${max})`;
  }
  diag.reason = reason;
  return { events, diag };
}

// Events only (kept for callers that do not need the diagnosis).
function parseNewsletter(text, now = new Date(), opts = {}) {
  return analyzeEmail(text, now, opts).events;
}

// ---------------------------------------------------------------------------
// Preview for the re-sync (pure: takes the screened emails, returns table rows)
// ---------------------------------------------------------------------------
// Row shape: { key, subject, title, date, time, willCreate, reason, event }
// `event` is exactly what gets stored on Apply. Its dedupeKey matches the
// format used by mergeGmailEvents in renderer.js ("gmail:<uid>").
function slugForKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function buildPreviewRows(emails) {
  const rows = [];
  for (const e of (emails || [])) {
    if (!e.pass) continue;                               // only emails that matched your filters
    // The email's own links (source message + anything found in its body).
    // These power the "Save to Links" button in each preview row.
    const links = [];
    if (e.link) links.push(e.link);
    for (const u of (e.urls || [])) if (!links.includes(u)) links.push(u);
    const base = {
      subject: e.subject, sender: e.fromEmail, link: e.link || '', links,
      parsedBy: e.aiUsed ? 'AI' : 'rules'
    };

    if (!e.trusted) {
      rows.push({ ...base, key: e.uid, title: '', date: '', time: '', category: '', useful: null,
        sourceQuote: '', willCreate: false, reason: 'not a trusted sender', event: null });
      continue;
    }
    const events = e.events || [];
    if (!events.length) {
      // Trusted sender, no events: say exactly why (debug).
      rows.push({ ...base, key: e.uid, title: '', date: '', time: '', category: '', useful: null,
        sourceQuote: '', willCreate: false, reason: (e.diag && e.diag.reason) || 'no usable event', event: null });
      continue;
    }
    if (e.diag && e.diag.capped) {
      rows.push({ ...base, key: e.uid + ':capped', title: '', date: '', time: '', category: '',
        useful: null, sourceQuote: '', willCreate: false,
        reason: `${e.diag.capped} more event(s) found but dropped by the max of 5 per email`, event: null });
    }
    for (const ev of events) {
      const useful = ev.useful !== false;
      const skipped = ev.status === 'skipped';
      const willCreate = useful && !skipped;
      const uid = `${e.uid}:${ev.start}:${ev.time || 'allday'}:${slugForKey(ev.title)}`;
      // The learned filter, when it ran in fetchPreview, decides the stored
      // status so the preview and the normal sync behave the same way.
      const mlStatus = ev.mlClass === 'hidden' ? 'filtered'
        : ev.mlClass === 'suggested' ? 'suggested' : null;
      const reason = !useful ? 'AI: not useful'
        : skipped ? 'AI: skipped'
        : mlStatus ? `learned filter: ${ev.mlReason || mlStatus}`
        : ev.source === 'ai' ? `AI: ${ev.status === 'suggested' ? 'suggested' : 'event'}`
        : ev.source === 'heading' ? 'trusted sender; title from section heading'
        : 'trusted sender; title from subject';
      rows.push({
        ...base,
        key: uid,
        title: ev.title,
        date: ev.start,
        time: ev.time || '',
        category: ev.category || '',
        useful: ev.useful === undefined ? null : useful,
        sourceQuote: ev.sourceQuote || '',
        mlScore: typeof ev.mlScore === 'number' ? ev.mlScore : null,
        mlClass: ev.mlClass || '',
        mlReason: ev.mlReason || '',
        willCreate,
        reason,
        event: willCreate ? {
          title: ev.title,
          start: ev.start,
          time: ev.time || '',
          endTime: ev.endTime || '',
          location: ev.location || '',
          category: ev.category || '',
          sourceQuote: ev.sourceQuote || '',
          source: 'gmail',
          status: mlStatus || ev.status || 'active',
          dedupeKey: 'gmail:' + uid,
          sender: e.fromEmail,
          course: e.fromEmail,
          messageId: e.uid,
          // Learned-filter fields ride along so "Apply" keeps them.
          mlText: ev.text || '',
          mlScore: typeof ev.mlScore === 'number' ? ev.mlScore : '',
          mlReason: ev.mlReason || '',
          mlClass: ev.mlClass || ''
        } : null
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Gmail fetch (rate-limit aware, incremental)
// ---------------------------------------------------------------------------
//   1. list message IDs for the query (paged, newer_than window)      cheap
//   2. skip IDs already in the cache (settings.processedMessageIds)
//   3. metadata only (From / Subject / labels / snippet, NO body) for NEW ids
//   4. sender rules decide pass/trusted from that metadata
//   5. full message ONLY for NEW trusted senders that passed -> analyzeEmail
// Requests run 4 at a time through a small queue. Quota / 429 / 5xx errors are
// retried at most 3 times (2s, 4s, 8s). One summary line is logged per sync.
// A message that still fails is NOT cached, so the next sync retries it.

const CACHE_VERSION = 4;     // bump when the parsing rules change, to re-analyse
                             // (4 = adds the learned-filter score fields)
const CONCURRENCY = 4;
const AI_CONCURRENCY = 2;    // at most 2 AI calls in flight
const AI_MAX_RETRIES = 3;    // 429 backoff: 2s, 4s, 8s
const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, stats) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = Number(err.code || (err.response && err.response.status) || 0);
      const retryable = status === 429 || status === 403 || status >= 500 || /quota|rate ?limit/i.test(String(err.message || ''));
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      stats.retries++;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

// AI calls: exponential backoff ONLY on 429 rate limits. After the retries are
// exhausted the error is marked limitReached so the caller can stop gracefully.
async function withAiRetry(fn, aiStats) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err && (err.code === 'RATE_LIMIT' || err.status === 429);
      if (!is429) throw err;
      if (attempt >= AI_MAX_RETRIES) { err.limitReached = true; throw err; }
      aiStats.retries++;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

// Run fn over items with at most `limit` in flight at once.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// The cache is only valid for the same query and the same sender/keyword rules.
// When AI is ON we also fold the model into the signature, so switching AI on or
// changing the model re-processes the window once. When AI is OFF the signature
// is exactly as before (so existing caches are reused, no re-fetch).
function cacheSignature(q, filters, aiKey = '') {
  const base = [CACHE_VERSION, q, filters.trustedSenders, filters.domains, filters.names,
    filters.senders, filters.keywords, filters.blockedSenders, filters.label];
  if (aiKey) base.push(aiKey);
  return JSON.stringify(base);
}

// Follow nextPageToken until the list ends or `cap` ids are collected.
async function listMessageIds(gmailApi, q, cap, stats) {
  const ids = [];
  let pageToken;
  let pages = 0;
  do {
    const res = await withRetry(() => gmailApi.users.messages.list({
      userId: 'me', q, pageToken,
      maxResults: Math.min(100, cap - ids.length)
    }), stats);
    pages++;
    for (const m of (res.data.messages || [])) ids.push(m.id);
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken && ids.length < cap);
  return { ids, pages, capped: !!pageToken };
}

// Cached entries are stored without the body to keep store.json small.
function slimEntry(e) {
  return {
    id: e.id, uid: e.uid, from: e.from, fromEmail: e.fromEmail, subject: e.subject, link: e.link,
    labels: e.labels || [], listUnsubscribe: !!e.listUnsubscribe,
    trusted: !!e.trusted, pass: !!e.pass, reason: e.reason || '',
    events: e.events || [], diag: e.diag || {}, urls: e.urls || [],
    aiUsed: !!e.aiUsed, aiLinks: e.aiLinks || []
  };
}

// Apply a validated AI result to an email: AI events replace the rule-based
// ones, and we decide each event's status (suggested vs active).
function applyAiResult(e, validated) {
  if (!validated || !validated.ok) return;             // invalid -> keep rule-based
  e.events = (validated.events || []).map((ev) => {
    const active = !!ev.startTime || hasDeadlineWord(ev.title);
    return {
      ...ev,
      // Text for the learned filter (subject + the AI's supporting quote).
      text: mlSectionText(e.subject, [ev.title, ev.sourceQuote]),
      status: ev.useful === false ? 'skipped' : (active ? 'active' : 'suggested')
    };
  });
  e.aiUsed = true;
  e.aiLinks = validated.links || [];
  e.diag = {
    ai: true,
    dropped: validated.dropped || 0,
    reason: e.events.length
      ? `AI: ${e.events.length} event(s) (${e.events.filter((x) => x.status === 'active').length} active)`
      : 'AI: no usable event'
  };
}

// `cache` is the previous settings.processedMessageIds ({sig, entries}) or null.
// `ai` (optional) = { enabled, model, apiKey, cache, callModel }.
// `ml` (optional) = { enabled, score: async (texts) => number[]|null }.
//   The scorer is built in main.js and runs the on-device embedding model. It
//   only ever ADDS mlScore / mlClass / mlReason to an item; it cannot change the
//   parsed event itself. Missing / off / failing => no scores, rules still work.
// Returns the emails that pass, the preview rows, and the cache to store again.
async function fetchPreview(gmailApi, filters = {}, cache = null, ai = null, ml = null) {
  const stats = { retries: 0, cached: 0, metadata: 0, full: 0, failed: 0 };
  const days = Math.max(30, Number(filters.days) || 30);      // at least the last 30 days
  const q = buildQuery(filters, days);
  const cap = Math.min(500, Math.max(1, Number(filters.maxResults) || 200));
  const aiKey = ai && ai.enabled ? String(ai.model || 'on') : '';
  const sig = cacheSignature(q, filters, aiKey);
  const store = cache && cache.sig === sig && cache.entries ? cache : { sig, entries: {} };

  const { ids, pages, capped } = await listMessageIds(gmailApi, q, cap, stats);
  const inWindow = new Set(ids);
  for (const id of Object.keys(store.entries)) if (!inWindow.has(id)) delete store.entries[id];

  const fresh = ids.filter((id) => !store.entries[id]);
  stats.cached = ids.length - fresh.length;

  // 3) Metadata for new ids only (no body).
  const metas = await mapLimit(fresh, CONCURRENCY, async (id) => {
    try {
      const data = await withRetry(async () => (await gmailApi.users.messages.get({
        userId: 'me', id, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date', 'List-Unsubscribe']
      })).data, stats);
      stats.metadata++;
      return normalizeMessage(data);
    } catch (err) {
      stats.failed++;
      return null;
    }
  });

  // 4) Sender / label rules on metadata. The keyword rule uses the snippet here.
  const newEmails = [];
  for (const e of metas) {
    if (!e) continue;
    e.body = e.snippet || '';
    const v = screenEmail(e, filters);
    e.pass = v.pass;
    e.reason = v.reason;
    e.trusted = v.trusted;
    e.excluded = v.excluded || null;
    newEmails.push(e);
  }

  // 5) Full body only for new trusted senders that passed.
  const needFull = newEmails.filter((e) => e.pass && e.trusted);
  await mapLimit(needFull, CONCURRENCY, async (e) => {
    try {
      const data = await withRetry(async () => (await gmailApi.users.messages.get({
        userId: 'me', id: e.id, format: 'full'
      })).data, stats);
      stats.full++;
      e.body = extractBodyText(data.payload).slice(0, 30000);
      e.urls = extractUrls(e.body, 8);              // links worth saving from this email
      const v = screenEmail(e, filters);            // keyword rule now sees the full body
      e.pass = v.pass;
      e.reason = v.reason;
      e.excluded = v.excluded || null;
      const { events, diag } = analyzeEmail(e.body, new Date(), { subject: e.subject, max: 5 });
      e.events = events;
      e.diag = diag;
    } catch (err) {
      stats.failed++;
      e.failed = true;                              // not cached: retried on the next sync
    }
  });

  // 5b) OPTIONAL AI step. Only trusted emails that already passed are ever sent.
  // The rule-based events from step 5 stay as the fallback if AI is off/fails.
  const aiStats = { calls: 0, cached: 0, failed: 0, retries: 0, limitReached: false };
  const llmCache = (ai && ai.cache && typeof ai.cache === 'object') ? ai.cache : {};
  if (ai && ai.enabled && typeof ai.callModel === 'function') {
    const targets = newEmails.filter((e) => !e.failed && e.pass && e.trusted);
    const today = toLocalDate(new Date());
    await mapLimit(targets, AI_CONCURRENCY, async (e) => {
      if (aiStats.limitReached) return;                 // stop gracefully, use rules
      const text = llm.cleanForAI(e.body, e.urls || []);
      const key = `${e.uid}:${llm.hashText(text)}`;
      const hit = llmCache[key];
      if (hit && hit.validated) { applyAiResult(e, hit.validated); aiStats.cached++; return; }
      try {
        const raw = await withAiRetry(() => ai.callModel({
          prompt: llm.buildPrompt({ text, subject: e.subject, receivedDate: e.date, today }),
          model: ai.model,
          apiKey: ai.apiKey
        }), aiStats);
        aiStats.calls++;
        const validated = llm.validateResult(raw, { text, now: new Date(), allowedUrls: e.urls || [] });
        // Cache by message id + hash of the text (never send the same email twice).
        llmCache[key] = { id: e.uid, model: ai.model, ts: Date.now(), validated, text };
        applyAiResult(e, validated);
      } catch (err) {
        aiStats.failed++;
        if (err && (err.code === 'RATE_LIMIT' || err.limitReached)) aiStats.limitReached = true;
        // fallback: keep the rule-based events already on e
      }
    });
  }

  // 5c) OPTIONAL learned relevance filter (on-device). It does not change what
  // was parsed; it only attaches a 0..1 score and a class to each item so the
  // renderer can show / suggest / hide it. Off, untrained or failing => no
  // scores and the rule-based pipeline is untouched.
  const mlStats = { enabled: !!(ml && ml.enabled), scored: 0, ready: false, error: null, classified: { normal: 0, suggested: 0, hidden: 0 } };
  if (ml && ml.enabled && typeof ml.score === 'function') {
    const refs = [];
    for (const e of newEmails) {
      if (e.failed || !e.pass || !e.trusted) continue;
      for (const ev of (e.events || [])) refs.push({ ev });
    }
    if (refs.length) {
      try {
        const scores = await ml.score(refs.map((r) => r.ev.text || r.ev.title || ''));
        if (Array.isArray(scores)) {
          mlStats.ready = true;
          refs.forEach((r, i) => {
            const s = scores[i];
            if (typeof s !== 'number' || !Number.isFinite(s)) return;
            const { cls, reason } = classify(s, {
              deadlineWord: hasDeadlineWord(r.ev.title),
              timedAppointment: !r.ev.allDay && !!r.ev.time
            });
            r.ev.mlScore = Math.round(s * 1000) / 1000;
            r.ev.mlClass = cls;
            r.ev.mlReason = reason;
            mlStats.classified[cls] = (mlStats.classified[cls] || 0) + 1;
            mlStats.scored++;
          });
        }
      } catch (err) {
        mlStats.error = String((err && err.message) || err);
      }
    }
  }

  for (const e of newEmails) {
    if (e.failed) continue;
    if (!e.trusted || !e.pass) {
      e.events = [];
      e.diag = e.pass ? { reason: 'not a trusted sender' } : { reason: 'no matching rule' };
    }
    store.entries[e.id] = slimEntry(e);
  }

  // Only NEW messages are screened, so each excluded email is reported once.
  const excluded = newEmails.filter((e) => e.excluded)
    .map((e) => ({ subject: e.subject || '', sender: e.fromEmail || e.from || '', keyword: e.excluded }));

  const emails = ids.map((id) => store.entries[id]).filter((e) => e && e.pass);
  const preview = buildPreviewRows(emails);

  console.log(`[gmail] sync: ${ids.length} listed | ${stats.cached} cached | ${fresh.length} new | ` +
    `${stats.metadata} metadata | ${stats.full} full | ${stats.retries} retries | ${stats.failed} failed`);
  console.log(`[llm] AI: ${aiStats.calls} call(s) | ${aiStats.cached} cached | ${aiStats.failed} failed | ` +
    `${aiStats.retries} retries | limitReached=${aiStats.limitReached}`);
  console.log(`[ml] filter: enabled=${mlStats.enabled} ready=${mlStats.ready} scored=${mlStats.scored} ` +
    `normal=${mlStats.classified.normal} suggested=${mlStats.classified.suggested} hidden=${mlStats.classified.hidden}` +
    (mlStats.error ? ` error=${mlStats.error}` : ''));

  return {
    query: q, candidates: ids.length, pages, capped, emails, preview, cache: store, stats, excluded,
    llmCache, aiStats: {
      calls: aiStats.calls, cached: aiStats.cached, failed: aiStats.failed,
      limitReached: aiStats.limitReached
    },
    mlStats
  };
}

module.exports = {
  buildQuery,
  matchesFilter,
  isTrusted,
  screenEmail,
  excludedKeyword,
  DEFAULT_EXCLUDE_KEYWORDS,
  parseFrom,
  normalizeMessage,
  extractBodyText,
  parseNewsletter,
  analyzeEmail,
  buildPreviewRows,
  fetchPreview,
  normalizeName,
  domainMatches
};
