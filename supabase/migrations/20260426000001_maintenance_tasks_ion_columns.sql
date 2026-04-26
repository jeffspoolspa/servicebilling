-- Adds ION-specific fields to maintenance.tasks for ingest from the
-- Recurring Tasks Detail + Technician Event Summary reports, and expands
-- the frequency check to include 'daily' (ION's 7x/week cadence).
--
-- The strict one-active-task-per-service-location index from the initial
-- maintenance migration stays in place. ION uses extra tasks at the same
-- location for QC + green-pool visits — we model those differently
-- (visits with visit_type='qc', not separate tasks). The ingest script
-- detects multi-task locations, keeps the primary task, and flags the
-- extras as duplicates needing review.

ALTER TABLE maintenance.tasks
  ADD COLUMN IF NOT EXISTS ion_task_id    text,
  ADD COLUMN IF NOT EXISTS external_data  jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_ion_task_id
  ON maintenance.tasks(ion_task_id) WHERE ion_task_id IS NOT NULL;

-- Expand the frequency check to include 'daily' (7x/week).
ALTER TABLE maintenance.tasks
  DROP CONSTRAINT IF EXISTS tasks_frequency_check;
ALTER TABLE maintenance.tasks
  ADD CONSTRAINT tasks_frequency_check
    CHECK (frequency IS NULL OR frequency IN ('daily', 'weekly', 'biweekly_a', 'biweekly_b', 'monthly'));

-- Match visits.snapshot_frequency too (snapshot uses the same vocabulary).
ALTER TABLE maintenance.visits
  DROP CONSTRAINT IF EXISTS visits_snapshot_frequency_check;
ALTER TABLE maintenance.visits
  ADD CONSTRAINT visits_snapshot_frequency_check
    CHECK (snapshot_frequency IS NULL OR snapshot_frequency IN ('daily', 'weekly', 'biweekly_a', 'biweekly_b', 'monthly'));
