# Set up the Google Sheets template (about 10 minutes)

You need a Google account and, for the digest, a Slack workspace where you can add an incoming webhook.

## 1. Prepare the sheet

Create a Google Sheet with two tabs. The header row must match exactly:

| Tab | Columns |
|---|---|
| `Leads` | `lead_id`, `created_at`, `owner`, `team`, `source` |
| `Calls` | `lead_id`, `called_at`, `rep`, `duration_sec` |

`created_at` and `called_at` can be real date-time cells or ISO text such as `2026-11-17T18:42:10+05:30`.

To try it first, import `sample/leads.csv` and `sample/calls.csv` from this folder (*File → Import → Insert new sheet*), then rename the tabs to `Leads` and `Calls`.

In practice these tabs are fed by a CRM export, a connected-sheets query from your warehouse, or a scheduled import.

## 2. Add the code

1. *Extensions → Apps Script*.
2. Rename the default `Code.gs` content: paste in [`Code.gs`](Code.gs).
3. *+ → Script*, name it `sla_core`, and paste in [`sla_core.js`](sla_core.js) unchanged.
4. *Project settings*: tick **Show "appsscript.json"** and replace it with [`appsscript.json`](appsscript.json). This sets the timezone to Asia/Kolkata. Change it to yours, and change `TZ_OFFSET_MIN` in `Code.gs` to match.
5. Save, then reload the spreadsheet. A **Lead SLA** menu appears.

## 3. Run it

1. **Lead SLA → Refresh now.** Approve the permissions the first time. You get two tabs:
   - `SLA summary`: yesterday, week to date and month to date, by team.
   - `Breached leads`: every late or missed lead, with a **Reason** dropdown and a **Comment** column for the team.
2. **Lead SLA → Set Slack webhook.** Paste a Slack incoming-webhook URL ([how to create one](https://api.slack.com/messaging/webhooks)).
3. **Lead SLA → Refresh and post to Slack** to test the message.
4. **Lead SLA → Install schedule.** The digest then posts at 10:00, 14:00 and 19:00, Monday to Saturday.

## Things worth knowing

- **Reasons are never lost.** The `Breached leads` tab is rebuilt on every run, but entries are stored by lead ID in a hidden `_reasons` tab and written back. Editing a Reason or Comment stamps who changed it and when.
- **Change the rules in one place.** SLA hours, run times and the reason list are in `CFG` at the top of `Code.gs`. The SLA logic itself is in `sla_core`, the same file the unit tests run against.
- **Apps Script limits:** a run must finish within 6 minutes. That is comfortably enough for tens of thousands of leads. Beyond that, compute the statuses in your warehouse and keep the sheet for the digest and the reasons.
