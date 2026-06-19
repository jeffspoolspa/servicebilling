# Sync Flow: ION to maintenance.visits

> Status: [active]
> Kind: [sync]
> Verification: [verified] — bulk sync traced against `f/ION/visits.flow` 2026-06-01; the
> authoritative EventID linker (`link_visits_via_log.flow`) + `tasks.ion_task_id` re-trace 2026-06-18
> Leader: ION Pool Care (visit records)
> Cache: [maintenance.visits](../../entities/visit.md) (+ chem_readings, consumables_usage, visit_tasks) — `[cache: ION + native]`

## What this keeps current

Mirrors ION's daily service-log visits into `maintenance.visits` and its per-visit detail tables. These visits are the operational record of what a tech actually did — and, per [monthly-maintenance-billing](../monthly-maintenance-billing/index.md), they are what ION bills from at month-end. Keeping this cache current is what makes the (proposed) visits-vs-invoice reconciliation possible.

## The sync — log-detail ingestion (the real pipeline)

> The original bulk `CompletedLogDetail` report flow (`f/ION/visits.flow` →
> `_discover/parse_normalize_test`, `source='ion'`) is **superseded** — the report carries no
> unique visit id or task id, so it was replaced by per-log ingestion. **All 54,404 visits are
> `external_source='ion_log'`; zero `'ion'` rows exist.** The components below live in Windmill;
> several are not mirrored to the repo.

The grain is the **`LogID`** (one ION service log = one visit; dedup on `ion_log_id`):

```mermaid
flowchart LR
    A["list_day_logs(date)<br/>customerLogDetails.cfm"] -->|"day's LogIDs + calendarID + customer + tech"| B["get_log_detail(LogID)<br/>addLog.cfm per log"]
    B -->|"EventID + CustomerID + times + readings + checklist + consumables + tech"| C["ingest_day_logs(start,end)"]
    C -->|"UPSERT on ion_log_id"| V[maintenance.visits]
    C -->|"DELETE+INSERT per visit"| VR[visit_readings]
    C -->|"DELETE+INSERT per visit"| VT[visit_tasks]
    C -->|"DELETE+INSERT per visit"| CU[consumables_usage]
    C -.->|"EventID not in DB -> unknown_event_ids"| R["recover_orphan_tasks<br/>create task + link"]
```

- **`f/ION/api/list_day_logs`** — `customerLogDetails.cfm?dayindex=…` → every service log for a date (LogID, calendarID, customer, service, tech, status). The by-**day** list (not per-customer).
- **`f/ION/api/get_log_detail`** — `addLog.cfm?LogID=…` → the per-log record: **EventID (task) + CustomerID + TaskInvoiceID + times + serviceable + readings + checklist + consumables(named) + tech + comment + failure_reason**. This is where event_id + customer_id come from.
- **`f/ION/ingest_day_logs(start, end, dry_run, sess, sb)`** — orchestrates the two above per day, keeps performed logs (`event_id` + `time_in`), and **UPSERTs the visit on `ion_log_id`** (+ refreshes `visit_readings` / `visit_tasks` / `consumables_usage` by delete-then-insert). `submitted_by` falls back to the day-grid tech; `actual_tech_id` resolved inline from `employees.ion_username`. Links `task_id` from existing `task_schedules.ion_task_id` only — **does not create missing tasks** (reports `unknown_event_ids`), which is the orphan gap.
- **`f/ION/recover_orphan_tasks`** — creates the task + schedules for any `unknown_event_ids` and links the visits ([ion-visit-task-backfill](../../operations/ion-visit-task-backfill.md)). Folding this in after `ingest_day_logs` makes the daily flow **self-healing** (no orphans).

**Historical runners** (over `ingest_day_logs`, chunked, idempotent on `ion_log_id`):
`_run/backfill_visits_year` (the 54k re-run), `_run/fill_gap_visits`, `_run/ingest_may_v*`.

> **Pending:** wire `ingest_day_logs(window) → recover_orphan_tasks()` onto a daily schedule as the
> standard sync, and retire the dead `CompletedLogDetail` flow.

## Anti-corruption transforms

