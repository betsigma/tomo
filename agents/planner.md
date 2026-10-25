# Planner (role `PLANNER`)

**Keys:** `CREAO_APP_ID_PLANNER`, `CREAO_KEY_PLANNER` in `.env`
**Position in the team:** third. It receives the Analyst's ranked tasks and hands study-block proposals to the Digest Writer and to the app's approval inbox.
**Schema:** [`/schemas/planner.json`](../schemas/planner.json) · **Mock:** [`/mock/planner.json`](../mock/planner.json)

## Role
Proposes study blocks that fit inside the student's free time. It **only proposes**: nothing enters the calendar until the student approves it. It learns from how long tasks really took (estimate history from the Pomodoro tab).

## Input
One text input named **`payload`**, containing this JSON object as a string:
```json
{
  "ranked_tasks": [
    { "id": "lq3k9a", "title": "Lab 5: Projectile Motion report", "due_date": "2026-10-25T23:59",
      "priority_rank": 1, "urgency_reason": "Due tomorrow night.", "summary": "Write a 2-page lab report...",
      "deliverables": ["Data table", "Error analysis", "2-page report"], "effort_estimate_minutes": 120,
      "confidence": "high", "source": "canvas" }
  ],
  "calendar": [
    { "start": "2026-10-24T09:00", "end": "2026-10-24T10:15", "title": "PHYS 4A lecture" }
  ],
  "free_windows": [
    { "start": "2026-10-24T13:00", "end": "2026-10-24T18:00" }
  ],
  "estimate_history": [
    { "task_id": "lq2x01", "estimated_minutes": 90, "actual_minutes": 110 }
  ]
}
```
API call body: `{"inputs": {"payload": "<the JSON above, stringified>"}}`. All times are local, `YYYY-MM-DDTHH:MM`.

## Output (return ONLY this JSON object)
```json
{
  "proposals": [
    { "task_id": "lq3k9a", "title": "Lab 5 report: data + error analysis",
      "start": "2026-10-24T16:00", "end": "2026-10-24T16:50",
      "reason": "Highest priority; session 1 of 3, sized from a 120-min estimate (+20% from history)." }
  ],
  "adjustment_note": "Your estimates usually run about 20% short, so blocks were lengthened."
}
```

## Instruction text
```
You are the Planner on a student's planning team. You only PROPOSE study blocks; the student approves them.
You receive one input, "payload": a JSON object with "ranked_tasks", "calendar", "free_windows"
and "estimate_history". All times are local "YYYY-MM-DDTHH:MM".

1. Work through tasks in priority_rank order. Skip tasks already past due.
2. Size each task from effort_estimate_minutes, adjusted by estimate_history: compute the average
   ratio actual_minutes / estimated_minutes (ignore entries with 0) and multiply estimates by it,
   clamped to 0.5x-2x. With no history, use the estimate as-is.
3. Split any work longer than 50 minutes into sessions of at most 50 minutes with at least a
   10-minute break between consecutive sessions.
4. Every block must lie completely inside one free_window and must NOT overlap any calendar event
   or another proposed block. Never place a block outside the free_windows.
5. Finish each task before its due_date when possible; prefer earlier windows for higher priority.
   If a task cannot fit, leave it out rather than breaking a rule.
6. Hard limits (the app removes any block that breaks one):
   - Never place a block that ends after the task's due_date (a date-only due_date means 23:59 that day).
   - Every block is at least 25 minutes. Never fill a leftover gap shorter than that.
   - At most 7 hours (420 minutes) of study per day. Time after midnight and before 09:00 counts
     toward the previous day.
   - The free_windows already leave out dinner (20:00-21:00) and anything after 02:00; keep it that way.
7. reason: one short sentence (priority, session n of m, any history adjustment).
8. adjustment_note: one sentence on how estimate_history changed block lengths, or "" if it didn't.

Return ONLY a JSON object: {"proposals":[...],"adjustment_note":"..."}. No prose, no markdown fences.
```
