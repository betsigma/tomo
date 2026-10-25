// inbox.js
// ---------------------------------------------------------------------------
// Pure approval inbox. Agents only propose. Approve writes one calendar event.
// Reject writes a dismissed tombstone with the same dedupeKey, so a later run
// cannot bring that proposal back. Nothing here touches the network.
// ---------------------------------------------------------------------------
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Inbox = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
  }

  function splitStamp(stamp) {
    const raw = String(stamp || '');
    const [date, time = ''] = raw.split('T');
    return { date: date.slice(0, 10), time: time.slice(0, 5) };
  }

  function listProposals(outputs) {
    const out = [];
    const o = outputs || {};
    const planner = (o.PLANNER && o.PLANNER.proposals) || [];
    for (const p of planner) {
      const start = splitStamp(p.start);
      const end = splitStamp(p.end);
      out.push({
        key: 'agent:block:' + (p.task_id || '') + ':' + (p.start || ''),
        kind: 'block',
        title: p.title || 'Study block',
        start: start.date,
        time: start.time,
        endTime: end.date === start.date ? end.time : '',
        location: '',
        reason: p.reason || '',
        summary: '',
        what: p.reason || ''
      });
    }
    const emails = (o.MAIL && o.MAIL.important_emails) || [];
    for (const ev of (o.MAIL && o.MAIL.events) || []) {
      const mail = emails.find((m) => m.subject && m.subject === ev.source_subject) || {};
      out.push({
        key: 'agent:mail:' + String(ev.date || '').slice(0, 10) + ':' + slug(ev.title),
        kind: 'mail',
        title: ev.title || 'Email date',
        start: String(ev.date || '').slice(0, 10),
        time: ev.start_time || '',
        endTime: ev.end_time || '',
        location: ev.location || '',
        reason: mail.reason || '',
        summary: mail.summary || '',
        what: [mail.summary, mail.reason].filter(Boolean).join(' — ')
      });
    }
    // Meetings the Analyst found in Discord announcements. Reposts of the same
    // meeting share a key; keep one, preferring the copy that has an end time.
    const discordAt = new Map();
    for (const ev of (o.ANALYST && o.ANALYST.events) || []) {
      const key = 'agent:discord:' + String(ev.date || '').slice(0, 10) + ':' + slug(ev.title);
      const at = discordAt.has(key) ? discordAt.get(key) : out.length;
      if (at < out.length && (out[at].endTime || !ev.end_time)) continue;
      discordAt.set(key, at);
      out[at] = {
        key,
        kind: 'discord',
        title: ev.title || 'Discord event',
        start: String(ev.date || '').slice(0, 10),
        time: ev.start_time || '',
        endTime: ev.end_time || '',
        location: ev.location || '',
        reason: 'From a Discord announcement',
        summary: ev.summary || '',
        what: [ev.summary, 'From a Discord announcement'].filter(Boolean).join(' — ')
      };
    }
    for (const t of (o.ANALYST && o.ANALYST.tasks) || []) {
      if (t.source !== 'email') continue;
      const due = splitStamp(t.due_date);
      out.push({
        key: 'agent:email:' + (t.id || ''),
        kind: 'email-task',
        title: t.title || 'Email task',
        start: due.date,
        time: due.time,
        endTime: '',
        location: '',
        reason: t.urgency_reason || '',
        summary: t.summary || '',
        what: [t.summary, t.urgency_reason].filter(Boolean).join(' — ')
      });
    }
    return out;
  }

  // ----- Study-block rules. The Planner's output is untrusted, so the app enforces these. -----
  // The study day runs dayStart -> dayEnd; a dayEnd earlier than dayStart means after midnight.
  const PLAN_RULES = { dayStart: '09:00', dayEnd: '02:00', capMinutes: 420, minMinutes: 25,
    quiet: [{ start: '20:00', end: '21:00' }] };

  function hm(t) { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); }
  function prevDate(date) {
    const [y, mo, d] = date.split('-').map(Number);
    const p = new Date(y, mo - 1, d - 1);
    return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-${String(p.getDate()).padStart(2, '0')}`;
  }
  // Which study day a stamp belongs to, and its minute on that day (01:00 -> previous day, 1500).
  function studyClock(stamp, rules) {
    const { date, time } = splitStamp(stamp);
    const at = hm(time);
    return at < hm(rules.dayStart) ? { day: prevDate(date), at: at + 1440 } : { day: date, at };
  }

  // "Week 6 Programming Assignments - Arrays [F26 CIS D022A ...]" -> without the course tag.
  function shortTitle(title) {
    return String(title || '').replace(/\s*\[[^\]]*\]\s*$/, '').replace(/\s+/g, ' ').trim() || 'Study';
  }

  // Keep only blocks that follow the rules: at least minMinutes, never after the task's
  // due date, inside the study day, outside protected time, and under the daily cap.
  // dueById: task id -> 'YYYY-MM-DD' (end of that day) or 'YYYY-MM-DDTHH:MM'.
  function fitBlocks(proposals, dueById, rules) {
    const r = { ...PLAN_RULES, ...(rules || {}) };
    const dayEnd = hm(r.dayEnd) <= hm(r.dayStart) ? hm(r.dayEnd) + 1440 : hm(r.dayEnd);
    const used = {};
    const kept = [];
    const dropped = [];
    const sorted = (proposals || []).slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
    for (const p of sorted) {
      const s = studyClock(p.start, r);
      const e = studyClock(p.end, r);
      const len = e.day === s.day ? e.at - s.at : -1;
      const dueRaw = String((dueById || {})[p.task_id] || '');
      const due = dueRaw.length > 10 ? dueRaw.slice(0, 16) : (dueRaw ? dueRaw.slice(0, 10) + 'T23:59' : '');
      let why = null;
      if (len < r.minMinutes) why = len < 0 ? 'crosses the end of the study day' : `shorter than ${r.minMinutes} min`;
      else if (due && String(p.end).slice(0, 16) > due) why = 'after the due date';
      else if (e.at > dayEnd) why = 'after ' + r.dayEnd;
      else if ((r.quiet || []).some((q) => s.at < hm(q.end) && hm(q.start) < e.at)) why = 'during protected time';
      else if ((used[s.day] || 0) + len > r.capMinutes) why = 'over the daily study cap';
      if (why) { dropped.push({ proposal: p, why }); continue; }
      used[s.day] = (used[s.day] || 0) + len;
      kept.push(p);
    }
    return { kept, dropped };
  }

  // ----- Fun events (club meetings, socials) vs deadlines -----
  // Events come only from agent output: Mail Scanner dates and Discord items the
  // Analyst found. Planner blocks and email tasks are not events.
  const EVENT_KINDS = { mail: 'from email', discord: 'from Discord' };
  function eventSource(keyOrKind) {
    const kind = String(keyOrKind || '').replace(/^agent:/, '').split(':')[0];
    return EVENT_KINDS[kind] || null;
  }
  function isEventItem(ev) {
    return !!(ev && String(ev.dedupeKey || '').indexOf('agent:') === 0 && eventSource(ev.dedupeKey));
  }

  function clock(t) {
    const [h, m] = String(t || '').split(':').map(Number);
    if (!Number.isFinite(h)) return '';
    return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;
  }
  // "I'm in / Maybe / Can't make it" poll titled with name, day, time and place.
  // Course codes are stripped; nothing else about the event is shared.
  function rsvpRequest(ev) {
    const [y, mo, d] = String(ev.start || '').split('-').map(Number);
    const day = y ? new Date(y, mo - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
    const time = ev.time ? clock(ev.time) + (ev.endTime && ev.endTime !== ev.time ? '-' + clock(ev.endTime) : '') : '';
    const parts = [shortTitle(ev.title).replace(/\[[^\]]*\]/g, '').trim(), [day, time].filter(Boolean).join(' '), ev.location || '']
      .filter(Boolean);
    return { type: 'poll', question: 'Who\'s in? ' + parts.join(' · '), options: ['I\'m in', 'Maybe', 'Can\'t make it'] };
  }

  // "<name> finished: <title>" for a shared task, or null: not shared, or already
  // posted (keyed by title + due, so a re-synced copy of the task doesn't post again).
  function donePost(task, name, posted) {
    if (!task || !task.shared) return null;
    if ((posted || []).includes(taskKey(task.title, task.due))) return null;
    return { type: 'text', text: `${name || 'Betsy'} finished: ${shortTitle(task.title).replace(/\[[^\]]*\]/g, '').trim()}` };
  }

  // Once: take every approved study block off the calendar so the next run re-plans
  // under the rules above. A copy stays in store.archived.agentBlocksBackup.
  // Rejected blocks (dismissed) stay, so they are not suggested again.
  function resetBlocksOnce(store, at) {
    if (!store.settings) store.settings = {};
    if (store.settings.studyBlocksResetAt) return false;
    const isApprovedBlock = (e) => e && String(e.dedupeKey || '').indexOf('agent:block:') === 0 && e.status === 'active';
    store.archived = store.archived || {};
    store.archived.agentBlocksBackup = { at, events: (store.events || []).filter(isApprovedBlock) };
    store.events = (store.events || []).filter((e) => !isApprovedBlock(e));
    store.settings.studyBlocksResetAt = at;
    return true;
  }

  // Same assignment even if the Analyst gave it a different id on another run.
  function taskKey(title, due) {
    return String(title || '').replace(/\s+/g, ' ').trim().toLowerCase() + '|' + String(due || '').slice(0, 10);
  }

  function decided(store) {
    const keys = new Set();
    for (const e of (store && store.events) || []) {
      if (e && e.dedupeKey && String(e.dedupeKey).indexOf('agent:') === 0) keys.add(e.dedupeKey);
    }
    return keys;
  }

  function pendingProposals(outputs, store) {
    const skip = decided(store);
    return listProposals(outputs).filter((p) => !skip.has(p.key));
  }

  function withEdits(proposal, edits) {
    const e = edits || {};
    return {
      title: e.title ? e.title : proposal.title,
      start: e.start || proposal.start,
      time: e.time != null && e.time !== '' ? e.time : (proposal.time || ''),
      endTime: e.endTime != null ? e.endTime : (proposal.endTime || ''),
      location: e.location != null ? e.location : (proposal.location || '')
    };
  }

  function put(store, proposal, status, edits, id) {
    if (!store.events) store.events = [];
    if (store.events.some((e) => e && e.dedupeKey === proposal.key)) return store;
    const fields = withEdits(proposal, edits);
    const block = proposal.kind === 'block';
    store.events.push({
      id: id(),
      // A study block never reuses the real task's title; taskTitle links it back.
      title: block && fields.title === proposal.title ? 'Study: ' + shortTitle(proposal.title) : fields.title,
      taskTitle: block ? proposal.title : undefined,
      start: fields.start,
      time: fields.time,
      endTime: fields.endTime,
      location: fields.location,
      source: 'agent',
      dedupeKey: proposal.key,
      status,
      done: false,
      notes: proposal.summary || '',
      course: '',
      description: proposal.what || ''
    });
    return store;
  }

  function approveProposal(store, proposal, edits, id) {
    return put(store, proposal, 'active', edits, id);
  }

  // Edit an approved block in place, keeping its dedupe key. Saving an edit on a
  // pending block counts as approving it with those edits.
  function editProposal(store, proposal, edits) {
    const hit = ((store && store.events) || []).find((e) => e && e.dedupeKey === proposal.key);
    if (!hit) return approveProposal(store, proposal, edits, () => 'agent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    const fields = withEdits(proposal, edits);
    hit.title = proposal.kind === 'block' && fields.title === proposal.title ? 'Study: ' + shortTitle(proposal.title) : fields.title;
    hit.start = fields.start;
    hit.time = fields.time;
    hit.endTime = fields.endTime;
    hit.location = fields.location;
    return store;
  }

  function rejectProposal(store, proposal, id) {
    return put(store, proposal, 'dismissed', null, id);
  }

  function durationMinutes(start, end) {
    const a = splitStamp(start);
    const b = splitStamp(end);
    if (!a.time || !b.time) return 0;
    const [ah, am] = a.time.split(':').map(Number);
    const [bh, bm] = b.time.split(':').map(Number);
    return Math.max(0, (bh * 60 + bm) - (ah * 60 + am));
  }

  function dedupeProposals(proposals) {
    const seen = new Set();
    const out = [];
    for (const p of proposals || []) {
      const key = [p.task_id || '', p.start || '', p.end || ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }

  function replacePending(previous, next) {
    const incoming = dedupeProposals(next);
    const ids = new Set(incoming.map((p) => p.task_id).filter(Boolean));
    const kept = (previous || []).filter((p) => !p.task_id || !ids.has(p.task_id));
    return dedupeProposals(kept.concat(incoming));
  }

  function groupProposals(proposals, dueById) {
    const due = dueById || {};
    const groups = new Map();
    for (const p of dedupeProposals(proposals)) {
      const id = p.task_id || p.title || 'task';
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(p);
    }
    return [...groups.values()].map((blocks) => {
      blocks.sort((a, b) => String(a.start).localeCompare(String(b.start)));
      const n = blocks.length;
      const parts = blocks.map((b, i) => {
        const start = splitStamp(b.start);
        const end = splitStamp(b.end);
        const mins = durationMinutes(b.start, b.end);
        const taskDue = String(due[b.task_id] || '').slice(0, 10);
        return {
          key: 'agent:block:' + (b.task_id || '') + ':' + (b.start || ''),
          taskId: b.task_id,
          title: b.title,
          start: start.date,
          time: start.time,
          endTime: end.time,
          reason: b.reason || '',
          minutes: mins,
          label: 'Part ' + (i + 1) + '/' + n + ' · ' + start.time + '-' + end.time + ' (' + mins + ' min)',
          afterDeadline: !!(taskDue && start.date > taskDue)
        };
      });
      return {
        taskId: blocks[0].task_id,
        title: blocks[0].title || 'Study block',
        due: String(due[blocks[0].task_id] || '').slice(0, 10),
        totalMinutes: parts.reduce((sum, p) => sum + p.minutes, 0),
        count: n,
        blocks: parts
      };
    });
  }

  // ----- Analyst task proposals (the "New tasks" inbox) -----
  function listTaskProposals(outputs) {
    const tasks = (outputs && outputs.ANALYST && outputs.ANALYST.tasks) || [];
    return tasks.map((t) => ({
      id: t.id,
      key: 'agent:task:' + (t.id || ''),
      kind: 'task',
      title: t.title || 'Task',
      due: String(t.due_date || '').slice(0, 10),
      time: String(t.due_date || '').includes('T') ? String(t.due_date).split('T')[1].slice(0, 5) : '',
      priority_rank: t.priority_rank,
      summary: t.summary || '',
      urgency_reason: t.urgency_reason || '',
      effort_estimate_minutes: t.effort_estimate_minutes,
      deliverables: Array.isArray(t.deliverables) ? t.deliverables : [],
      source: t.source || 'canvas'
    }));
  }

  function rejectedIds(store) {
    return new Set(((store && store.agentRejects) || []).map(String));
  }

  function approvedIds(store) {
    const ids = new Set();
    for (const t of (store && store.todos) || []) {
      if (!t) continue;
      if (t.agentTaskId) ids.add(String(t.agentTaskId));
      if (t.source === 'agent' && t.id) ids.add(String(t.id));
    }
    return ids;
  }

  function pendingTaskProposals(outputs, store) {
    const skipRejected = rejectedIds(store);
    const skipApproved = approvedIds(store);
    return listTaskProposals(outputs).filter((p) => p.id && !skipRejected.has(String(p.id)) && !skipApproved.has(String(p.id)));
  }

  function approvedTaskList(store, proposal, edits) {
    if (!store.todos) store.todos = [];
    const key = taskKey(proposal.title, proposal.due);
    const hit = store.todos.find((t) => t && (String(t.agentTaskId) === String(proposal.id) ||
      (t.source === 'agent' && String(t.id) === String(proposal.id)))) ||
      store.todos.find((t) => t && t.source === 'agent' && taskKey(t.title, t.due) === key);
    const e = edits || {};
    if (hit) {
      hit.agentTaskId = proposal.id;   // follow the Analyst's current id
      if (e.title) hit.title = e.title;
      if (e.due) hit.due = e.due;
      if (e.time != null) hit.time = e.time;
      hit.summary = proposal.summary || hit.summary || '';
      hit.priority_rank = proposal.priority_rank;
      hit.effort_estimate_minutes = proposal.effort_estimate_minutes;
      if (proposal.deliverables && proposal.deliverables.length) hit.deliverables = proposal.deliverables;
      return hit;
    }
    const row = {
      id: proposal.id,
      agentTaskId: proposal.id,
      title: e.title || proposal.title,
      course: '',
      due: e.due || proposal.due,
      time: e.time != null ? e.time : (proposal.time || ''),
      location: '',
      done: false,
      source: 'agent',
      status: 'active',
      dedupeKey: null,
      summary: proposal.summary || '',
      priority_rank: proposal.priority_rank,
      effort_estimate_minutes: proposal.effort_estimate_minutes,
      deliverables: proposal.deliverables || [],
      urgency_reason: proposal.urgency_reason || '',
      agentSource: proposal.source || 'canvas'
    };
    store.todos.push(row);
    return row;
  }

  function approveTask(store, proposal, edits) {
    return approvedTaskList(store, proposal, edits);
  }

  function rejectTask(store, proposal) {
    if (!store.agentRejects) store.agentRejects = [];
    if (!store.agentRejects.includes(String(proposal.id))) store.agentRejects.push(String(proposal.id));
    if (store.todos) {
      store.todos = store.todos.filter((t) => {
        if (!t) return false;
        const sameAgent = String(t.agentTaskId || '') === String(proposal.id);
        const sameId = t.source === 'agent' && String(t.id) === String(proposal.id);
        return !(sameAgent || sameId);
      });
    }
    return store;
  }

  // Analyst tasks join the one task list without approval. Reject still removes
  // one, and that id is remembered so it is not added back.
  function autoAddTasks(store, outputs) {
    const before = (store.todos || []).length;
    for (const p of pendingTaskProposals(outputs, store)) approveTask(store, p, null);
    return (store.todos || []).length - before;
  }

  // One-time cleanup: agent tasks added twice under different ids become one.
  // Keeps the first row (its id links Focus time), done if either was done.
  function mergeDuplicateTodos(store) {
    const first = new Map();
    let removed = 0;
    store.todos = ((store && store.todos) || []).filter((t) => {
      if (!t || t.source !== 'agent') return true;
      const key = taskKey(t.title, t.due);
      const keep = first.get(key);
      if (!keep) { first.set(key, t); return true; }
      keep.done = !!(keep.done || t.done);
      keep.pomodoros = Math.max(Number(keep.pomodoros) || 0, Number(t.pomodoros) || 0);
      keep.partsDone = [...new Set([...(keep.partsDone || []), ...(t.partsDone || [])])];
      if (t.deliverables && t.deliverables.length) keep.deliverables = t.deliverables;
      keep.agentTaskId = t.agentTaskId || keep.agentTaskId;   // later rows carry the newer id
      removed++;
      return false;
    });
    return removed;
  }

  // After a rerun, refresh the summary and priority on tasks already approved.
  function applyTaskUpdates(store, outputs) {
    const tasks = (outputs && outputs.ANALYST && outputs.ANALYST.tasks) || [];
    let changed = false;
    for (const a of tasks) {
      const hit = ((store && store.todos) || []).find((t) => t && t.agentTaskId && String(t.agentTaskId) === String(a.id));
      if (!hit) continue;
      if (a.summary && hit.summary !== a.summary) { hit.summary = a.summary; changed = true; }
      if (a.priority_rank != null && hit.priority_rank !== a.priority_rank) { hit.priority_rank = a.priority_rank; changed = true; }
      if (a.effort_estimate_minutes != null && hit.effort_estimate_minutes !== a.effort_estimate_minutes) {
        hit.effort_estimate_minutes = a.effort_estimate_minutes; changed = true;
      }
      if (Array.isArray(a.deliverables) && a.deliverables.length &&
          JSON.stringify(hit.deliverables || []) !== JSON.stringify(a.deliverables)) {
        hit.deliverables = a.deliverables; changed = true;
      }
    }
    return changed;
  }

  function briefBullets(text) {
    return String(text || '').replace(/\s+/g, ' ').trim()
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    listProposals, pendingProposals, approveProposal, editProposal, rejectProposal, taskKey, mergeDuplicateTodos, PLAN_RULES, fitBlocks, shortTitle, studyClock, resetBlocksOnce, isEventItem, eventSource, rsvpRequest, donePost, groupProposals, replacePending, briefBullets,
    listTaskProposals, pendingTaskProposals, approveTask, rejectTask, applyTaskUpdates, autoAddTasks
  };
});
