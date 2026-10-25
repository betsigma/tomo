# Tomo

Electron desktop schedule. Canvas, Gmail, Discord, and a Pomodoro Focus tab stay in the app. The important-email list, study blocks, summaries, Discord meeting dates, and morning brief come from a team of four CREAO agents.

```bash
npm install
npm start
npm test
```

Copy `.env.example` to `.env` and fill in the per-role CREAO values yourself. Do not paste keys into chat.

## The agent team (four agents)

| Agent | Input | Output | What disappears without it |
|---|---|---|---|
| Important Mail Scanner (`MAIL`) | `lookback_hours`, `max_results` | ranked important emails + dates found in them | the Important emails list and every event found in email |
| Deadline & Task Analyst (`ANALYST`) | Canvas tasks, the Mail Scanner's emails, recent Discord announcements | ranked tasks with summaries, parts and effort, crunch weeks, meeting dates from Discord | task order, summaries, parts, crunch weeks, and every Discord date |
| Planner (`PLANNER`) | ranked tasks, calendar busy times (no titles), free windows, estimate history | proposed study blocks | study-block suggestions |
| Digest Writer (`DIGEST`) | ranked tasks, crunch weeks, proposed blocks | morning brief + team digest bullets | the morning brief and the team digest |

The orchestrator runs them in that order on a schedule and from **Run team** on the Team tab, passing each one's output to the next. Contracts and instruction text: `/agents/*.md`. Schemas: `/schemas`. Mock replies: `/mock`.

## What happens without the agents

In live mode the product depends on the CREAO agents. Remove the agent, or let it fail, and these pieces stop:

- The Important emails list. It does not fall back to the widget's own Gmail sync. The list shows **Mail Scanner offline**.
- Email-derived calendar events from that local Gmail sync. They are hidden. New email dates appear only if the Mail Scanner proposes them and you approve them.
- Task priority order, Analyst summaries, parts, and effort estimates. The task list goes back to plain Canvas order, with no summaries.
- Discord meeting dates. Discord messages are still listed, but no date reaches the calendar: there is no local date parser.
- The Events section of the Inbox, and with it the RSVP polls (events only come from agent output).
- Study-block proposals. Pending stays empty.
- The morning brief and the team digest.

Canvas events and to-dos, the Links section, recurring events, the Focus tab, and shared-task posts keep working. Gemini is hard-disabled in live mode, so no email content is sent to Google. The saved Gemini key and the local Gmail code remain in the repo, behind a restore switch that does not run while live.

Mock mode (`CREAO_MODE=mock`) fills the app from sample agent output for an offline demo, and the screen is labeled **mock**. Discord posts in mock mode are only shown, never sent, and polls get fake votes labeled **(mock)**.

## How each track is met

- **Track 1:** the app runs on agent output end to end; without the agents, the pieces listed above stop.
- **Track 2:** four saved agents, one per role, hand work to each other (Mail Scanner → Analyst → Planner → Digest Writer), coordinated by a scheduled orchestrator and the Run team button, shown live on the Team tab.
- **Track 3:** agents only propose and you decide (approval inbox); the team hears about it through Discord: RSVP polls for events the agents found, a "finished" post for shared tasks, and the team digest, all behind a preview.

## Discord posting

Every post goes through one function. Posting is **off by default** (Settings → Posting to Discord). Each post shows a preview with **Posting to #channel** before anything is sent. Posts carry titles, times and places only: no `[course codes]`, grades, links, emails, or Analyst summaries. Votes are read only when you press **Check RSVPs**; nothing polls in the background.

## Setup for Discord permissions

In the Discord Developer Portal → your app → **Bot**:

- **Message Content Intent**: on (Tomo reads announcement text). No other intent is used; Tomo talks to Discord over REST only.

When inviting the bot (OAuth2 → URL Generator, scope `bot`), or in the channel's permissions:

| Permission | Why |
|---|---|
| View Channels | see the channel Tomo reads and the one it posts to |
| Read Message History | read announcements and read poll results |
| Send Messages | post RSVP polls, finished-task posts, the digest |
| Send Polls | native Discord polls |
| Add Reactions | only for the fallback: if Send Polls is missing, Tomo posts numbered options and adds 1️⃣ 2️⃣ 3️⃣ |

Set **Post to channel ID** in Settings to a test channel first, so a test poll never lands in a real club channel.
