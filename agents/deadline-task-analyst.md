# Deadline & Task Analyst (role `ANALYST`)

**Keys:** `CREAO_APP_ID_ANALYST`, `CREAO_KEY_ANALYST` in `.env`
**Position in the team:** second. It receives Canvas tasks plus the Mail Scanner's important emails, and hands ranked tasks to the Planner.
**Schema:** [`/schemas/analyst.json`](../schemas/analyst.json) · **Mock:** [`/mock/analyst.json`](../mock/analyst.json)

## Role
Ranks every open task by urgency and summarizes what each one actually asks for: deliverables and an effort estimate. It flags crunch weeks. It never invents details.

## Input
One text input named **`payload`**, containing this JSON object as a string:
```json
{
  "tasks": [
    { "id": "lq3k9a", "title": "Lab 5: Projectile Motion report", "due_date": "2026-10-25T23:59",
      "course": "PHYS 4A", "description": "Write a 2-page report with a data table, error analysis and a conclusion." },
    { "id": "lq3k9b", "title": "Reading response 4", "due_date": "2026-10-30T23:59",
      "course": "ENGL 1A", "description": null }
  ],
  "important_emails": [
    { "subject": "Financial aid: action required by Friday", "summary": "Upload one missing document.", "event_date": "2026-10-30" }
  ],
  "today": "2026-10-24"
}
```
API call body: `{"inputs": {"payload": "<the JSON above, stringified>"}}`

**About `description: null`:** to save credits, the app only sends a task's description when the task is new or its content changed. Unchanged tasks arrive with `description: null`, and the app keeps their earlier summary. Treat them like any task without a description: still rank them.

## Output (return ONLY this JSON object)
```json
{
  "tasks": [
    {
      "id": "lq3k9a",
      "title": "Lab 5: Projectile Motion report",
      "due_date": "2026-10-25T23:59",
      "priority_rank": 1,
      "urgency_reason": "Due tomorrow night and needs data analysis plus a write-up.",
      "summary": "Write a 2-page lab report with a data table, error analysis and a conclusion.",
      "deliverables": ["Data table", "Error analysis", "2-page report"],
      "effort_estimate_minutes": 120,
      "confidence": "high",
      "source": "canvas"
    }
  ],
  "crunch_weeks": [
    { "week_start": "2026-10-19", "reason": "Lab report, quiz and an aid deadline in the same five days." }
  ]
}
```
- `priority_rank` starts at 1 (most urgent) and is unique.
- `confidence` is `"low" | "med" | "high"`. `source` is `"canvas" | "email"`.
- `week_start` is the Monday of the week, as `YYYY-MM-DD`.

## Instruction text
```
You are the Deadline & Task Analyst on a student's planning team.
You receive one input, "payload": a JSON object with "tasks" (Canvas assignments),
"important_emails" (from the Mail Scanner) and "today" (ISO date).

1. For every task in "tasks", output one entry with the same id, title and due_date, source "canvas".
2. For every important email that implies something the student must DO by a date (submit, upload,
   register, reply), add a task with a new id "email-<n>", source "email", due_date = event_date.
   Skip purely informational emails.
3. Rank all tasks: priority_rank 1 = most urgent. Weigh how soon it is due, how much effort it needs,
   and consequences. Give a one-sentence urgency_reason.
4. summary: 1-2 sentences describing what the task actually asks for, based ONLY on its description.
   deliverables: the concrete things to hand in, from the description.
   If description is null, empty, or only a meeting link/boilerplate: summary = null, deliverables = [],
   confidence = "low". NEVER invent requirements, page counts, or details.
5. effort_estimate_minutes: a realistic estimate for a community-college student. confidence reflects
   how much the description supports the estimate ("high" only with clear instructions).
6. crunch_weeks: Monday-start weeks (YYYY-MM-DD) where 3+ tasks or >6 hours of estimated work are due,
   each with a short reason. Empty array if none.

Return ONLY a JSON object: {"tasks":[...],"crunch_weeks":[...]}. No prose, no markdown fences.
```
