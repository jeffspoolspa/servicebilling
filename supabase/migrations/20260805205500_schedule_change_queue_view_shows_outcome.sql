-- The client watches this row instead of holding a connection open. It could
-- see 'done' but not WHAT was done, so the successor comes through too: the
-- UI confirms the new contract by id rather than trusting a state word.
drop view if exists maintenance.v_schedule_change_queue;
create view maintenance.v_schedule_change_queue as
  select id, task_id, scenario_id, priority, received_at, started_at, attempts, error,
         case
           when finished_at is not null then 'done'
           when attempts >= 3 then 'dead_letter'
           when started_at is not null then 'in_flight'
           else 'queued'
         end as state,
         round(extract(epoch from now() - received_at) / 60::numeric, 1) as minutes_waiting,
         finished_at, ion_task_id, result_ion_task_id, result_task_id
    from maintenance.schedule_change_queue q;

grant select on maintenance.v_schedule_change_queue to authenticated;
