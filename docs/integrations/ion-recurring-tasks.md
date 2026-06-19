# What ION gives us when we pull the active tasks

> Status: [active] — the field reference for the ION "active tasks" pull. Source of truth for
> the shape is the `RecurringTask` interface in `f/ION/_lib/reports.ts` and the
> `ion.recurring_tasks` table. See [ion.md](ion.md) for the fetch/parse plumbing and
> [task-record-linkage](../operations/task-record-linkage.md) for how these feed maintenance.

## The pull

"Active tasks" = the ION report **"Recurring Tasks Detail - Active Only"**, fetched from
`/reports/_xls/RecurringtasksActive.cfm` ([read]). It comes back as an HTML table; the parser
(`normalizeRecurringTasks`) maps each row to a typed `RecurringTask`. The endpoint is
`f/ION/api/get_recurring_tasks(filters)`.

> **This report is active-only** (`task_end` ≥ today). But `maintenance.tasks` must hold **every
> task that ever existed**, including expired ones, because every historical visit links to a task
> by id. Expired tasks are synthesized from visit data, not from this report. The 1:1 ION key is
> `tasks.ion_task_id`. See [task-record-linkage](../operations/task-record-linkage.md).

ION sends us **23 columns per task**. We promote 19 to typed columns on `ion.recurring_tasks`,
add 5 of our own (resolution + provenance), and keep the **entire** original row in `raw` (so
nothing is ever lost — `raw` even carries fields we don't promote, like `seq`, `lockCombo`,
`techPay`, `serviceProfile`, plus extras `captured`, `one_time`, `recurrence`, `slot_count`).

## The 23 fields ION sends

| ION field | stored column | what it is |
|---|---|---|
| `ionTaskId` | `ion_task_id` | ION's task id — the join key to `maintenance.tasks.ion_task_id` |
| `ionCustId` | `ion_cust_id` | ION's internal customer id |
| `customerName` | `customer_name` | "LAST, FIRST" as ION has it (used by the `ion_name_match` fallback) |
| `customerType` | `customer_type` | residential / commercial |
| `serviceAddress` | `service_address` | service street — **often empty**; the gap behind unresolved addresses |
| `city` / `state` / `zip` | `city` / `state` / `zip` | service city/state/zip (also often empty) |
| `serviceType` | `service_type` | kind of service (full-service, chem-only, …) |
| `serviceRepeat` | `service_repeat` | recurrence cadence (e.g. weekly) |
| `serviceProfile` | *(raw only)* | chemistry / service profile |
| `taskStart` | `task_start` | recurrence start date |
| `taskEnd` | `task_end` | recurrence end — null/blank = ongoing (i.e. still active) |
| `taskPrice` | `task_price_cents` | recurring price (parsed to cents) |
| `techPay` | *(raw only)* | tech pay for the task |
| `billingType` | `billing_type` | how the task is billed |
| `lastVisit` | `last_visit` | date of the most recent visit |
| `routeName` | `route_name` | assigned route |
| `zone` | `zone` | service zone |
| `seq` | *(raw only)* | stop sequence within the route |
| `facilityDescription` | `facility_description` | free-text facility notes |
| `lockCombo` | *(raw only)* | gate / lock code |
| `recurringNotes` | `recurring_notes` | free-text notes |

Note: ION does **not** send a QBO id or a clean address key — and it exposes no QBO id
anywhere in its own pages/API either (the ION→QBO link lives only in the third-party ProEdge
sync bridge; verified 2026-06-17). Because of that, ION's own customer id is persisted on the
QBO customer row as `Customers.ion_cust_id` via fuzzy-match-once, so task ownership can resolve
off that stable key — see [ADR 006](../adrs/006-ion-customer-id-fuzzy-match-once.md). It also
gives us a `customerName` and (often) **no `serviceAddress`** — which is why the name-only
match path exists, and why empty-address tasks are the fragile ones.

## The 5 columns we add (not from ION)

| Column | How it's set |
|---|---|
| `qbo_customer_id` | Resolved: ION customer → our QBO customer. **The authoritative per-task customer** — and the field the task-customer resolve *should* use (see the linkage doc). |
| `service_location_id` | Resolved: `resolve_service_location_id(normalized address, name)` → a `service_locations` row. Empty addresses collapse onto a shared placeholder. |
| `resolved_via` | How the row was matched: `captured_nonactive` (546), `maintenance_link` (476), `captured_resolver` (133), `ion_name_match` (6 — name-only, the risky path), `null` (2). |
| `raw` | The full original ION row (jsonb), camelCase + snake_case + extras. Nothing discarded. |
| `synced_at` | When we last pulled it. |

## Why this matters for data quality

- The **address fields are frequently blank** — ION is reliable for *who/what/when/how-much*,
  far less so for *where*. That's the entire reason for the canonical-address work (ADR 005):
  ION tells us a task exists; the real street usually has to come from the autocomplete dropdown.
- `taskEnd` (blank = active) and `serviceRepeat` define "active recurring task" — the same signal
  the app uses for "currently serviced". **Closure note:** this report is "Active Only", so ION
  **drops a task the moment it's given an end date** — an ended task is *absent* here, not present
  with a past `taskEnd`. So task closure is driven by the **live** ION end date fetched per dropped
  task (`f/ION/close_dropped_tasks` → `get_task_detail`), governed by the invariant *no visits after
  the end date*; `f/ION/_lib/upsert_tasks` handles the in-report tasks. See
  [task-record-linkage](../operations/task-record-linkage.md#task-closure-by-ion-end-date-with-the-no-visits-after-end-invariant-resolved-2026-06-18).
- Because ION gives a name but often no address, the `ion_name_match` fallback can land multiple
  customers on one placeholder location — the failure mode documented in
  [task-record-linkage](../operations/task-record-linkage.md).
