# ION task-detail & visit-detail endpoints — exact data shapes

> Status: [active] — the field reference for the two per-record ION detail endpoints. These are the
> **ground truth** for who owns a task/visit: both return the ION `CustomerID`. Companion to
> [ion-recurring-tasks.md](ion-recurring-tasks.md) (the bulk active-tasks pull) and
> [ion-visits.md](../flows/sync/ion-visits.md) (the daily sync that consumes log detail).

Both are ColdFusion edit-form pages; we read the hidden inputs / selected options. **A record's owner
is never guessed — `CustomerID` (`ion_cust_id`) is on the form.** That makes task/visit→customer
ownership deterministic (e.g. it resolved the WILLS/LITTLE same-address tangle: `ion_task_id 1520572`
→ CustomerID 1128522 = WILLS; `5940278` → 2569864 = LITTLE — both ION-active at one address).

---

## Visit detail — `f/ION/api/get_log_detail`  (`addLog.cfm`)

`GET /tasks/addLog.cfm?calendarID=<cal>&LogID=<log>&source=ServiceLog` — one service log = one visit.
**No customer priming needed** (LogID is global). Input: `[{ log_id, calendar_id }]` (from
`list_day_logs`). Returns `{ count, with_event, performed, with_readings, with_checklist,
with_consumables, details: [...] }`. Each `details[]`:

| Field | From (form name) | Meaning |
|---|---|---|
| `log_id` | (input) | ION LogID — **the unique visit grain** (`maintenance.visits.ion_log_id`) |
| `calendar_id` | (input) | ION calendar id |
| `event_id` | `EventID` | **The ION task id** (`ion_task_id`) this visit belongs to |
| `ion_customer_id` | `CustomerID` | **The ION customer id** (`ion_cust_id`) — authoritative owner |
| `task_invoice_id` | `TaskInvoiceID` | ION task-invoice id |
| `consumable_invoice_id` | `ConsumableInvoiceID` | ION consumable-invoice id |
| `loc_id` | `LocID` | ION location id |
| `scheduled_date` | `ScheduledDate` / `LogDate` | the visit date (MM/DD/YYYY) |
| `time_in` / `time_out` | `timeinvalue` / `timeoutvalue` | clock in/out |
| `serviceable` | computed | `time_in` present AND `time_out` ≠ `time_in` (else not performed) |
| `invoice_type` | `InvoiceType` | billing type enum |
| `service_profile` | `ServiceProfile` | chemistry/service profile |
| `original_failure_id` | `OriginalFailureID` | prior failure ref |
| `submitted_by` | `submittedBy` (select) | the tech (often blank → ingest falls back to day-grid tech) |
| `failure_reason` | `failureid` (select) | failure reason text |
| `comment` | `comment` (textarea) | visit notes |
| `consumables` | `item<n>` inputs, qty>0 | `[{ ion_item_id, name, quantity }]` (name from the row's `<strong>`) |
| `readings` | `field<n>` select/text controls | `[{ name, value }]` (label-keyed; empties dropped) |
| `task_checklist` | `field<n>` radio Yes/blank | `[{ name, completed }]` (label-keyed) |

Control classification: `radio` → checklist; `select`/`text` → reading; `item<n>` → consumable.
Consumed by [`ingest_day_logs`](../flows/sync/ion-visits.md) → `maintenance.visits` + `visit_readings`
+ `visit_tasks` + `consumables_usage`.

---

## Task detail — `f/ION/api/get_task_detail`  (`addTask.cfm`)

`GET /tasks/addTask.cfm?EventID=<ion_task_id>&isIFrame=1` — the task edit form. **Requires priming the
customer first** (`GET /customers/customerTabs.cfm?customerid=<ion_cust_id>`); a bare EventID fetch
**500s**. Returns `{ detail, dayRoster }` where `dayRoster` is an ION employee-id → name map. `detail`:

| Field | Meaning |
|---|---|
| `ionTaskId` | the ION task id (EventID) |
| `customerId` | **`CustomerID`** — the ION customer id (authoritative owner) |
| `serviceType` | `{ value, text }` — e.g. "POOL MAINTENANCE 50 … @ $50.00" |
| `profile` | `{ value, text }` — service/chemistry profile |
| `serviceRepeat` | `{ value, text }` — Weekly / Bi-Weekly / Daily / Monthly |
| `invoiceType` / `invoiceDate` | `{ value, text }` billing enums |
| `startsOn` / `endsOn` | task window (ISO); `endsOn` past = expired/closed |
| `perDayTech` | `[{ dow, dayName, techId, techName }]` — **the tech for each serviced day** (day1..day7 = Sun..Sat) |
| `stopPayFixed` / `itemCost` / `taskNote` / `flags` | pay-hold, item cost, free-text note, misc flags |

Used by [`recover_orphan_tasks`](../operations/ion-visit-task-backfill.md) to synthesize a missing
`maintenance.tasks` row + one `task_schedules` row per `perDayTech` day. This endpoint is also the
ADR-002 write-back path (`update_task`, dry-run-first) for editing a task in ION.

> **Chicken-and-egg note:** `get_task_detail` needs the customer to prime. When you only have an
> EventID (e.g. an orphan visit), get the customer first from the **log** detail
> (`addLog.cfm` → `CustomerID`, no priming), then prime + fetch the task detail.
