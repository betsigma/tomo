# Schedule widget

Electron desktop schedule. Canvas, Gmail, Discord, and a Pomodoro Focus tab stay in the app. The important-email list, study blocks, summaries, and morning brief come from the CREAO agent team.

```bash
npm install
npm start
npm test
```

Copy `.env.example` to `.env` and fill in the per-role CREAO values yourself. Do not paste keys into chat.

## What happens without the agents

In live mode the product depends on the CREAO agents. Remove the agent, or let it fail, and these pieces stop:

- The Important emails list. It does not fall back to the widget's own Gmail sync. The list shows **Mail Scanner offline**.
- Email-derived calendar events from that local Gmail sync. They are hidden. New email dates appear only if the Mail Scanner proposes them and you approve them.
- Task priority order, Analyst summaries, and effort estimates. The task list goes back to plain Canvas order, with no summaries.
- Study-block proposals. Pending stays empty.
- The morning brief.

Canvas events and to-dos, the Links section, recurring events, and the Focus tab keep working. Gemini is hard-disabled in live mode, so no email content is sent to Google. The saved Gemini key and the local Gmail code remain in the repo, behind a restore switch that does not run while live.

Mock mode (`CREAO_MODE=mock`) still fills the app from sample agent output for an offline demo, and the screen is labeled **mock**.
