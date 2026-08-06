-- Queues ALWAYS self-drain (ADR 008). schedule_change_queue was the one that
-- did not: it relied on the publish BUTTON poking an endpoint from the
-- browser, so a swallowed fetch or a closed tab left rows sitting — every row
-- on 2026-08-05 had started_at null, four times over.
--
-- STATEMENT-level, per the 706k postmortem: one wake per statement, never per
-- row. A 17-pool publish inserts 17 rows and must wake the drainer once.
CREATE OR REPLACE FUNCTION maintenance.wake_schedule_change_queue()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'maintenance', 'public'
AS $$
DECLARE
  v_url text;
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'routing_drain_url' LIMIT 1;
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'routing_operator_token' LIMIT 1;
  IF v_url IS NULL OR v_token IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM net.http_post(
    url     := v_url,
    body    := '{"wake":true}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    timeout_milliseconds := 5000
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;  -- wake is best-effort by design
END;
$$;

DROP TRIGGER IF EXISTS trg_wake_schedule_change_queue ON maintenance.schedule_change_queue;
CREATE TRIGGER trg_wake_schedule_change_queue
  AFTER INSERT ON maintenance.schedule_change_queue
  FOR EACH STATEMENT EXECUTE FUNCTION maintenance.wake_schedule_change_queue();
