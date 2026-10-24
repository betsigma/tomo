// sync.js
// ---------------------------------------------------------------------------
// Pure helpers for MERGING synced items (Canvas, Gmail, Discord) into the store.
// "Pure" means they don't touch the screen or the network — data in, data out.
//
// This tiny wrapper lets the SAME file be used two ways:
//   - in the widget window as `Sync` (loaded by a <script> tag)
//   - in Node.js tests via require('./src/sync.js')
// ---------------------------------------------------------------------------
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sync = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // A simple unique id.
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Fields we copy from a synced item onto a stored event / to-do.
  // ml* are the learned-filter fields: the trimmed training text, the 0..1
  // score, the class and the short reason. They travel with the event.
  const EVENT_FIELDS = ['title', 'start', 'time', 'endTime', 'course', 'location',
                        'description', 'url', 'sender', 'messageId', 'category', 'sourceQuote',
                        'mlText', 'mlScore', 'mlReason', 'mlClass'];
  const TODO_FIELDS = ['title', 'course', 'due', 'time', 'location'];

  // A synced item carries its date in `start`; a to-do stores that date in `due`.
  // Copy start -> due when the feed has no explicit due, so Canvas assignments
  // actually land in "Today" / "Next deadlines" (they only ever had start).
  function todoSource(it) {
    if (it.due !== undefined || it.start === undefined) return it;
    return { ...it, due: it.start };
  }

  // Your hand-edits to a synced item live in store.overrides[dedupeKey].
  // They are applied AFTER the feed is copied, so a re-sync can never erase them.
  function applyOverrides(store, key, target) {
    const ov = store.overrides && store.overrides[key];
    if (!ov) return;
    for (const k of Object.keys(ov)) {
      if (ov[k] === undefined) continue;
      // Only carry fields the target actually has (events use start, todos due).
      if (Object.prototype.hasOwnProperty.call(target, k) || k === 'location' || k === 'notes') {
        target[k] = ov[k];
      }
    }
  }

  // Merge `items` from a given `source` into store.events and store.todos.
  //
  // DEDUPE: key = "<source>:<uid>". Syncing the same item twice updates the
  // existing row instead of adding a duplicate.
  //
  // TOMBSTONES: if the existing row has status "dismissed" (you deleted it),
  // the item is SKIPPED — a re-sync can NEVER bring it back.
  //
  // PRESERVED on update: done, status, notes (your data beats the feed).
  function mergeItems(store, source, items, opts = {}) {
    const makeEvent = opts.makeEvent !== false;
    const makeTodo = opts.makeTodo !== false;
    const defaultStatus = opts.status || 'active';

    for (const it of items) {
      const key = source + ':' + it.uid;

      // If this item was dismissed anywhere, leave it alone entirely.
      const dismissed =
        store.events.some((e) => e.dedupeKey === key && e.status === 'dismissed') ||
        store.todos.some((t) => t.dedupeKey === key && t.status === 'dismissed');
      if (dismissed) continue;

      if (makeEvent) {
        const ev = store.events.find((e) => e.dedupeKey === key);
        if (ev) {
          for (const f of EVENT_FIELDS) if (it[f] !== undefined) ev[f] = it[f];
          applyOverrides(store, key, ev);
        } else {
          const fresh = {
            id: uid(), source, dedupeKey: key,
            status: it.status || defaultStatus,
            done: false, notes: ''
          };
          for (const f of EVENT_FIELDS) fresh[f] = it[f] !== undefined ? it[f] : '';
          applyOverrides(store, key, fresh);
          store.events.push(fresh);
        }
      }

      if (makeTodo) {
        const src = todoSource(it);
        const todo = store.todos.find((t) => t.dedupeKey === key);
        if (todo) {
          for (const f of TODO_FIELDS) if (src[f] !== undefined) todo[f] = src[f];
          applyOverrides(store, key, todo);
        } else {
          const fresh = {
            id: uid(), source, dedupeKey: key,
            status: src.status || defaultStatus,
            done: false, notes: ''
          };
          for (const f of TODO_FIELDS) fresh[f] = src[f] !== undefined ? src[f] : '';
          applyOverrides(store, key, fresh);
          store.todos.push(fresh);
        }
      }
    }
  }

  // Remove everything that came from a source (e.g. after "Disconnect").
  // Tombstoned items are removed for real here — disconnect is explicit.
  function removeSource(store, source) {
    store.events = store.events.filter((e) => e.source !== source);
    store.todos = store.todos.filter((t) => t.source !== source);
  }

  return { uid, mergeItems, removeSource };
});
