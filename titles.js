// titles.js
// ---------------------------------------------------------------------------
// Pure text helpers for producing CLEAN event titles:
//   - decodeEntities(): turn &ndash; &amp; &nbsp; &#39; etc. into real characters
//   - stripHtml(): remove tags
//   - stripUrls(): remove links (<https://...>, https://..., www..., domain/path)
//   - cleanTitle(): decode + strip + remove ">" quote markers and stray symbols
//   - isJunkTitle(): reject non-titles like "DATE", "", "https://...", "6:00"
//   - titleFromText(): clean a title, falling back to the email subject if junk
// No network, no Electron — so it is easy to unit-test.
// ---------------------------------------------------------------------------

// A small set of the HTML entities that show up most in email/newsletters.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  bull: '\u2022', middot: '\u00B7', sect: '\u00A7', para: '\u00B6',
  copy: '\u00A9', reg: '\u00AE', trade: '\u2122', deg: '\u00B0',
  times: '\u00D7', divide: '\u00F7', minus: '\u2212', plusmn: '\u00B1',
  frac12: '\u00BD', frac14: '\u00BC', frac34: '\u00BE',
  euro: '\u20AC', pound: '\u00A3', yen: '\u00A5', cent: '\u00A2',
  laquo: '\u00AB', raquo: '\u00BB', shy: '',
  eacute: '\u00E9', egrave: '\u00E8', agrave: '\u00E0', ccedil: '\u00E7',
  uuml: '\u00FC', ouml: '\u00F6', auml: '\u00E4', ntilde: '\u00F1',
  aacute: '\u00E1', iacute: '\u00ED', oacute: '\u00F3', uacute: '\u00FA'
};

function decodeEntities(input) {
  return String(input == null ? '' : input)
    // &#x1F600; / &#128512;
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ' '; }
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      try { return String.fromCodePoint(Number(dec)); } catch { return ' '; }
    })
    // &name;
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED, key) ? NAMED[key] : m;
    });
}

function stripHtml(input) {
  return String(input == null ? '' : input)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

function stripUrls(input) {
  return String(input == null ? '' : input)
    .replace(/<https?:\/\/[^>]*>/gi, ' ')                       // <https://...>
    .replace(/https?:\/\/\S+/gi, ' ')                           // https://...
    .replace(/www\.[\w.-]+\S*/gi, ' ')                          // www.something...
    .replace(/\b[\w.-]+\.(com|org|net|edu|gov|io|co|ly|me|info|biz|xyz)(\/|\b)\S*/gi, ' ');
}

// Characters we consider "decoration" at the very start/end of a title:
// dashes, dots, pipes, arrows, bullets, quotes, asterisks, etc.
// Deliberately EXCLUDES brackets ( ) [ ] { } so "Exam [F26]" keeps its close.
const EDGE = /^[-_\s.,;:|>*+=~^!?/\\#\u2013\u2014\u2026\u00B7\u2022\u00AB\u00BB"'\u2018\u2019\u201C\u201D]+|[-_\s.,;:|>*+=~^!?/\\#\u2013\u2014\u2026\u00B7\u2022\u00AB\u00BB"'\u2018\u2019\u201C\u201D]+$/g;

function trimEdges(input) {
  let out = input;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(EDGE, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

// Turn any raw scraped text into a presentable title.
function cleanTitle(input) {
  let s = String(input == null ? '' : input);
  s = stripHtml(s);
  s = decodeEntities(s);
  s = stripUrls(s);
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');        // zero-width chars
  s = s.replace(/^[>\s]+/gm, ' ');                     // ">" quote markers
  s = s.replace(/&[a-z]{1,8};?/gi, ' ');               // leftover/dangling entities
  s = s.replace(/\s+/g, ' ');
  s = trimEdges(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Words that are labels, not event names.
const LABEL_WORDS = new Set([
  'date', 'dates', 'deadline', 'deadlines', 'time', 'times', 'event', 'events',
  'notice', 'reminder', 'announcement', 'announcements', 'news', 'update',
  'updates', 'schedule', 'calendar', 'important', 'title', 'when', 'where',
  'location', 'details', 'info', 'information', 'today', 'tomorrow', 'week',
  'upcoming', 'rsvp', 'join', 'join us', 'learn more', 'read more', 'more info',
  'save the date', 'click here', 'this week', 'mark your calendar'
]);

// Is this text NOT usable as an event title?
function isJunkTitle(input) {
  const s = String(input == null ? '' : input).trim();
  if (s.length < 4) return true;                       // too short
  if (/^https?:/i.test(s)) return true;                // a bare link
  if (!/[a-z]/i.test(s)) return true;                  // no letters at all
  const norm = s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (LABEL_WORDS.has(norm)) return true;              // "DATE", "Deadline", ...
  return false;
}

// Clean a title; if it ends up junk, use the fallback (usually the subject).
function titleFromText(raw, fallback) {
  const cleaned = cleanTitle(raw);
  if (!isJunkTitle(cleaned)) return cleaned;
  const fb = cleanTitle(fallback);
  return isJunkTitle(fb) ? 'Untitled event' : fb;
}

// Pull the distinct http(s) links out of some text (email body, description...).
// Trailing punctuation is trimmed so "see https://a.com/x." does not keep the dot.
function extractUrls(input, limit = 10) {
  const text = String(input == null ? '' : input);
  const re = /https?:\/\/[^\s"'<>()\]]+/gi;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    // Skip obvious tracking/asset noise that is never a real "link to save".
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js)(\?|$)/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { decodeEntities, stripHtml, stripUrls, cleanTitle, isJunkTitle, titleFromText, extractUrls };
