# Project: Electron schedule widget → hackathon build for CREAO (all 3 tracks)

You are enhancing an EXISTING Electron desktop schedule widget draft. Do not rewrite from scratch.

## Phase 0: Understand first (no code changes)
Read the whole repo. Summarize: file structure, how data flows (Canvas iCal, Gmail read-only, Discord bot), how the Pomodoro Focus tab shares the task list, where existing secrets/config live, and what is half-finished. Then show me a short plan and wait for my OK before changing anything.

## Existing features to PRESERVE (do not break)
- Calendar + to-do list fed by Canvas (iCal), Gmail (read-only), Discord (bot following announcement channels)
- De Anza and MESA emails included; voting/voter-registration emails excluded
- Separate Links section, location/room fields on events, recurring weekly events
- Assignments appear starting 2 days before due
- Pastel pink, cute, less rigid UI with my pixel-art planner icon
- Pomodoro Focus tab shares the widget's task list, tasks tickable, with the original tomato art/frame visuals

## Hackathon context
Rule: a CREAO agent does the core work. The app must RUN ON agent output, end to end (Track 1: remove the agent and the product stops working). I'm also targeting Track 2 (org chart of agents handing work to each other, one saved agent per role, coordinated by a scheduled workflow or an orchestrator via API Trigger) and Track 3 (agents help a team without replacing anyone; Slack/Teams/Notion connectors, scheduled runs, webhook handoffs). The pitch names all three tracks.

## CREAO integration
- Each CREAO agent has its OWN App ID and its OWN API key. There is no shared key. Store them in `.env` as CREAO_APP_ID_<ROLE> and CREAO_KEY_<ROLE> (ROLE = MAIL, ANALYST, PLANNER, DIGEST). Create `.env.example` with empty placeholders only, make sure `.env` is in `.gitignore`, and never print, log, or hardcode any key. Do not ask me to paste keys into the chat; I'll put them in `.env` myself.
- Existing agent: "Important Mail Scanner" (App ID 8d7890f4-07d7-46a7-a4dc-aaea471bd034). Inputs: lookback_hours (number), max_results (number). Output: structured JSON of ranked important emails + dates as calendar events.
- I have already created (or am creating) the other agents in CREAO by hand: Deadline & Task Analyst, Planner, Digest Writer. Each takes a single text input named "payload" containing a JSON object, and returns ONLY a JSON object. Build the schemas in `/schemas` to match the formats below, and also write `/agents/<name>.md` documenting each agent's role, exact input JSON, exact output JSON, and the instruction text, so it can be recreated in CREAO.
- Build one `creaoClient` module that triggers an agent by role and reads back its result. It looks up that role's App ID and key. If a role's key is missing, that agent falls back to mock data, and the Agent Team tab shows it as "mock" so I can see which agents are live.
- Do NOT guess endpoints, auth headers, or response/polling format. Ask me to paste the "View API docs" page first, then implement from it. Add `npm run test:creao`, which tests each configured agent one at a time and reports which ones work.
- Support `CREAO_MODE=live|mock` globally, plus per-agent fallback to mock when its key is empty. Mock returns realistic sample JSON from `/mock/*.json` so the app and demo work offline or if credits run out.
- Cost guards: cache results, don't re-run an agent when its input hash hasn't changed, cap runs per hour, and show a small "last run / next run" label.
- Validate every agent response against its schema; on failure show a friendly pastel error state and fall back to the last cached result. If an agent returns text around the JSON, extract the JSON object and validate that.

## Agent contracts
1. Mail Scanner: as above.
2. Deadline & Task Analyst
   - Input: {"tasks":[{id,title,due_date,course,description}], "important_emails":[{subject,summary,event_date}], "today": ISO date}
   - Output: {"tasks":[{id,title,due_date,priority_rank,urgency_reason,summary,deliverables[],effort_estimate_minutes,confidence("low"|"med"|"high"),source("canvas"|"email")}], "crunch_weeks":[{week_start,reason}]}
   - Rules: if a task has no description, summary = null and confidence = "low"; never invent details. Only re-summarize tasks that are new or changed (cache by task id + content hash).
   - Before building: inspect the Canvas iCal feed and tell me whether assignment descriptions are present. If not, propose how to fetch full text (Canvas API with a token in .env) and wait for my OK.
3. Planner
   - Input: {"ranked_tasks":[...Analyst output], "calendar":[{start,end,title}], "free_windows":[{start,end}], "estimate_history":[{task_id,estimated_minutes,actual_minutes}]}
   - Output: {"proposals":[{task_id,title,start,end,reason}], "adjustment_note": ""}
   - Rules: blocks sized from effort_estimate_minutes, adjusted by estimate_history; split long blocks (>50 min) into sessions with breaks; never overlap existing events or leave free_windows. The Planner only PROPOSES.
4. Digest Writer
   - Input: ranked tasks, crunch weeks, proposed study blocks.
   - Output: {"morning_brief": "", "team_digest": []} (brief max 5 sentences; team_digest 3-6 short bullet strings).

## Features to build (in this order, one commit per feature)
1. **Agent Team tab (Track 2):** a live org-chart view of the agents: Mail Scanner → Deadline & Task Analyst → Planner → Digest Writer. Each node shows status (idle/running/done/error/mock), last run time, and an arrow showing what it handed to the next agent. An orchestrator runs them in sequence on a schedule and manually via a "Run team" button, passing each agent's output as the next one's input.
2. **Approval inbox (Track 3):** agents only PROPOSE events/tasks/study blocks. Proposals land in a "Pending" list with approve/edit/reject; only approved items enter the calendar. Each proposal shows its agent-written summary in an expandable "what's this?" line and the reason it was proposed. Task rows in the widget also show the summary.
3. **Reality-check loop (differentiator):** the Pomodoro Focus tab logs actual time spent per task (local JSON/SQLite). The Planner receives estimated-vs-actual history and adjusts future block lengths. Show a small "your estimates are usually X% off" card.
4. **Team digest (Track 3, small version):** a weekly scheduled run posts the Digest Writer's team_digest to a Discord channel via the existing bot, with a webhook handoff when a task owner marks a task done. Keep it minimal and clearly separable. Ask me for the channel ID when needed.

## Engineering rules
- Keep main/renderer separation; use IPC with a preload script (contextIsolation on, nodeIntegration off).
- Cache agent results locally so the widget opens instantly and refreshes in the background.
- Never block the UI on an agent run; show a cute loading state in the pastel theme.
- Match the existing visual style; new UI should feel like the same app.
- Small, readable modules; comments only where the logic isn't obvious.
- After each feature: run the app, tell me how to test it, and list anything you couldn't verify.
- If a requirement is ambiguous or you need something from me (API docs, Discord channel ID, Canvas token), stop and ask instead of guessing.

## Demo readiness
At the end, add `DEMO.md` with a 2-minute demo script: agent team running → handoffs visible → approvals → Pomodoro feeding back into the Planner → Discord digest. Add a README section stating exactly how the app fails without the agents (for Track 1 judges), and a one-line note on how each of the three tracks is satisfied.