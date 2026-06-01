# Sub-module: maintenance / operations

> Status: [stub]
> Schema: `maintenance.*`
> Scripts: `f/ION/*` (visits, consumables_usage, refresh_stale_work_orders)

## Purpose

Recurring maintenance service operations: the ION visit pipeline, chem readings, consumables usage, visit tasks. The maintenance counterpart to the service module's per-WO transactional billing.

> This is the planned GOLD-STANDARD sub-module — the one to fill out first using the (still-settling) sub-module template, since working through it surfaces the right boundaries. Not yet written. When written it documents: the ION visits sync, `maintenance.visits` / `visit_tasks` / `chem_readings` / `consumables_usage`, the task-alias normalization in `f/ION/_lib/normalize.py`, and the tech-mobile capture path.

## Where partial detail lives now

- Entity: [Visit](../../entities/visit.md) (stub)
- Related sync pattern (sibling): [ion-work-orders](../../flows/sync/ion-work-orders.md)
