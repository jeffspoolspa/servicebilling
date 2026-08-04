-- HONESTY PASS (Carter 2026-08-04): the tick IS just a wake. The route
-- re-derives all work from billing.v_active_months itself (startMonth,
-- advanceAll, the issue pass) — queue rows enqueued here fed nothing, so
-- the enqueue is gone. pg_cron -> one POST; the month queue remains the
-- dispute-heal and button channel it always was.
CREATE OR REPLACE FUNCTION billing.tick_nightly()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'billing', 'public'
AS $$
DECLARE
  v_url text;
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'billing_tick_url' LIMIT 1;
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'billing_tick_token' LIMIT 1;
  IF v_url IS NULL OR v_token IS NULL THEN
    RETURN;  -- unarmed
  END IF;
  PERFORM net.http_post(
    url     := v_url,
    body    := jsonb_build_object('tick', true),
    headers := jsonb_build_object(
      'x-drain-token', v_token,
      'Content-Type', 'application/json'),
    timeout_milliseconds := 8000
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;
