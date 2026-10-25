# HANDOFF — schedule-widget (CREAO hackathon build)

Read this, then `CLAUDE.md`, before touching anything. `CLAUDE.md` is the project brief and its rules override defaults. This file records the state of the work as of **2026-10-25**.

---

## 0. Rules (non-negotiable)

1. **Don't break existing features.** The list is in `CLAUDE.md` → "Existing features to PRESERVE": Canvas/Gmail/Discord feeds, De Anza + MESA emails kept, voting emails excluded, Links section, location fields, recurring weekly events, assignments shown 2 days before due, pastel pink UI with the pixel-art icon, Pomodoro Focus tab sharing the task list with the original tomato visuals. Run `npm test` before every commit.
2. **Never log, print, return, or hardcode keys.** CREAO keys live only in `.env` (gitignored) as `CREAO_APP_ID_<ROLE>` / `CREAO_KEY_<ROLE>`. Other secrets (Gmail OAuth, Discord bot token, Canvas feed URL, Gemini key) are encrypted with Electron `safeStorage` in `data/secrets.json` (gitignored). Don't read or print their values. Log counts, hosts and run IDs only. Don't ask the user to paste keys into chat.
3. **Keep `contextIsolation: true` and `nodeIntegration: false`.** The renderer reaches main only through `preload.js` → `window.widgetAPI` (IPC). Never expose secrets or Node APIs to the renderer.
4. **Don't guess CREAO API details.** Everything implemented comes from https://docs.creao.ai/pro/api-trigger (summarized in §5). If something isn't documented, ask the user.
5. One commit per feature. After each feature: run the app, tell the user how to test it, and list what you couldn't verify. Ask the user when something is ambiguous (Discord channel ID, tokens, etc.).
6. Match the existing style: small modules, comments only where the logic isn't obvious, pastel UI.

---

## 1. Architecture

Electron app, plain JS with no bundler or framework. FullCalendar is vendored.

```
 ┌──────────────── main process (Node) ─────────────────┐        ┌──── renderer (browser, isolated) ────┐
 │ main.js  window, IPC handlers, secrets, Gmail OAuth, │  IPC   │ src/index.html  markup for all views  │
 │          Discord REST, store.json read/write         │◄──────►│ src/renderer.js global `store`, UI,   │
 │ canvas.js gmail.js discord.js textdate.js titles.js  │preload │                 sync, calendar, panels│
 │ llm.js (Gemini, optional) ml.js (on-device MiniLM)   │  .js   │ src/sync.js     merge/dedupe (UMD)    │
 │ env.js creaoClient.js schemaCheck.js                 │        │ src/recur.js    recurrence (UMD)      │
 │ orchestrator.js teamInputs.js inbox.js                │        │ src/focus/      Pomodoro (tomato)     │
 └──────────────────────────────────────────────────────┘        └───────────────────────────────────────┘
```

**Store ownership (important):** the **renderer owns `data/store.json`**. It keeps the whole store in memory and saves the whole object through `store-save`. If main writes `store.json` while the renderer is open, the next renderer save overwrites that write. So main-side agent results go to **separate files** (`data/agent-team.json`, `data/creao-cache.json`), and only renderer actions (for example approving a proposal) write into the store.

## 2. File map

