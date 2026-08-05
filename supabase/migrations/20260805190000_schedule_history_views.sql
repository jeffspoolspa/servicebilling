-- Schedule history, read from the event stream rather than a second table.
-- A task fact names its customer and techs as participants, so one stream
-- answers "this pool's schedule history" and "this customer's schedule
-- history" without duplicating anything.
CREATE OR REPLACE VIEW maintenance.v_schedule_history AS
SELECT
  e.seq, e.occurred_at, e.aggregate_id::uuid AS task_id, e.type, e.actor,
  NULLIF(split_part((SELECT p FROM unnest(e.participants) p WHERE p LIKE 'customer:%' LIMIT 1), ':', 2), '') AS ion_cust_id,
  NULLIF(split_part((SELECT p FROM unnest(e.participants) p WHERE p LIKE 'scenario:%' LIMIT 1), ':', 2), '') AS scenario_id,
  e.payload->>'kind' AS kind, e.payload->'requested' AS requested,
  e.payload->>'startsOn' AS starts_on, e.payload->>'endsOn' AS ends_on,
  e.payload->>'detail' AS detail, e.payload
FROM maintenance.events e
WHERE e.aggregate = 'task'
  AND e.type IN ('ScheduleChangeRequested','ScheduleChanged','ScheduleChangeFailed');

COMMENT ON VIEW maintenance.v_schedule_history IS
  'Every schedule change asked for and every outcome, per task, with the customer lifted out of participants. The history log behind a task page and a customer page.';

-- The WAL made actionable: a change we ASKED ION for that never reported an
-- outcome — a crash mid-batch, or a close that landed while its create did
-- not, leaving a customer with no live task.
CREATE OR REPLACE VIEW maintenance.v_schedule_changes_open AS
WITH req AS (
  SELECT aggregate_id, seq, occurred_at, payload,
         (SELECT p FROM unnest(participants) p WHERE p LIKE 'customer:%' LIMIT 1) AS cust
  FROM maintenance.events WHERE aggregate = 'task' AND type = 'ScheduleChangeRequested'
), outcome AS (
  SELECT aggregate_id, seq FROM maintenance.events
  WHERE aggregate = 'task' AND type IN ('ScheduleChanged','ScheduleChangeFailed')
)
SELECT r.aggregate_id::uuid AS task_id, r.occurred_at AS requested_at,
       NULLIF(split_part(r.cust, ':', 2), '') AS ion_cust_id,
       r.payload->>'kind' AS kind, r.payload->>'startsOn' AS starts_on,
       r.payload->>'endsOn' AS ends_on,
       EXTRACT(epoch FROM (now() - r.occurred_at))/60 AS minutes_open
FROM req r
WHERE NOT EXISTS (SELECT 1 FROM outcome o WHERE o.aggregate_id = r.aggregate_id AND o.seq > r.seq);

COMMENT ON VIEW maintenance.v_schedule_changes_open IS
  'Requested schedule changes with no outcome yet. Non-empty after a run means a change is in flight or was lost mid-batch — a supersede whose close landed without its create needs a human.';

GRANT SELECT ON maintenance.v_schedule_history TO authenticated, service_role;
GRANT SELECT ON maintenance.v_schedule_changes_open TO authenticated, service_role;
