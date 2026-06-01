-- Drop the UNIQUE (visit_id, task_name) constraint on maintenance.visit_tasks.
--
-- ION emits one report row per service body. A location with both a pool
-- and a spa produces two report rows for the same
-- (service_location_id, scheduled_date); the visit upsert collapses them
-- onto one maintenance.visits row. The per-body detail survives on the
-- child tables: chem_readings and consumables_usage already allow
-- multiple rows per visit_id (no UNIQUE), distinguished by pool_id.
--
-- visit_tasks should follow the same pattern. The original constraint
-- (added in 20260528163509_add_maintenance_visit_tasks) was framed as
-- belt-and-suspenders against re-runs, but its actual effect was to
-- reject intra-batch duplicates from collapsed service-body rows, which
-- crashed the f/ION/visits ingestion at 2026-05-28 14:00.
-- Cross-run idempotency is already handled by the DELETE-then-INSERT
-- step in f/ION/_lib/upsert.py:482.

ALTER TABLE maintenance.visit_tasks
  DROP CONSTRAINT visit_tasks_visit_id_task_name_key;

COMMENT ON TABLE maintenance.visit_tasks IS
  'Per-visit checklist completion. One row per (source_row × canonical_task), '
  'so a visit covering multiple service bodies (e.g. pool + spa at one '
  'address) keeps each body''s checklist as its own rows, distinguished '
  'by pool_id. Populated by f/ION/_lib/upsert.py from _tasks parsed in '
  'f/ION/_lib/parser.py. Task names are canonical post alias resolution; '
  'see TASK_ALIASES and TASK_DEFINITIONS in normalize.py.';
