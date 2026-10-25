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
    store.events.push({
      id: id(),
      title: fields.title,
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
    hit.title = fields.title;
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
    const hit = store.todos.find((t) => t && (String(t.agentTaskId) === String(proposal.id) ||
      (t.source === 'agent' && String(t.id) === String(proposal.id))));
    const e = edits || {};
    if (hit) {
      if (e.title) hit.title = e.title;
      if (e.due) hit.due = e.due;
      if (e.time != null) hit.time = e.time;
      hit.summary = proposal.summary || hit.summary || '';
      hit.priority_rank = proposal.priority_rank;
      hit.effort_estimate_minutes = proposal.effort_estimate_minutes;
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
    listProposals, pendingProposals, approveProposal, editProposal, rejectProposal, groupProposals, replacePending, briefBullets,
    listTaskProposals, pendingTaskProposals, approveTask, rejectTask, applyTaskUpdates, autoAddTasks
  };
});
