// reality.js
// ---------------------------------------------------------------------------
// Pure helpers for the reality-check loop. A finished Focus work block records
// minutes. The Planner gets estimated-versus-actual pairs. The card says how
// far those estimates usually are. No files, no network.
// ---------------------------------------------------------------------------
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Reality = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function addSession(log, entry) {
    if (!log.sessions) log.sessions = [];
    const taskId = String(entry && entry.taskId || '').trim();
    const minutes = Number(entry && entry.minutes);
    if (!taskId || !Number.isFinite(minutes) || minutes < 1 || minutes > 180) return log;
    log.sessions.push({
      taskId,
      minutes: Math.round(minutes),
      at: (entry && entry.at) || new Date().toISOString()
    });
    return log;
  }

  function estimateHistory(tasks, log) {
    const actual = {};
    for (const s of (log && log.sessions) || []) {
      if (!s || !s.taskId) continue;
      actual[s.taskId] = (actual[s.taskId] || 0) + Number(s.minutes || 0);
    }
    const out = [];
    for (const t of tasks || []) {
      const estimated = Number(t && t.effort_estimate_minutes);
      const spent = actual[t && t.id];
      if (!t || !t.id || !Number.isFinite(estimated) || estimated <= 0 || !spent) continue;
      out.push({ task_id: t.id, estimated_minutes: estimated, actual_minutes: spent });
    }
    return out;
  }

  function offLabel(history) {
    const rows = (history || []).filter((h) => h && Number(h.estimated_minutes) > 0);
    if (!rows.length) return null;
    const mean = rows.reduce((sum, h) => {
      return sum + Math.abs(Number(h.actual_minutes) - Number(h.estimated_minutes)) / Number(h.estimated_minutes) * 100;
    }, 0) / rows.length;
    return 'your estimates are usually ' + Math.round(mean) + '% off';
  }

  return { addSession, estimateHistory, offLabel };
});
