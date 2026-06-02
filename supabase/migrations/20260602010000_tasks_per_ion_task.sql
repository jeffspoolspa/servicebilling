-- maintenance.tasks: move from ONE-open-task-per-service-location to ONE task per ION task.
--
-- BACKGROUND: the recurring-task sync (#58) hit tasks_one_open_per_loc (a unique
-- index allowing a single active/paused task per service_location) whenever ION
-- had MULTIPLE recurring tasks at one address (common for communities/commercial:
-- e.g. WINDING RIVER = a POOL MAINTENANCE contract + 3 CHEMICAL TESTING contracts).
-- The workaround attached the extra ION tasks as extra SCHEDULES on the one task.
-- That preserved visit-linkage but BROKE billing: the promise builder emits one
-- row per task and uses max(rate), so 4 contracts at 2 rates ($85 / $50) collapse
-- into one promise at $85 x all-visits, which can't reconcile against the 4 real
-- per-contract invoices.
--
-- DESIGN: a task is now 1:1 with an ION recurring task (ion_task_id). Each ION
-- contract = its own maintenance.tasks row with its own service/rate/billing, and
-- visits attribute to the specific contract. Uniqueness is enforced per ion_task_id
-- (one active/paused task per ION task; naturally allows many per location). Manual
-- (non-ION, ion_task_id IS NULL) tasks keep the old one-active-per-location guard.
--
-- SAFE: every existing task currently has ion_task_id IS NULL, so they all fall
-- under the manual index = the exact old invariant (one active/paused per loc holds
-- today, so no violation). The split script (f/ION/_lib/split_collapsed_tasks) then
-- populates ion_task_id as it breaks collapsed tasks apart.

ALTER TABLE maintenance.tasks
  ADD COLUMN IF NOT EXISTS ion_task_id text;

DROP INDEX IF EXISTS maintenance.tasks_one_open_per_loc;

-- One active/paused task per ION recurring task (allows multiple per service_location).
CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_active_per_ion_task
  ON maintenance.tasks (ion_task_id)
  WHERE status IN ('active','paused') AND ion_task_id IS NOT NULL;

-- Preserve one active/paused MANUAL (non-ION) task per service_location.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_open_per_loc_manual
  ON maintenance.tasks (service_location_id)
  WHERE status IN ('active','paused') AND ion_task_id IS NULL;

CREATE INDEX IF NOT EXISTS tasks_ion_task_id ON maintenance.tasks (ion_task_id) WHERE ion_task_id IS NOT NULL;

COMMENT ON COLUMN maintenance.tasks.ion_task_id IS
  'The ION recurring-task id this task represents (1:1). NULL for manual/non-ION '
  'tasks. Replaces the one-open-task-per-location model so multi-contract '
  'communities (e.g. POOL MAINTENANCE + CHEMICAL TESTING at one address) get one '
  'task per contract. Set by f/ION/_lib/upsert_tasks and the split migration.';
