-- Add maintenance.visit_tasks — per-visit task completion tracking.
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- The ION pipeline used to track per-visit task completion (brushing,
-- vacuuming, salt cell cleaning, etc.) in `ion.visit_tasks` (0 rows in the
-- current DB — schema was created but the upsert step never wrote to it
-- after the migration from the `ion.*` schema to `maintenance.*`).
--
-- The parser in f/ION/_lib/parser.py STILL extracts task completion as
-- `row_dict["_tasks"]` (line 178 of parser.py). The normalize step
-- processes it. But upsert.py never wrote it anywhere — every visit
-- ingestion was discarding this data.
--
-- This migration restores the table in its canonical home (maintenance
-- schema), following the same column/FK patterns as
-- maintenance.chem_readings and maintenance.consumables_usage.
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- One row per task per visit.
-- task_name is the CANONICAL name resolved from ION's raw column headers
-- via the TASK_ALIASES map in f/ION/_lib/normalize.py (e.g., "Brsh" →
-- "brushed_pool", "Vac" → "vacuum_pool"). For task display, the
-- normalize module also exports TASK_DEFINITIONS keyed by canonical name
-- with display_name + category + display_order.
--
-- Aliases live in code, not the DB. This matches the consumables pattern
-- where item_name resolution happens in upsert.py via lookup against
-- public.items rather than a DB-driven definitions table.
--
-- UNIQUE (visit_id, task_name) prevents duplicate rows if the upsert is
-- re-run for the same visit. The upsert script does DELETE-then-INSERT
-- for each visit's tasks anyway (same pattern as chem_readings) — the
-- unique constraint is belt-and-suspenders.

CREATE TABLE maintenance.visit_tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id     uuid NOT NULL REFERENCES maintenance.visits(id) ON DELETE CASCADE,
  pool_id      uuid REFERENCES public.pools(id),
  task_name    text NOT NULL,
  completed    boolean NOT NULL,
  source       text NOT NULL DEFAULT 'ion',
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (visit_id, task_name)
);

-- Index for the common UI query: "show me all completed/missed tasks for
-- a given visit." Pool filter is rare enough to not need its own index.
CREATE INDEX idx_visit_tasks_visit_id ON maintenance.visit_tasks(visit_id);

-- Useful for "find all visits where a particular task was missed" reports.
-- Filtered index on incomplete rows is cheap because most rows have
-- completed=true (the typical service is a full checklist).
CREATE INDEX idx_visit_tasks_incomplete
  ON maintenance.visit_tasks(visit_id)
  WHERE completed = false;

COMMENT ON TABLE maintenance.visit_tasks IS
  'Per-visit checklist completion. One row per canonical task per visit '
  '(e.g., brushed_pool, vacuum_pool, cleaned_salt_cell). Populated by '
  'f/ION/_lib/upsert.py from the _tasks dict parsed in '
  'f/ION/_lib/parser.py. Task names are canonical post alias resolution; '
  'see TASK_ALIASES and TASK_DEFINITIONS in normalize.py for the mapping '
  'and display metadata.';

COMMENT ON COLUMN maintenance.visit_tasks.task_name IS
  'Canonical task name (snake_case). See TASK_DEFINITIONS in '
  'f/ION/_lib/normalize.py for the full catalog of canonical names.';