| Path | Purpose |
|---|---|
| `main.js` | Window (frameless, 380×560 compact / 820×660 expanded, links, focus / 440×720 team), all `ipcMain` handlers, safeStorage secrets, Gmail read-only OAuth loopback, Discord REST reads, excluded-email log. Loads `.env` near the top and logs only `CREAO_MODE` plus which roles have keys. |
| `preload.js` | `contextBridge` → `window.widgetAPI` (store, window, canvas*, gmail*, llm*, ml*, discord*, teamState, teamRun, onTeamUpdate). |
| `canvas.js` | Parses the iCal feed with node-ical. Skips recurring events (class meetings). `description` is cut to 4,000 characters. |
| `gmail.js` | Gmail query builder, filter rules, trust allowlist, **exclusion keywords**, newsletter date parsing, and the `fetchPreview` pipeline (metadata → full body → optional AI → optional ML). |
| `discord.js`, `textdate.js`, `titles.js` | Discord message normalizing (dates come from the Analyst), date formatting, HTML/title cleanup. |
| `llm.js`, `ml.js` | Optional Gemini email extraction; on-device relevance classifier (model cached in `data/models`). Both pre-date CREAO. |
| `env.js` | No-dependency `.env` loader. Doesn't override existing env vars or print values. |
| `creaoClient.js` | **CREAO client by role** (§5). |
| `schemaCheck.js` | Small JSON-Schema subset validator used on every agent reply. |
| `schemas/*.json` | Output schema per role: `mail`, `analyst`, `planner`, `digest`. |
| `mock/*.json` | Realistic mock output per role. `{{day+N}}` / `{{week+N}}` tokens resolve to current dates. |
| `agents/*.md` | Per agent: role, exact input/output JSON, and instruction text to paste into CREAO. |
| `orchestrator.js` | Wired. Runs MAIL → ANALYST → PLANNER → DIGEST, records handoffs, schedules runs, persists `data/agent-team.json`. A failed agent stops the chain. |
| `teamInputs.js` | Pure helpers: Analyst input (not-done tasks from 3 days overdue through 14 days ahead, cap 30), summary cache merge, calendar/free-window builder, proposal rule check. |
| `inbox.js` | Pure approval inbox (UMD). Approve writes one `source:'agent'` event. Reject writes a dismissed tombstone with the same `dedupeKey`. |
| `scripts/test-creao.js` | `npm run test:creao`: live test of each configured agent. `--only MAIL,DIGEST` or `--role=ANALYST`. |
| `test-features.js` | `npm test`: plain-Node checks (65 passing). |
| `debug-canvas.js` | Standalone Canvas feed debugger (prints the host only). |
| `src/renderer.js` | ~2,300 lines. Sections: helpers → load/save → to-do list → emails/discord → links → ML → calendar → modals → panels → settings → sync → view/theme → wiring. |
| `src/focus/focus.js` | Embedded Pomodoro. Reads the global `store`/`activeTodos()`. A finished work session adds 1 to `task.pomodoros`. |
| `data/` (gitignored) | `store.json`, `secrets.json` (encrypted), backups, models; later `creao-cache.json`, `agent-team.json`, `excluded-emails.log`, `creao-last-test.json`. |

## 3. Data flow

- **Canvas:** The feed URL is stored encrypted. `canvas-sync` → `normalizeCalendar` → renderer `Sync.mergeItems(store,'canvas',items)` creates an **event and a to-do** that share a `dedupeKey` (`canvas:<uid>`). The to-do's `due` is copied from `start`. User edits live in `store.overrides[dedupeKey]` and survive re-syncs. Deleting an item marks it `status:'dismissed'` (a tombstone), so a sync never brings it back. `settings.deadlineWindowDays` (default 2) controls "Next deadlines".
- **Gmail** (local, read-only OAuth): `gmail-fetch` → `fetchPreview`. Screening order: blocked sender → **exclusion keyword** (subject + first 600 characters of the body, applies even to trusted senders) → Promotions/Social/List-Unsubscribe for untrusted senders → domain/name/sender/keyword rules. Only *new* message IDs are screened (the renderer sends back a cache). Excluded emails are appended to `data/excluded-emails.log` (subject and sender only).
- **Discord:** bot token plus one channel ID (encrypted). Main polls `GET /channels/{id}/messages`. Dated messages become events. **Nothing posts to Discord yet.**
- **Focus:** shares `store.todos`. It counts pomodoros only and **does not log minutes yet** (Feature 3 needs that).
- **CREAO:** orchestrator in main → `creaoClient.run(role, input)` → results in `data/agent-team.json` → `team-update` IPC. The renderer draws the org chart, morning brief, and Pending list. Approving a proposal writes into the store. Gemini is not called while the Mail Scanner's mode is `live`. The local Gmail list path still runs.

## 4. Done vs. unfinished

Commits on `master`:
```
20af320 Add approval inbox so agent proposals stay off the calendar
4caf3ba Add Agent Team tab wired to the CREAO orchestrator
e87d075 creaoClient: read JSON from run artifacts; test:creao saves run ids and --recheck
f1d76c4 CREAO foundation: per-role client, schemas, mocks, agent docs, test:creao
1104ebd Exclude voting emails by keyword; keep longer Canvas descriptions
f65699e Baseline: existing schedule widget draft
```

