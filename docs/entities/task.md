# Entity: Task (service contract)

> Lives in: `maintenance.tasks`
> Source: [cache: ION + native]   (seeded from ION; edited via the maintenance UI)
> Status: [active]

## What it is

The **maintenance engine** for a service location — the long-lived recurring contract that drives the service-log schedule. An **active task means an active maintenance customer**; it has no fixed term and **can run indefinitely** (`ends_on` is usually NULL). It holds the contract-level settings: `chem_budget_cents` (expected chemical spend), `included_items`, status (`active` / `paused` with `pause_reason`), `starts_on` / `ends_on`. Its cadence + price live on its [Task Schedule](task-schedule.md) children, which generate the [Visits](visit.md).

A task is **not** tied to one month. For **every month it is active it produces one invoice** — so Task -> [Task Billing Period](task-billing-period.md) is **1:N** (one period per active month), and each period is 1:1 with that month's invoice.

Mixed leadership: seeded from ION (`external_source`, `external_data`) via `f/ION/_lib/upsert.py`, but also edited by the Next.js maintenance UI (`lib/entities/task/mutations.ts`) for route/scheduling management. Changes are audited in `maintenance.tasks_audit`.

## Billing coverage role

**Every month a task is active, it must be billed once.** At month-start the bridge writes a [Task Billing Period](task-billing-period.md) (invoice promise) for each active task; a promise still uninvoiced at month close = **missed billing**. This write-ahead checklist is how "did every maintenance customer get invoiced this month?" is answered, distinct from the per-invoice subtotal-correctness check. See [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md).

## Connected entities

- [Task Schedule](task-schedule.md) — one or more cadence+price rows per task (the schedule the engine runs)
- [Visit](visit.md) — occurrences generated from the schedule; each carries this `task_id`
- [Task Billing Period](task-billing-period.md) — **one per active month** (1:N); the coverage unit
- Service location (`service_location_id`) -> [Customer](customer.md) via `qbo_customer_id` (see `v_tasks_with_context`)

## Flows this entity participates in

- [ion-visits sync](../flows/sync/ion-visits.md) — seeded alongside visits
- [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md) — coverage check + `chem_budget_cents` informs the chemical-cost audit
