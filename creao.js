// creao.js
// ---------------------------------------------------------------------------
// Calls the CREAO "Important Mail Scanner" agent via its API Trigger.
// This REPLACES the local Gemini + on-device ML ranking: the agent reads Gmail
// server-side (CREAO Gmail connector) and returns the important emails.
//
// The agent URL + API key are read from environment variables ONLY and never
// leave the main process. Never expose them to the renderer.
//   CREAO_AGENT_URL  -> the agent's API Trigger endpoint
//   CREAO_API_KEY    -> the capi_... key for that agent
// ---------------------------------------------------------------------------

// Pull from a local .env if present (optional). Falls back to process.env.
try { require('dotenv').config(); } catch { /* dotenv optional */ }

const AGENT_URL = process.env.CREAO_AGENT_URL || '';
const API_KEY = process.env.CREAO_API_KEY || '';

// The agent returns { important: [{title, subtitle, importance, reason}], ... }.
// Different CREAO run envelopes may nest that under result/output/data, and the
// payload may arrive as a JSON string. This digs it out defensively.
function extractImportant(payload) {
  const seen = new Set();
  function walk(node, depth) {
    if (node == null || depth > 6) return null;
    if (typeof node === 'string') {
      const t = node.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try { return walk(JSON.parse(t), depth + 1); } catch { return null; }
      }
      return null;
    }
    if (Array.isArray(node)) {
      // A bare array of {title, subtitle} is acceptable too.
      if (node.length && node[0] && (node[0].title || node[0].subtitle)) return node;
      for (const item of node) { const r = walk(item, depth + 1); if (r) return r; }
      return null;
    }
    if (typeof node === 'object') {
      if (seen.has(node)) return null;
      seen.add(node);
      if (Array.isArray(node.important)) return node.important;
      for (const k of ['result', 'output', 'data', 'response', 'body', 'json', 'value']) {
        if (k in node) { const r = walk(node[k], depth + 1); if (r) return r; }
      }
      for (const v of Object.values(node)) { const r = walk(v, depth + 1); if (r) return r; }
    }
    return null;
  }
  return walk(payload, 0) || [];
}

// Map the agent output to the shape the widget's email list already renders:
//   { from, subject, link, uid }
function toEmails(important) {
  return (important || []).map((m, i) => ({
    uid: 'creao:' + i + ':' + (m.subtitle || m.title || ''),
    from: m.title || '(unknown sender)',
    subject: m.subtitle || '(no subject)',
    link: '',                 // agent returns no deep link; open Gmail manually
    importance: typeof m.importance === 'number' ? m.importance : null,
    reason: m.reason || '',
    events: []                // agent path does not extract calendar events
  }));
}

// Public: fetch important mail from the CREAO agent.
// opts: { lookback_hours, max_results }
async function fetchImportantMail(opts = {}) {
  if (!AGENT_URL || !API_KEY) {
    return { ok: false, error: 'CREAO agent not configured. Set CREAO_AGENT_URL and CREAO_API_KEY.' };
  }
  const body = {
    lookback_hours: Number(opts.lookback_hours) || 24,
    max_results: Number(opts.max_results) || 10
  };
  try {
    const res = await fetch(AGENT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Agent HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const payload = await res.json();
    const important = extractImportant(payload);
    const emails = toEmails(important);
    // Log counts only — never the key or email contents.
    console.log(`[creao] important mail: ${emails.length} returned`);
    return { ok: true, emails, count: emails.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function status() {
  return { configured: !!(AGENT_URL && API_KEY) };
}

module.exports = { fetchImportantMail, status };
