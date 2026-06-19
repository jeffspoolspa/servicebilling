# Historical visit → task linking pipeline ("every visit gets a task")

> Status: [active] — the (previously undocumented) set of Windmill flows that backfilled
> ~1.5 years of ION visits and linked them to tasks, plus the known residual gap. Companion to
> [ion-visits sync](../flows/sync/ion-visits.md) and [task-record-linkage](task-record-linkage.md).

Every `maintenance.visits` row should link to a `maintenance.tasks` row (`visits.task_id`), because
visits are what billing reconciles. ION's active-tasks report only covers *currently active* tasks,
so a one-time historical backfill + several linkers were run to populate tasks and attach the
historical visits. **None of this was documented** — this doc is the missing runbook.

## The flows (run order)

| # | Flow / script | What it does | Safety |
|---|---|---|---|
| 1 | **`f/ION/_discover/backfill_visits.py`** | Chunked historical pull of `maintenance.visits` via the `CompletedLogDetail` report, looping **monthly windows** (`2025-01`→`2026-03`). Reuses the cached session (no chromium). | `probe_only=True` default (counts only) |
| 2 | **`f/ION/recurring_tasks.flow`** | Sync the **active** recurring tasks → `maintenance.tasks` / `task_schedules` (active-only). | — |
| 3 | **`f/ION/schedule_slots.flow`** | Sync per-day/tech **schedule slots**. | — |
| 4 | **`f/ION/relink_visits.flow`** (`_lib/relink_visits.py`) | Re-resolve `task_id` + `task_schedule_id` over existing visits by **`service_location`** + best day/tech/price slot. Fill-only. | `dry_run=True` default; `since=` limits range |
| 5 | **`f/ION/link_visits_via_log.flow`** | **Authoritative** linker: for task-less visits, `taskless_visits` → `resolve_visit_tasks_via_log` (loglist → LogID → `addLog.cfm` → **EventID**) → `link_visits_by_event` (set `task_id` where `task_schedules.ion_task_id = EventID`). EventID is ground truth, overrides #4. | `dry_run=True` default |
| 6 | **`f/ION/capture_nonactive_tasks.flow`** | "Make every visit have a task." `capture_targets` (service_locations with task-less visits) → `resolve_customer_tasks` (customer + **full** taskList incl. **expired/one-time**, which #2 skips) → `upsert_nonactive_tasks` (create missing tasks: expired→`closed`; + slots; link visits by `[starts_on, ends_on]` window). Batched (`limit=80`, highest visit-count first; re-run advances). | `dry_run=True` default |

Net result of the run: **~40k of ~54k visits linked**; `tasks` grew to 1,161 (spanning 2019–2026).

## The residual gap (the 14,411 still-orphan visits)

After all of the above, **14,411 completed visits (all of 2025, 562 distinct EventIDs) are still
task-less** — see [task-record-linkage](task-record-linkage.md). Root cause:

- **Both `capture_targets` (#6) and `taskless_visits` (#5) key off `service_location_id`.** These
  14,411 orphans have **no `service_location_id`** (and no `customer_id`) — only `ion_task_id` +
  `ion_log_id` + `visit_date`. So they are **invisible to the very flows built to fix them.**
- Their 562 EventIDs are **expired tasks never synced** (the active-only sync #2 skips them; #6
  never saw them because of the service_location blindspot). `link_visits_by_event` would call these
  `event_not_in_db`.

### Recovering the residual (the missing branch)

Drive the same capture off the orphans' **`ion_task_id`** instead of `service_location`:
1. Per distinct orphan EventID, fetch one of its visits' `addLog.cfm?calendarID=&LogID=` →
   **`CustomerID`** (the hidden field; verified present).
2. Prime that customer (`customerTabs.cfm?customerid=`) → `get_task_detail(EventID)` → cadence/dates.
3. Upsert the `task` + `task_schedules` (reuse `_lib/upsert_tasks` / `upsert_schedules`), linked to
   the customer via `ion_cust_id` ([ADR 006](../adrs/006-ion-customer-id-fuzzy-match-once.md)).
4. Link the visits: `UPDATE maintenance.visits SET task_id = … WHERE ion_task_id = EventID`.

This is exactly the `event_not_in_db` → "get_task_detail capture" branch `link_visits_by_event.py`
already names — it just needs an ion_task_id-driven entry point because the orphans have no
service_location.

**Implemented as `f/ION/recover_orphan_tasks`** (2026-06-18). One committing, idempotent, batched
pass (`limit`, highest visit-count first; re-run advances since done EventIDs drop out of
`task_id IS NULL`, and `uq_tasks_ion_task_id` blocks dup tasks): per orphan EventID it reads
`addLog` → CustomerID, calls `get_task_detail`, creates the `task` (`external_source='ion_log'`,
status from expiry, service_location from the customer's clean address) + one `task_schedule` per
serviced day (tech via `_resolve_tech`, frequency via `_map_frequency`), and sets
`visits.task_id` + `customer_id` + **`ion_cust_id`** + `service_location_id`. Each statement
auto-commits, so a mid-run stop is safe to resume.

## The real fix (so this stops recurring)

The daily sync ([ion-visits](../flows/sync/ion-visits.md)) ingests a bulk report and **guesses the
task by `service_location`**, which is why orphans happen and why this whole recovery stack exists.
The durable fix is a **log-detail-centric ingester**: by-day log list (`customerLogDetails.cfm`) →
`addLog.cfm` per log (carries **both `EventID` and `CustomerID`**) → ingest the visit already
carrying its true task + customer, with a resolver that creates the task if missing. Then no visit
can orphan. Tracked as a separate change to the live sync.
