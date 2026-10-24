# Digest Writer (role `DIGEST`)

**Keys:** `CREAO_APP_ID_DIGEST`, `CREAO_KEY_DIGEST` in `.env`
**Position in the team:** last. It receives the Analyst's ranked tasks and crunch weeks plus the Planner's proposed blocks. Its `team_digest` is posted to Discord.
**Schema:** [`/schemas/digest.json`](../schemas/digest.json) · **Mock:** [`/mock/digest.json`](../mock/digest.json)

## Role
Writes a short morning brief for the student and a few bullets for a study group or team channel.

## Input
One text input named **`payload`**, containing this JSON object as a string:
```json
{
  "ranked_tasks": [
    { "id": "lq3k9a", "title": "Lab 5: Projectile Motion report", "due_date": "2026-10-25T23:59",
      "priority_rank": 1, "urgency_reason": "Due tomorrow night.", "summary": "Write a 2-page lab report...",
      "deliverables": ["2-page report"], "effort_estimate_minutes": 120, "confidence": "high", "source": "canvas" }
  ],
  "crunch_weeks": [ { "week_start": "2026-10-19", "reason": "Three deadlines in five days." } ],
  "proposed_blocks": [
    { "task_id": "lq3k9a", "title": "Lab 5 report: data + error analysis",
      "start": "2026-10-24T16:00", "end": "2026-10-24T16:50", "reason": "Highest priority." }
  ]
}
```
API call body: `{"inputs": {"payload": "<the JSON above, stringified>"}}`

## Output (return ONLY this JSON object)
```json
{
  "morning_brief": "Today's top priority is the Lab 5 report, due tomorrow night. Two focus blocks are proposed this afternoon.",
  "team_digest": [
    "Lab 5 report due tomorrow 11:59 PM.",
    "Quiz 6 opens in two days.",
    "Crunch week: three deadlines in the next five days."
  ]
}
```
- `morning_brief`: at most 5 sentences.
- `team_digest`: 3–6 short bullet strings, each under 200 characters, without leading "-" or "•".

## Instruction text
```
You are the Digest Writer on a student's planning team.
You receive one input, "payload": a JSON object with "ranked_tasks", "crunch_weeks" and "proposed_blocks".

morning_brief: a warm, encouraging, plain-language brief of AT MOST 5 sentences for the student:
the top 1-3 priorities, when the proposed blocks are, and any crunch week. Mention only facts from the input.

team_digest: 3 to 6 short bullet strings (each under 200 characters, no leading "-" or "•") suitable
for posting in a study-group channel: upcoming deadlines with dates, crunch weeks, and one line of
encouragement at most. No private details beyond task titles and due dates.

Return ONLY a JSON object: {"morning_brief":"...","team_digest":["...", "..."]}. No prose, no markdown fences.
```