**Done**
- Voting-email keyword exclusion (editable in Settings → Email filters → "Exclude keywords"; default `voter registration, register to vote, ballot, polling place, election day`) plus the review log.
- Canvas descriptions up to ~4,000 characters. **No Canvas API token**, by user decision. Revisit only if descriptions turn out empty or link-only.
- CREAO foundation: client, schemas, mocks, agent docs, `.env.example`, `test:creao`, artifact reading. `test:creao --only MAIL,DIGEST` limits a paid run.
- **Agent Team tab (Track 2):** sparkle button, org chart, Run team (`force: true`), 3-hour schedule (cache on). Analyst input is not-done tasks from 3 days overdue through 14 days ahead, cap 30, shown as `sent X of Y`. Morning brief at the top of the schedule views. Task rows show the Analyst summary by to-do id.
- **Approval inbox (Track 3, small):** Pending has what's this? / Approve / Edit / Reject. Approve writes one `source:'agent'` event. Reject writes a dismissed tombstone. A later run does not bring either back. Canvas tasks are not proposed again.

**Unfinished, in the order `CLAUDE.md` requires**
1. **Reality-check loop:** Focus logs actual minutes per task (`data/time-log.json` via IPC). Feed `estimate_history` through the orchestrator's `getEstimateHistory`. Add an "estimates are usually X% off" card.
2. **Team digest (Track 3, small):** weekly scheduled post of `team_digest` to Discord through the existing bot (needs a POST helper; **ask the user for the channel ID**), plus a webhook handoff when a task is marked done.
3. `DEMO.md` (2-minute script), a README section on how the app fails without agents (Track 1), and one line per track.

## 5. CREAO integration

**API (App-scoped API Trigger, one `capi_` key per agent):**
```
POST https://agent.creao.ai/api/v1/apps/{appId}/runs        Authorization: Bearer <key>
     body {"inputs": {...}}  →  {id, status:"pending", appId, appName}
GET  https://agent.creao.ai/api/v1/apps/{appId}/runs/{runId}  →  poll until completed|failed|cancelled
GET  https://agent.creao.ai/api/v1/runs/{runId}/artifacts/download?artifactId=…  →  302 to storage (≤1h)
```
The completed-run shape was **verified live**: `{id, status, threadId, result:{text, chatText, artifacts?:[{id,url,type,title}]}, errorCode, startedAt, completedAt, createdAt}`. Webhooks aren't used because CREAO refuses localhost URLs.

**`creaoClient.createClient({rootDir, dataDir, env, fetch, now, log})`**
- `run(role, input, {force, onStatus})` never throws. It returns `{ok, output, source:'live'|'mock'|'cache', mode, cached, stale, error, at, runId}`.
- Mode: `CREAO_MODE=mock`, or a missing App ID/key for that role, gives `mock` (reads `/mock/<role>.json`).
- Inputs: MAIL sends `{lookback_hours, max_results}` (numbers). The other roles send `{payload: JSON.stringify(input)}`.
- JSON lookup order: `result.text` → `result.chatText` → artifacts (JSON-typed first, up to 3). The storage redirect is fetched **without** the Authorization header. JSON wrapped in prose or fences is extracted, normalized (MAIL accepts the legacy `{important:[{title,subtitle,importance,reason}]}`), then validated against `/schemas`.
- Cost guards: cache keyed by a hash of role + mode + input (an unchanged input never re-runs); MAIL also has a 60-minute TTL; `CREAO_MAX_RUNS_PER_HOUR` (default 4) per role; `CREAO_POLL_MS` (3000); `CREAO_TIMEOUT_MS` (180000).
- On failure it returns the last good cached output (`stale:true`). With no cache, it returns the mock output.
- `status()` reports per role `{configured, mode, lastRunAt, lastSource, lastError, runsLastHour}` and never includes IDs or keys.
- Cache file: `data/creao-cache.json`.

**Contracts** (full detail, examples and instruction text in `agents/*.md`; schemas in `schemas/*.json`):
| Role | Input | Output |
|---|---|---|
| MAIL: Important Mail Scanner, App ID `8d7890f4-07d7-46a7-a4dc-aaea471bd034` | `lookback_hours`, `max_results` | `{important_emails:[{subject,sender,summary,importance 0-100,reason,event_date|null,link?}], events:[{title,date,start_time?,end_time?,location?,source_subject}]}` |
| ANALYST: Deadline & Task Analyst | `payload` = `{tasks:[{id,title,due_date,course,description}], important_emails:[{subject,summary,event_date}], today}` | `{tasks:[{id,title,due_date,priority_rank,urgency_reason,summary|null,deliverables[],effort_estimate_minutes,confidence low|med|high,source canvas|email}], crunch_weeks:[{week_start,reason}]}` |
| PLANNER | `payload` = `{ranked_tasks, calendar:[{start,end,title}], free_windows:[{start,end}], estimate_history:[{task_id,estimated_minutes,actual_minutes}]}` | `{proposals:[{task_id,title,start,end,reason}], adjustment_note}` (blocks ≤50 minutes with breaks, inside free windows, no overlaps; proposals only) |
| DIGEST: Digest Writer | `payload` = `{ranked_tasks, crunch_weeks, proposed_blocks}` | `{morning_brief (≤5 sentences), team_digest: 3-6 strings}` |

