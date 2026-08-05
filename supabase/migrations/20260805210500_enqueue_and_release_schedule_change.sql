-- Two finish_schedule_change overloads existed after the outcome columns
-- landed; PostgREST cannot choose between them. One signature only.
drop function if exists maintenance.finish_schedule_change(uuid, text);

-- Asking for a change is now a WRITE, not a wait. The row outlives the
-- connection that created it: on 2026-08-05 a browser gave up on work the
-- server had half-finished and nothing retried.
create or replace function maintenance.enqueue_schedule_change(
  p_task_id uuid, p_scenario_id uuid default null, p_ion_task_id text default null,
  p_intent jsonb default '{}'::jsonb, p_priority smallint default 5
) returns uuid language plpgsql security definer
set search_path = maintenance, public as $function$
declare v_id uuid;
begin
  insert into maintenance.schedule_change_queue
    (task_id, scenario_id, ion_task_id, intent, priority)
  values (p_task_id, p_scenario_id, p_ion_task_id, p_intent, p_priority)
  on conflict (task_id) where finished_at is null
  do update set
    scenario_id = excluded.scenario_id,
    ion_task_id = coalesce(excluded.ion_task_id, maintenance.schedule_change_queue.ion_task_id),
    intent      = excluded.intent,
    priority    = least(maintenance.schedule_change_queue.priority, excluded.priority),
    attempts    = 0,
    error       = null
  returning id into v_id;
  return v_id;
end $function$;

grant execute on function maintenance.enqueue_schedule_change(uuid, uuid, text, jsonb, smallint) to authenticated;

-- attempts counts failures of OUR making. A dry run is a rehearsal: it takes
-- the row, writes nothing, and must leave the budget as it found it. Three
-- rehearsals used to dead-letter work that had never been tried once.
create or replace function maintenance.release_schedule_change(p_id uuid)
returns void language sql security definer
set search_path = maintenance, public as $function$
  UPDATE maintenance.schedule_change_queue
     SET started_at = null, attempts = greatest(0, attempts - 1)
   WHERE id = p_id AND finished_at IS NULL
$function$;

grant execute on function maintenance.release_schedule_change(uuid) to authenticated;
