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

  function rejectProposal(store, proposal, id) {
    return put(store, proposal, 'dismissed', null, id);
  }

  return { listProposals, pendingProposals, approveProposal, rejectProposal };
});