Same shape as [ion-work-orders](ion-work-orders.md): column rename, currency/date coercion, empty-string-to-NULL. Visit tasks are normalized through the alias map in `_lib/normalize.py` (`TASK_ALIASES`, e.g. "Brsh" -> `brushed_pool`) and written to `maintenance.visit_tasks` via DELETE-then-INSERT per visit (so re-scraping a visit replaces its task set cleanly).

## Visit → task resolution (two passes; EventID is ground truth)

A visit's true task is the **ION EventID** = the `ion_task_id` recorded on its service log. Resolution
happens in two passes:

**Pass 1 — provisional, by service location (`_lib/upsert.py`).** The bulk Service Log report is
matched to a task by **`service_location_id`** (`build_resolvers` / `resolve_task_and_schedule`),
then a schedule slot by `day_of_week` + `actual_tech`. This is a best-effort first guess:
- **Multi-task locations are mis-resolved** — `tasks_by_sl[service_location_id]` keeps one task per
  location; locations with several active tasks (price / start date / service type) need a combined
  best-match (date window + day + tech + `price_cents` vs rate + service type). Price matches only
  ~59% (40% of visits are flat-rate). Ambiguous cases flag for review.

**Pass 2 — authoritative, by EventID via the log (`f/ION/link_visits_via_log.flow`).** Overrides
pass 1. Three steps: `taskless_visits` (find `task_id IS NULL` + an `ion_cust_id` hint) →
`resolve_visit_tasks_via_log` (loglist → LogID → **`addLog.cfm`** → the EventID; this is the only
place we fetch the log page directly) → `link_visits_by_event` (set `visits.task_id` to the task
whose **`task_schedules.ion_task_id = EventID`** — and equally `tasks.ion_task_id`, the now-populated
1:1 key, see [task-record-linkage](../../operations/task-record-linkage.md)). `sl_mismatch` is flagged
but the EventID link wins.

**The gap (`event_not_in_db`).** When a visit's EventID has **no task in our DB**, it can't link →
`task_id` stays NULL. This is the one-time 2026-04-26 task import never covering **expired** tasks: a
full year of 2025 visits (~14.4k, 562 EventIDs) are orphaned — and worse, those orphans have **no
`service_location_id` either**, so even `taskless_visits` (which joins on `service_location_id`)
can't see them. The fix is exactly what `link_visits_by_event` names: a **`get_task_detail` capture**
of the missing EventIDs (prime the customer from the log's `CustomerID` → `get_task_detail(EventID)`
→ upsert the task + schedule → link the visits). A recurring ION → tasks/schedules sync
(`_lib/upsert_tasks.py` / `upsert_schedules.py`) is what keeps this from recurring.

## Leadership

`maintenance.visits` is mixed-leadership (`[cache: ION + native]`):

| ION-owned (this sync writes) | Our domain / app-owned |
|---|---|
| visit occurrence, scheduled/actual tech, times, status, `visit_type`, `ion_work_order_id`, `price_cents`, `snapshot_frequency` | `task_schedule_id` link, `billing_method`, reconciliation indicators (proposed) |

Note `maintenance.tasks` / `task_schedules` are ALSO partly app-owned — the Next.js maintenance UI (`lib/entities/task/mutations.ts`) edits routes/schedules, while the ION sync seeds them. See [Task Schedule](../../entities/task-schedule.md).

## Drift detection

**None currently** — same accepted gap as [ion-work-orders](ion-work-orders.md). The `lookback_days=7` re-scrape is the de-facto reconciliation for recent edits; older changes aren't caught.

## Write-back to ION

**None today.** [ADR 002](../../adrs/002-ion-api-layer.md) proposes adding write endpoints (e.g., correct a visit) behind the ION API layer.

## Cross-references

- **Endpoint field reference (exact shapes from `addLog` / `addTask`):**
  [ion-task-and-log-detail](../../integrations/ion-task-and-log-detail.md)
- **Historical backfill + the linker flows (the undocumented 33k re-run):**
  [ion-visit-task-backfill](../../operations/ion-visit-task-backfill.md)
- Entity: [Visit](../../entities/visit.md)
- Sibling sync: [ion-work-orders](ion-work-orders.md)
- Consumes (future): [ION API](../../integrations/ion.md), [ADR 002](../../adrs/002-ion-api-layer.md)
- Downstream: [monthly-maintenance-billing](../monthly-maintenance-billing/index.md)
