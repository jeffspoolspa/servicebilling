-- The queue held (task_id, scenario_id): a nudge, not an intent. The drainer
-- re-derived the supersede from the cache at drain time, so a retry could
-- compute a different answer than the one that was approved, and nothing
-- recorded WHICH ION task was to be expired.
alter table maintenance.schedule_change_queue
  add column if not exists ion_task_id text,
  add column if not exists intent jsonb not null default '{}'::jsonb,
  add column if not exists result_ion_task_id text,
  add column if not exists result_task_id uuid;

comment on column maintenance.schedule_change_queue.ion_task_id is
  'ION EventID of the contract being superseded. Fixed at enqueue.';
comment on column maintenance.schedule_change_queue.intent is
  'The computed supersede, including the predecessor form the successor inherits.';
comment on column maintenance.schedule_change_queue.result_ion_task_id is
  'ION EventID of the successor, once read-back-verified.';
comment on column maintenance.schedule_change_queue.result_task_id is
  'maintenance.tasks row for the successor. Present = the cache saw it too.';
