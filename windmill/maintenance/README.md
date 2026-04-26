# Maintenance — Windmill mirror

Mirror of the `f/maintenance/*` scripts that the internal-app's maintenance
module depends on. Scope test (run before adding anything) is the same as
the parent [windmill/README.md](../README.md).

## Status — 2026-04-25

This namespace is **reserved**, not yet populated. The maintenance scaffold
(schema, entity modules, module folder) just landed. Each ingest flow gets
its own plan and lands here as it's built.

## Expected additions

| Plan | Script | Notes |
|---|---|---|
| Skimmer task ingest | `f/maintenance/skimmer_tasks_ingest` | Pulls schedule data from Skimmer into `maintenance.tasks` (keyed by `skimmer_id`). |
| Skimmer visit ingest | `f/maintenance/skimmer_visits_ingest` | Pulls scheduled visits into `maintenance.visits` (keyed by `skimmer_visit_id`). |
| ION visit ingest | `f/maintenance/ion_visits_ingest` | Pulls completed work orders into `maintenance.visits` (keyed by `ion_work_order_id`). Merges with Skimmer-sourced rows when keys match. |
| ION consumables ingest | `f/maintenance/ion_consumables_ingest` | Pulls ION consumables into `maintenance.consumables_usage`. |
| Weekly visit generator (post-cutover) | `f/maintenance/weekly_visit_generator` | Walks active tasks, snapshots price/tech/date into new visits. Idempotent via `unique(service_location_id, scheduled_date)`. Future-state. |

## Source-of-truth model (v1)

- Skimmer + ION are the field-operations source of truth during v1.
- Every `maintenance.*` table has nullable fields for ingest tolerance and
  external-id columns (`skimmer_id`, `ion_work_order_id`, `skimmer_visit_id`,
  `ion_pool_id`) for re-sync joins.
- `external_source` discriminator on `tasks` and `visits` tells us where a
  row came from (`skimmer | ion | generator | manual`).
- v1 conflict policy: Skimmer/ION wins on update. Manual edits opt out by
  setting `external_source = 'manual'`. Per-flow policy locked when each
  ingest plan is written.

## Architecture anchor

Full domain model + decisions live in
`~/.claude/plans/i-want-to-start-breezy-phoenix.md`. Reference that plan from
each ingest flow's plan rather than re-deciding the schema.
