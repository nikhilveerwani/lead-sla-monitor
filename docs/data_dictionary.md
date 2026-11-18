# Data dictionary

## Inputs (Google Sheet tabs in the template; synthetic CSVs in the demo)

### `Leads`: one row per lead

| Column | Type | Meaning |
|---|---|---|
| `lead_id` | text | Unique lead ID |
| `created_at` | date-time | When the lead was created. Starts the 24-hour clock |
| `owner` | text | Rep the lead is assigned to |
| `team` | text | Owner's team |
| `source` | text | Acquisition source (reporting only) |

### `Calls`: one row per call attempt

| Column | Type | Meaning |
|---|---|---|
| `lead_id` | text | Lead called |
| `called_at` | date-time | Dial time. **Calls before `created_at` are ignored** (earlier registration of the same person) |
| `rep` | text | Who dialled |
| `duration_sec` | integer | Talk time; 0 = no answer. Not used by the SLA (attempts count) |

### `reasons.csv` / Breached tab `Reason`, `Comment`

The team's explanation for a breach, chosen from a fixed list. It is kept across refreshes in the hidden `_reasons` tab, keyed by lead ID.

## Statuses (per lead)

| Status | Rule |
|---|---|
| **On time** | First call at or before created + 24h |
| **Late** | First call after the deadline |
| **Not called** | Deadline passed, no call |
| **Running** | Inside the 24h window, no call yet. Excluded from SLA % |

## Periods (lead creation date, IST)

| Period | Range |
|---|---|
| D-1 | Yesterday |
| WTD | Monday to yesterday (on Mondays: the previous full week) |
| MTD | 1st of the month to yesterday |

## Metrics and statistics

| Metric | Definition |
|---|---|
| **SLA %** | On time ÷ (On time + Late + Not called) |
| **Hours to first call** | First call − created, for called leads |
| **Overdue** | Not called, created in the last 7 days |
| **At risk** | Running, deadline within 6 hours |
| **Saturday gap** | Two-proportion z-test, Saturday vs Monday–Thursday leads over the last 30 complete days, with a 95% interval on the difference |
| **Rep "below avg"** | Upper end of the rep's 95% Wilson interval below the team's MTD SLA |
| **Leads rescued** | Saturday leads per month × (weekday on-time rate − Saturday on-time rate) |