Analyst rules: a task with no useful description gets `summary:null` and `confidence:"low"`, and nothing is invented. **Only new or changed tasks carry their description.** Unchanged tasks are sent with `description:null`, and `teamInputs.mergeAnalyst` restores their cached summary (cache keyed by task id + content hash, stored in `agent-team.json → analystCache`).

**Live vs. mock right now:**
- `.env` has App ID and key slots filled for **all four roles**. Key *presence* was confirmed by successful authenticated runs; values were never read.
- `.env` was switched to **`CREAO_MODE=live`**. A missing key for one role still mocks that role only. `test:creao` always tests configured agents live, whatever the mode.
- Last live test (2026-10-25): all four runs **completed and validated**. `result.text` is still a summary, not the contract. The JSON artifact is what validates. The client already prefers a valid artifact.

## 6. Run and test

```bash
npm install
npm start                    # electron .   (logs from the renderer are forwarded to the terminal)
npm test                     # node test-features.js — offline, must stay green (65 checks)
npm run test:creao           # live: one run per configured agent (spends CREAO credits)
npm run test:creao -- --only MAIL,DIGEST
npm run test:creao -- --role=ANALYST
npm run test:creao -- --recheck   # re-read the last test's runs, no credits
npm run debug:canvas         # Canvas feed debugger
```
- Copy `.env.example` to `.env` and fill it in (the user does this; never you).
- Offline CREAO tests use a fake `fetch` and temp data dirs, so they never touch the network.
- Platform: Windows 11, Node 24, Electron 33. Git commits in this repo use a local identity (`user.name ngtanphat2705`).

## 7. Known bugs, gaps and gotchas

- Live replies validate from the JSON artifact, not from `result.text`. If an artifact is missing or invalid, that role is an error and the chain stops.
- Known orchestrator limits:
  - `checkProposals` is skipped for mock output.
  - Planner `ranked_tasks` is capped at 12. Analyst input is not-done tasks from 3 days overdue through 14 days ahead, cap 30.
  - Study hours default to 09:00–21:00 via `store.settings.team.{dayStart,dayEnd}`, which has no Settings UI yet.
  - All-day events are treated as not busy.
  - The Analyst merge only runs for `live`/`cache` sources.
  - A scheduled run starts about 30 seconds after launch if the team has never run. That spends credits. Run team skips the hash cache; the schedule does not.
- `creaoClient.run` deduplicates in-flight calls **by role only**. A second call with a different input during a run gets the first call's result. That's fine for a sequential orchestrator; don't call it in parallel per role.
- `test:creao` calls `runLive` directly, so it **bypasses the cache and the hourly cap**. Each invocation costs credits.
- Stored Canvas descriptions in the existing `store.json` are still capped at 500 characters until the next Canvas sync. Data check: 108 Canvas events, 24 with empty descriptions, ~30 boilerplate ("Click here to join Zoom Meeting…", "upload your work here…"). `teamInputs.usefulDescription` sends those as `null`.
- The exclusion keywords only apply to **newly fetched** Gmail messages. Voting emails that were already cached or accepted before this change stay until removed by hand. The orchestrator applies the same list to Mail Scanner output.
- The local Gmail list path still runs. Gemini is skipped while the Mail Scanner mode is `live`. The saved Gemini key is not deleted. Track 1 still needs a decision on how far the Mail Scanner replaces local ranking. **Don't remove existing Gmail features without asking.**
- The renderer saves the whole store (§1). Never write `store.json` from main while the window is open.
- `debug-canvas.js` duplicates `fetchText`/`hostOf` from `canvas.js` (harmless).
- Git warns about LF → CRLF on new files (harmless). The default branch is named `main`, but work is on `master` (the repo had no commits before this session).
- Fixed this session: saving Gmail filters used to drop `blockedSenders`/`cleanupDone` (`saveGmailFilters` now spreads the old object).

## 8. Open questions for the user

- Discord channel ID for the team digest (Feature 4).
- How far CREAO's Mail Scanner should replace the local Gmail ranking (Track 1 story). The client already reads a valid JSON artifact ahead of `result.text`.
