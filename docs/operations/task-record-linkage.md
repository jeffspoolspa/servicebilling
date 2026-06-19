# How a maintenance task links to customers & addresses

> Status: [active] — current state of `maintenance.tasks` linkage, why the REGINA
> mis-attribution happened, and how to harden the process. Companion to
> [task.md](../entities/task.md), [service-location.md](../entities/service-location.md),
> [customer.md](../entities/customer.md), and [integrations/ion.md](../integrations/ion.md).

## The records a task touches

A `maintenance.tasks` row carries three pointers to other records:

| Column | Points at | Enforced by FK? | Meaning |
|---|---|---|---|
| `customer_id` | `public."Customers".id` | **No (soft)** | Who is serviced / billed |
| `service_location_id` | `public.service_locations.id` | **No (soft)** | Where the pool is |
| `ion_task_id` | `ion.recurring_tasks.ion_task_id` | **No (soft)** | **The ION task id — 1:1 with the task, now populated on every task** (unique index `uq_tasks_ion_task_id`). The key the visit→task link matches on. |

`visits.task_id → tasks.id` is the visit's parent link. **`customer_id` and `service_location_id`
are columns holding ids with no FK** — nothing in the database stops a task from pointing at the
wrong customer, so a bad resolve is silent.

## Tasks, schedules, and visits (the 3-level shape)

```
task  (1 per ION recurring task; ion_task_id is the 1:1 key, now on the task row)
  ├─ task_schedule × N   routing/cadence only: day_of_week, frequency, sequence, tech, per-visit price
  └─ visit × M           visits.task_id → task.id  (matched on ion_task_id)
```

