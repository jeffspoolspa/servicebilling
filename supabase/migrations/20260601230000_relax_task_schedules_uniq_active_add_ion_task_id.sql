-- Relax maintenance.task_schedules_uniq_active to include ion_task_id.
--
-- The old partial unique index was
--   UNIQUE (task_id, day_of_week, frequency)
--   WHERE active AND day_of_week IS NOT NULL AND frequency IS NOT NULL
-- It predates the recurring-task + schedule syncs (f/ION/_lib/upsert_tasks,
-- f/ION/_lib/upsert_schedules) that now stamp every slot with its real
-- ion_task_id (the stable ION task identity from taskList.cfm).
--
-- A maintenance.task can legitimately bundle multiple ION tasks at one
-- service_location (the "merged" multi-task-location shape; one OPEN task per
-- loc is enforced separately by tasks_one_open_per_loc). Those distinct ION
-- tasks -- e.g. POOL MAINTENANCE plus a QUALITY CONTROL or CHEMICAL TESTING
-- task -- are often scheduled on the SAME weekday at the same cadence. The old
-- index forbade that (only one (task, day, freq) slot per task), which forced
-- the schedule_slots sync to skip the second service's day.
--
-- Now that every active slot carries an ion_task_id (verified: 0 active slots
-- with NULL ion_task_id), the correct grain is per ION task: a task may repeat
-- a (day, frequency) as long as it is a DIFFERENT ion_task_id. A single ION
-- task still cannot duplicate a (day, frequency) active slot.
--
-- Verified before migrating: 0 existing active rows violate the new key.

DROP INDEX IF EXISTS maintenance.task_schedules_uniq_active;

CREATE UNIQUE INDEX task_schedules_uniq_active
  ON maintenance.task_schedules (task_id, day_of_week, frequency, ion_task_id)
  WHERE (active
         AND day_of_week IS NOT NULL
         AND frequency IS NOT NULL
         AND ion_task_id IS NOT NULL);
