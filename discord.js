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

// The team digest as one Discord message: a heading plus bullet lines.
// Discord rejects messages over 2,000 characters, so keep a margin.
function digestMessage(teamDigest) {
  const bullets = (Array.isArray(teamDigest) ? teamDigest : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .map((s) => '• ' + s);
  return ('📌 Team digest\n' + bullets.join('\n')).slice(0, 1900);
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

module.exports = { normalizeDiscordMessage, digestMessage, weeklyDue, weekStart };
