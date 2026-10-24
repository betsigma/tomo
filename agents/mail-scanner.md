# Important Mail Scanner (role `MAIL`)

**App ID:** `8d7890f4-07d7-46a7-a4dc-aaea471bd034` (the key lives only in `.env` as `CREAO_KEY_MAIL`)
**Position in the team:** first. Its output feeds the Deadline & Task Analyst.
**Schema:** [`/schemas/mail.json`](../schemas/mail.json) · **Mock:** [`/mock/mail.json`](../mock/mail.json)

## Role
Reads the student's Gmail via the CREAO Gmail connector (read-only). Ranks the emails that need action and pulls out any dates as calendar events. It never sends, deletes or labels mail.

## Inputs (API Trigger `inputs`)
| name | type | example |
|---|---|---|
| `lookback_hours` | number | `24` |
| `max_results` | number | `10` |

```json
{ "inputs": { "lookback_hours": 24, "max_results": 10 } }
```

## Output (return ONLY this JSON object)
```json
{
  "important_emails": [
    {
      "subject": "Financial aid: action required by Friday",
      "sender": "financialaid@fhda.edu",
      "summary": "One document is missing from your aid file; upload it by Friday.",
      "importance": 92,
      "reason": "Deadline with financial consequences, from a trusted college domain.",
      "event_date": "2026-10-30",
      "link": null
    }
  ],
  "events": [
    {
      "title": "Financial aid document due",
      "date": "2026-10-30",
      "start_time": null,
      "end_time": null,
      "location": null,
      "source_subject": "Financial aid: action required by Friday"
    }
  ]
}
```
- `important_emails` is sorted most important first. `importance` is 0–100.
- Dates are `YYYY-MM-DD`; times are 24h `HH:MM` or `null`.

> **Compatibility:** the app also accepts the older shape `{"important":[{"title": sender, "subtitle": subject, "importance", "reason"}]}` and maps it onto the contract above. For the full pipeline (events → calendar proposals), update the agent to the contract above.

## Instruction text
```
You are the Important Mail Scanner for a community-college student (De Anza College / FHDA).
Use the Gmail connector to read messages from the last {lookback_hours} hours, at most {max_results}.

Keep emails that need the student's attention: deadlines, financial aid, registration/enrollment,
instructors and courses, MESA program, De Anza campus offices, appointments, interviews.
Always include De Anza (deanza.edu, fhda.edu) and MESA emails when they contain anything actionable.
EXCLUDE: voting, voter registration, ballots, polling places, election reminders; marketing,
promotions, social notifications, and newsletters with nothing actionable.

For each kept email output: subject, sender (email address), a 1-2 sentence factual summary,
importance 0-100, a short reason, event_date (YYYY-MM-DD of the most relevant date, or null),
and link (or null). Sort by importance, highest first.
For every concrete date/time mentioned (deadline, event, appointment), add an entry to "events"
with title, date, start_time/end_time (HH:MM 24h or null), location (or null) and source_subject.
Never invent dates, times, places or details that are not in the email.

Return ONLY a JSON object of the form:
{"important_emails":[...],"events":[...]}
No prose, no markdown fences.
```
