// agentFeed.js
// ---------------------------------------------------------------------------
// What the widget is allowed to show. In live mode the important-email list
// and locally parsed Gmail events come only from the Mail Scanner. The local
// Gmail list stays in the repo, but it fills the screen only when the restore
// setting is on and the app is not live.
// ---------------------------------------------------------------------------
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Feed = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  function mailKey(m) {
    return String(m.sender || '') + '::' + String(m.subject || '');
  }

  function mapEmails(output) {
    const events = (output && output.events) || [];
    return ((output && output.important_emails) || []).map((m) => ({
      key: mailKey(m),
      from: m.sender || '',
      subject: m.subject || '',
      link: m.link || '',
      summary: m.summary || '',
      category: m.category || 'important',
      reason: m.reason || '',
      events: events.filter((e) => e.source_subject === m.subject)
    }));
  }

  // Split the agent list into what to show and what it marked spam/ad.
  // Hidden keys and spam senders are removed entirely.
  function splitMail(emails, o) {
    const hidden = new Set((o.hiddenKeys || []).map(String));
    const spamSenders = new Set((o.spamSenders || []).map((s) => String(s).toLowerCase()));
    const kept = [];
    const spam = [];
    const hiddenMail = [];
    for (const e of emails) {
      if (hidden.has(e.key) || spamSenders.has(String(e.from).toLowerCase())) {
        hiddenMail.push(e);
        continue;
      }
      if (e.category !== 'important') spam.push(e);
      else kept.push(e);
    }
    return { kept, spam, hidden: hiddenMail };
  }

  function emailList(opts) {
    const o = opts || {};
    const live = o.globalMode === 'live';
    const mail = o.mail || {};
    if (live) {
      if (mail.status === 'running') {
        return { kind: 'working', emails: [], spam: [], hidden: [], banner: 'Mail Scanner is working…' };
      }
      const failed = mail.status === 'error' || mail.mode === 'mock' || !o.mailOutput;
      if (failed) return { kind: 'offline', emails: [], spam: [], hidden: [], banner: 'Mail Scanner offline' };
      const split = splitMail(mapEmails(o.mailOutput), o);
      return { kind: 'agent', emails: split.kept, spam: split.spam, hidden: split.hidden, banner: null };
    }
    if (o.localSyncEnabled) {
      return { kind: 'local', emails: o.localEmails || [], spam: [], hidden: [], banner: null };
    }
    const split = splitMail(mapEmails(o.mailOutput), o);
    return { kind: 'mock', emails: split.kept, spam: split.spam, hidden: split.hidden, banner: 'mock' };
  }

  function visibleEvents(events, globalMode) {
    const list = events || [];
    if (globalMode === 'live') return list.filter((e) => e.source !== 'gmail');
    return list;
  }

  function orderTodos(todos, analystTasks) {
    const list = (todos || []).slice();
    if (!analystTasks || !analystTasks.length) return list;
    const rank = new Map();
    for (const t of analystTasks) {
      if (t && t.id != null) rank.set(t.id, Number(t.priority_rank) || 9999);
    }
    return list.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : 100000;
      const rb = rank.has(b.id) ? rank.get(b.id) : 100000;
      if (ra !== rb) return ra - rb;
      return 0;
    });
  }

  // The one visible task list: approved agent tasks plus manual tasks. When the
  // Analyst is offline in live mode, only the manual ones are shown.
  function taskList(todos, opts) {
    const o = opts || {};
    const list = (todos || []).filter((t) => t && (t.source === 'manual' || t.source === 'agent'));
    if (o.globalMode === 'live' && o.analystOffline) {
      return { tasks: list.filter((t) => t.source === 'manual'), banner: 'Task Analyst offline' };
    }
    return { tasks: list, banner: null };
  }

  return { emailList, visibleEvents, orderTodos, taskList };
});
