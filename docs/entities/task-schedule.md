# Entity: Task Schedule (cadence + price)

> Lives in: `maintenance.task_schedules`
> Source: [cache: ION + native]   (seeded from ION; edited via the maintenance UI)
> Status: [active]

## What it is

How often a [Task](task.md) is serviced and what it costs — the billing terms. One task can have multiple schedules (e.g., different days/techs). Key columns:

- `day_of_week`, `frequency` (weekly / biweekly / monthly), `sequence` (stop order on the route)
- **`billing_method`** — `per_visit` or `flat_rate_monthly`
- `price_per_visit_cents` and `flat_rate_monthly_cents` — the two pricing modes
- `tech_employee_id`, `office`, `active`, `starts_on` / `ends_on`
- `ion_task_id` (ION linkage), `skimmer_id` (legacy — ION is the current leader per [ADR 002](../adrs/002-ion-api-layer.md))

This is the **source of the expected bill**: the proposed visits-vs-invoice reconciliation ([monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md)) multiplies `price_per_visit_cents × completed visits` (or uses `flat_rate_monthly_cents`) and compares to what QBO billed.

Mixed leadership like [Task](task.md): ION-seeded, app-edited (`lib/entities/task/mutations.ts`). Changes audited in `maintenance.task_schedules_audit`.

## Connected entities

- [Task](task.md) via `task_id` — a schedule belongs to one task (the task is the parent; the ION
  id lives on the task as `tasks.ion_task_id`). Schedules are **routing/cadence only**.
- [Employee](employee.md) via `tech_employee_id`
- [Visit](visit.md) — visits do **not** link to a schedule (`visits.task_schedule_id` is unused / all
  NULL). A visit links to the **task** (`visits.task_id`); it snapshots the schedule's
  `billing_method` / `flat_rate_monthly_cents` at generation rather than carrying a live FK.

## Flows this entity participates in

- [monthly-maintenance-billing](../flows/monthly-maintenance-billing/index.md) — defines expected billing for the reconciliation
