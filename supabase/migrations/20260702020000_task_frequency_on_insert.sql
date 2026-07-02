-- Close the frequency edge: a new task that never receives task_schedules rows (e.g. QC one-offs
-- captured by orphan recovery with no tech assigned) would keep frequency NULL even when ION's
-- recurrence text is present -- the recalc trigger lives on task_schedules and never fires for it.
-- Fix: recalc on task INSERT too (recalc_task_frequency already falls back to the recurrence text).
-- INSERT-only, so the recalc's own UPDATE cannot re-fire it (no recursion).

create or replace function maintenance.tasks_freq_on_insert_trigger()
returns trigger
language plpgsql
as $$
begin
  perform maintenance.recalc_task_frequency(new.id);
  return null;
end
$$;

drop trigger if exists tasks_freq_on_insert on maintenance.tasks;
create trigger tasks_freq_on_insert
  after insert on maintenance.tasks
  for each row execute function maintenance.tasks_freq_on_insert_trigger();
