// discord.js
// ---------------------------------------------------------------------------
// Discord-specific logic that does NOT need the network: turning raw Discord
// API messages into simple objects for the widget. Dates are NOT found here:
// the Deadline & Task Analyst reads each message's full text and proposes them.
// The API calls live in main.js.
// ---------------------------------------------------------------------------

// A followed-announcement crosspost carries a channel label like
// "Women In Stem De Anza #announcements" instead of the real text. Detect it so
// we can skip that line (the trailing "#channel" matches the channel name).
function isFollowLabel(line, channelName) {
  const s = String(line || '').trim();
  if (!s) return false;
  const m = s.match(/#([\w-]+)\s*$/);
  if (!m) return false;
  const name = String(channelName || '').trim().toLowerCase();
  return !!name && m[1].toLowerCase() === name;
}

// First non-empty line of a block of text.
function firstLine(text, channelName) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  while (lines.length && isFollowLabel(lines[0], channelName)) lines.shift();
  return lines[0] || '';
}

// Turn one raw Discord message into a short object.
// Prefer an embed's title/description (announcements often live there); otherwise
// the first usable line of the message text. A message with no usable text comes
// back with an empty `content`, and the caller filters it out.
function normalizeDiscordMessage(m, channelName) {
  const embeds = Array.isArray(m.embeds) ? m.embeds : [];
  let content = '';
  for (const e of embeds) {
    const t = String((e && (e.title || e.description)) || '').trim();
    if (t) { content = t; break; }
  }
  if (!content) content = firstLine(m.content, channelName);

  const author = (m.author && (m.author.global_name || m.author.username)) || 'Discord';

  // Full text for the Analyst: the date is often not on the first line.
  const text = [m.content, ...embeds.flatMap((e) => [e && e.title, e && e.description])]
    .filter(Boolean).join('\n').trim().slice(0, 1000);

  return {
    uid: String(m.id),
    author,
    content,
    text: content ? text : '',
    channelName: channelName || '',
    timestamp: m.timestamp || ''
  };
}

// This week's Monday at 09:00 local time.
function weekStart(now) {
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  const sinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - sinceMonday);
  return d;
}

// True when the weekly post is enabled, the Monday 9 AM slot has passed, and
// nothing has been posted since that slot.
function weeklyDue(lastPostedAt, now, enabled) {
  if (!enabled) return false;
  const slot = weekStart(now);
  if (now < slot) return false;
  if (!lastPostedAt) return true;
  return new Date(lastPostedAt) < slot;
}

// ----- Everything Tomo posts is built here, so the content rules live in one place -----
const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

// Strip [course codes], links and extra spaces. Posts carry titles and times only.
function cleanPostText(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
    .trim();
}

// One post from a request: {type:'text', text} or {type:'poll', question, options[]}.
// Returns {content} or {question, options}; poll limits are Discord's (300 / 55 chars).
function buildPost(req) {
  if (req && req.type === 'poll') {
    const options = (req.options || []).map((o) => cleanPostText(o).slice(0, 55)).filter(Boolean).slice(0, 5);
    return { question: cleanPostText(req.question).slice(0, 300), options };
  }
  return { content: cleanPostText(req && req.text).slice(0, 1900) };
}

// The same poll as plain text, for the reaction fallback.
function pollAsText(post) {
  return [post.question, ...post.options.map((o, i) => `${NUMBERS[i]} ${o}`)].join('\n');
}

// Votes from a fetched message: a native poll's answer counts, or the number
// reactions minus the bot's own (it adds one of each so people can tap them).
function countVotes(message, labels) {
  const m = message || {};
  let counts;
  if (m.poll) {
    const answers = m.poll.answers || [];
    const results = (m.poll.results && m.poll.results.answer_counts) || [];
    counts = answers.map((a, i) => {
      const hit = results.find((r) => r.id === a.answer_id);
      return { label: (a.poll_media && a.poll_media.text) || labels[i] || '', count: hit ? hit.count : 0 };
    });
  } else {
    counts = (labels || []).map((label, i) => {
      const r = (m.reactions || []).find((x) => x.emoji && x.emoji.name === NUMBERS[i]);
      return { label, count: r ? Math.max(0, r.count - (r.me ? 1 : 0)) : 0 };
    });
  }
  const top = Math.max(0, ...counts.map((c) => c.count));
  const leaders = counts.filter((c) => c.count === top && top > 0);
  return { counts, winner: leaders.length === 1 ? leaders[0].label : null, tie: leaders.length > 1 };
}

// 'live' only when posting is switched on and the app is not in mock mode.
function postMode(posting, creaoMode) {
  if (String(creaoMode || '').trim().toLowerCase() === 'mock') return 'mock';
  return posting ? 'live' : 'off';
}

// Fake votes for mock mode, so the demo works without Discord.
function mockVotes(labels) {
  const fake = [3, 1, 0, 0, 0];
  return { counts: labels.map((label, i) => ({ label, count: fake[i] || 0 })), winner: labels[0] || null, tie: false, mock: true };
}

module.exports = { normalizeDiscordMessage, weeklyDue, weekStart,
  cleanPostText, buildPost, pollAsText, countVotes, mockVotes, postMode, NUMBERS };
