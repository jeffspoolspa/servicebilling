-- A supersede cannot be recorded as done without naming the successor it
-- created. This is the exact shape of the 2026-08-05 failure: the close
-- landed, the create did not, and nothing refused to call it finished.
--
-- Proof on BOTH sides (ION id AND cache row) is the goal, but result_task_id
-- stays nullable until the publish path creates the successor's cache row —
-- today only TaskService.supersedeTask does. A constraint no code path can
-- satisfy is an outage, not a safety net.
alter table maintenance.schedule_change_queue
  drop constraint if exists schedule_change_succeeded_has_proof;

alter table maintenance.schedule_change_queue
  add constraint schedule_change_succeeded_names_successor check (
    finished_at is null
    or error is not null
    or result_ion_task_id is not null
  );

create or replace function maintenance.finish_schedule_change(
  p_id uuid,
  p_error text default null,
  p_result_ion_task_id text default null,
  p_result_task_id uuid default null
) returns void language sql as $function$
  UPDATE maintenance.schedule_change_queue
     SET finished_at = CASE WHEN p_error IS NULL THEN now() ELSE NULL END,
         error = p_error,
         result_ion_task_id = COALESCE(p_result_ion_task_id, result_ion_task_id),
         result_task_id = COALESCE(p_result_task_id, result_task_id)
   WHERE id = p_id
$function$;
