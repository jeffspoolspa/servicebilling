# Entity: Task (service contract)

> Lives in: `maintenance.tasks`
> Source: [cache: ION + native]   (seeded from ION; edited via the maintenance UI)
> Status: [active]

## What it is

The **maintenance engine** for a service location — the long-lived recurring contract that drives the service-log schedule. An **active task means an active maintenance customer**; it has no fixed term and **can run indefinitely** (`ends_on` is usually NULL). It holds the contract-level settings: `chem_budget_cents` (expected chemical spend), `included_items`, status (`active` / `paused` with `pause_reason`), `starts_on` / `ends_on`. Its cadence + price live on its [Task Schedule](task-schedule.md) children, which generate the [Visits](visit.md).

A task is **not** tied to one month. For **every month it is active it produces one invoice** — so Task -> [Task Billing Period](task-billing-period.md) is **1:N** (one period per active month), and each period is 1:1 with that month's invoice.

Mixed leadership: seeded from ION (`external_source`, `external_data`) by the recurring-task sync and `f/ION/recover_orphan_tasks`, but also edited by the Next.js maintenance UI (`lib/entities/task/mutations.ts`) for route/scheduling management. Changes are audited in `maintenance.tasks_audit`.

## Classification (category + frequency)

Added 2026-07-02 for churn/frequency analytics and routing filters (migrations `20260702000000`–`20260702030000`):

- **`category`** — GENERATED column, always computed from the ION service description
  (`external_data->>'service_type'`) by **`maintenance.task_category(text)`**, the single-source rule:
  `recurring` (POOL MAINTENANCE n / FLAT RATE / SPA CLEAN / FOUNTAIN CLEAN / CHEMICAL TESTING) |
  `quality_control` (QUALITY CONTROL, NO CHARGE — non-billable labor) | `green_pool` |
  `one_time_clean` | `plaster_start_up` | `other` (admin junk) | `unknown` (no description).
  Because it is generated, every ingestion path tags automatically — change the rule only in the
  function. Sanity-verified against visit counts (recurring avg ~48 visits/task, QC ~2, green pool ~6,
  one-time ~1). Index `(category, status)`; the routing tool filters `category='recurring' and status='active'`.
- **`frequency`** + **`days_per_week`** — trigger-maintained (NOT generated: they roll up
  [Task Schedule](task-schedule.md) rows). `maintenance.recalc_task_frequency(task_id)` runs on task
  INSERT and on any `task_schedules` change: any biweekly row → `biweekly`; daily rows or weekly on
  >1 weekday → `multi_week` (with `days_per_week`); else `weekly` / `monthly`; fallback = ION's
  recurrence text in `external_data->>'recurrence'`.
  **Caveat:** frequency is only meaningful where `category='recurring'` — one-offs carry ION's
  nominal repeat setting (often "Daily").
- **`maintenance.v_task_class`** — the analysis surface: the columns above + `is_commercial`
  ([Customer](customer.md) `company` filled = commercial) + billing config. Churn by type/frequency =
  compare active recurring tasks month over month via `starts_on`/`ends_on`.

## Billing coverage role

**Every month a task is active, it must be billed once.** At month-start the bridge writes a [Task Billing Period](task-billing-period.md) (invoice promise) for each active task; a promise still uninvoiced at month close = **missed billing**. This write-ahead checklist is how "did every maintenance customer get invoiced this month?" is answered, distinct from the per-invoice subtotal-correctness check. See [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md).

## Connected entities

- [Task Schedule](task-schedule.md) — one or more cadence+price rows per task (the schedule the engine runs)
- [Visit](visit.md) — occurrences generated from the schedule; each carries this `task_id`
- [Task Billing Period](task-billing-period.md) — **one per active month** (1:N); the coverage unit
- [Customer](customer.md) — the task carries `customer_id` (ADR 006, the authoritative owner). A task does **not** carry a service location (ADR 007 §9 — `service_location_id` is being dropped); its address is the customer's confirmed link-table location, surfaced via `v_tasks_with_context` → `v_customer_primary_location`.

## Flows this entity participates in

- [ion-visits sync](../flows/sync/ion-visits.md) — seeded alongside visits
- [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md) — coverage check + `chem_budget_cents` informs the chemical-cost audit