- **The ION task id is 1:1 with a task.** It used to live *only* on `task_schedules` (every schedule
  row carries it; all of a task's schedules share one) and on visits — `tasks.ion_task_id` was empty
  (65/1,161). It is now backfilled onto every task (migration `20260617180000`), so reason about
  tasks ↔ ION via `tasks.ion_task_id` directly.
- **A visit links to the task, not the schedule.** `visits.task_id` is the parent link (set by matching
  `visits.ion_task_id` → the task's `ion_task_id`). `visits.task_schedule_id` is **unused (all NULL)** —
  schedules are routing/cadence only; the per-visit price is snapshotted onto the visit at generation.
  *(The ION ingestion code — `f/ION/_lib/upsert.py`, `relink_visits.py` — still references
  `task_schedule_id` for an intended day/tech-slot link that was never populated; removing the column
  means reworking that skill-gated code.)*

## The ION report is active-only; `tasks` is the complete history

The ION recurring-task export we sync (`ion.recurring_tasks`, "Recurring Tasks Detail - Active Only")
**only contains currently-active tasks** (`task_end` ≥ today). But `maintenance.tasks` must be the
**complete list of every task that ever existed**, including expired ones — because every historical
visit has to link to a task by id. Expired tasks/schedules are therefore synthesized from visit data,
not from the active report. (Gap to close: ~14k historical visits still have no task — 562 ION task
ids with no synthesized task/schedule.)

```
                       resolves by (address, name)
ion.recurring_tasks  ───────────────────────────────►  service_locations  (the WHERE)
  (the source: ion_task_id,                                   │
   qbo_customer_id, customer_name,                            │ account_id  (the owner)
   service_address)                                           ▼
        │                                              public."Customers"  (the WHO)
        │  ion_task_id                                        ▲
        ▼                                                     │ customer_id (copied from
  maintenance.tasks  ─────────────────────────────────────────  the location's account_id)
        │  task_id (FK)
        ▼
  maintenance.visits   (also carry soft customer_id / service_location_id)
```
Text fallback: ION's recurring-task sync is the source of truth. Ingestion resolves a
`service_location_id` from the address+name, then sets the task's `customer_id` from **that
location's `account_id`** (its owner) — *not* from the ION record's own `qbo_customer_id`.

## Task closure: by ION end date, with the no-visits-after-end invariant (resolved 2026-06-18)

`task_end` (the ION end date) is the **source of truth for closing a task**, governed by one
invariant: **a task must have no visits after its end date** (a task still being serviced cannot have
a past end date). Two scheduled scripts implement closure, split by where the end date comes from:

- **In-report tasks** — `f/ION/_lib/upsert_tasks` (recurring_tasks.flow, daily 4am ET). Every task in
  ION's "Active Only" report is upserted active under the new data model (its own row keyed 1:1 by
  `ion_task_id`; `customer_id` from `ion_cust_id` → `Customers.ion_cust_id`, not the location owner).
  It closes a task only when its `task_end` is past AND no visit falls after it; it **never** closes a
  task merely for being absent from the report.
- **Dropped tasks** — `f/ION/close_dropped_tasks` (daily 4:30am ET). The catch: ION removes a task
  from the "Active Only" report the moment it is given an end date, so an ended task never appears
  there carrying its date. For each task active in our DB but absent from the report, this script
  fetches the **live** ION end date (`get_task_detail`) and closes it (`ends_on` = ION `endsOn`; if a
  visit falls after that date, `ends_on` = the last visit, per the invariant; ends-today/future →
  kept active with the date recorded). If ION shows no end date, the task is absent for another
  reason and is left active. Advisory-locked with `recover_orphan_tasks` (both prime the shared ION
  session); a `< 200`-row report aborts the run (guards against mass-closing on a failed fetch).

**Why fetch the ION date instead of closing on absence?** ION's recurring report is not the complete
set of active tasks — absence tracks *end-date assignment*, not cancellation. Discovered the hard
way: **LOST PLANTATION** is serviced ~24×/week yet was absent from the report — because ION had set
its end date to *today*. Closing on absence with `last_visit` as the end would have mis-dated active
commercial/POA accounts; fetching the real ION end date gets it right.

**History (2026-06-18).** The original bug was stale-active: ION ended WILLS, BRIAN
(`ion_task_id 1520572`) 2026-05-20 but our row stayed `status='active'`, keeping him the active owner
of his shared location over the genuinely-active LITTLE. Fixed by: closing the 11 then-dropped tasks
at their live ION end dates; committing the redesigned `upsert_tasks`; building + scheduling
`close_dropped_tasks`; and repairing **48** historical "visit after end date" violations (`ends_on`
pushed to the last visit). Result: 0 invariant violations, 0 active tasks with a past end date. The
whole app keys "active customer" off `maintenance.tasks.status`, so this is what keeps that honest.

## How the links get set (ION ingestion)

In `f/ION/_lib/upsert.py`:
1. `resolve_service_location_id(addr, name)` — find the location by normalized address + name.
2. The task's customer is then taken from the location's owner — literally
   `JOIN public."Customers" c ON c.id = sl.account_id` (upsert.py:131). **customer = location owner.**
3. The ION record's own `qbo_customer_id` (the authoritative per-task customer) is **not** used
   to set `customer_id`.

ION tells us, per task, how confident the address/name resolve was (`resolved_via`):

| `resolved_via` | rows | empty address | risk |
|---|---|---|---|
| `captured_nonactive` | 546 | 0 | low |
| `maintenance_link` | 476 | 1 | low |
| `captured_resolver` | 133 | 0 | low |
| **`ion_name_match`** | **6** | **3** | **high — name-only, no address** |
| `null` | 2 | 1 | unresolved |

## Why REGINA broke

Two ION tasks had **empty service addresses**, so they fell to `ion_name_match` and resolved to
the one shared junk location `service_locations` row with street `"."` (`sl#5936`). That row's
`account_id` happened to be `, REGINA` (qbo 9252). Because step 2 copies `customer_id` from the
location owner, **both tasks were attributed to REGINA** — even though ION said they belong to
`PARRISH, FONTAYNE` (qbo 9731) and `LUCAS, BRIANNA` (qbo 9810).

```
ion_task 5862525  (PARRISH, qbo 9731, address="")  ┐
ion_task 5876499  (LUCAS,   qbo 9810, address="")  ┘─► both name-matched to sl#5936 ("." , owner REGINA)
                                                      └─► task.customer_id := sl.account_id = REGINA   ✗
```
The location-owner inference is correct when **one** customer owns **one** location. It fails
whenever **many** ION customers collapse onto **one** shared/placeholder location: they all
inherit that location's single owner.

## How to fix the process

1. **Source `customer_id` from ION's persisted customer key, not the location.** We now persist
   ION's own customer id on the QBO customer row as `Customers.ion_cust_id` (fuzzy-match-once —
   ION exposes no QBO id; see [ADR 006](../adrs/006-ion-customer-id-fuzzy-match-once.md)).
   Ingestion should set `task.customer_id` by matching `ion.recurring_tasks.ion_cust_id` →
   `Customers.ion_cust_id` — the per-task authoritative owner — instead of `sl.account_id`.
   Keep the location-owner path only as a last-resort fallback when no `ion_cust_id` resolves.
   *(This ingestion edit is skill-gated and tracked separately; the `ion_cust_id` column +
   683-customer backfill are already done.)*
2. **Never let distinct customers share a placeholder location.** An empty/`"."` address should
   not resolve to a single shared row that then donates its owner. Either give each its own
   (unresolved) location, or leave `service_location_id` null until a real address is set via the
   app dropdown.
3. **Consider a soft guard.** A periodic check (or the existing reconciler) can flag
   `tasks` where `customer.qbo_customer_id <> ion.recurring_tasks.qbo_customer_id` — the exact
   query that found this (it returned 2). Add a real FK on `tasks.customer_id` /
   `service_location_id` so future bad ids fail loudly rather than silently.

The ingestion change lives in the skill-gated ION code (`f/ION/_lib/upsert.py`) — read the
`ion-automation` skill before editing. The REGINA records themselves were already corrected
(re-pointed to PARRISH and LUCAS).
