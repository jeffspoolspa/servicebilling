# Entity: Task Schedule (cadence + price)

> Lives in: `maintenance.task_schedules`
> Source: [cache: ION + native]   (seeded from ION; edited via the maintenance UI)
> Status: [active]

## What it is

How often a [Task](task.md) is serviced — the routing cadence. One task can have multiple schedules (one row per scheduled weekday, mirroring ION's day1–day7 tech roster). Key columns:

- `day_of_week`, `frequency` (`weekly` / `biweekly_a` / `biweekly_b` / `daily` / `monthly`), `sequence` (stop order on the route)
- `tech_employee_id`, `office`, `active`, `starts_on` / `ends_on`
- `ion_task_id` (ION linkage), `skimmer_id` (legacy — ION is the current leader per [ADR 002](../adrs/002-ion-api-layer.md))

**Financial columns were dropped 2026-06-19** — `billing_method` / rate live on the [Task](task.md)
(ADR 007 §9); schedules are routing/cadence only. The expected bill comes from
`tasks.price_per_visit_cents × billable visits` (or `tasks.flat_rate_monthly_cents`).

**Feeds `tasks.frequency`:** any insert/update/delete here fires the `task_schedules_freq` trigger,
which rolls the task's schedule rows up into `tasks.frequency` + `tasks.days_per_week`
(see [Task](task.md) Classification). ION clears the day roster on old closed tasks, so historical
tasks may legitimately have no schedule rows — their frequency comes from ION's recurrence text.

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
