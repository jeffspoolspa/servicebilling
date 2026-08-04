-- The tick wakes the app DIRECTLY (pg_net -> /api/billing/tick) instead of
-- relaying through Windmill: the app door accepts the SHARED machine token
-- (WINDMILL_TOKEN, already in Vercel env), per the one-shared-token rule.
-- Vault secrets 'billing_tick_url' + 'billing_tick_token' arm the wake;
-- absent, the tick still enqueues (correctness half) and the wake is skipped.
CREATE OR REPLACE FUNCTION billing.tick_nightly()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'billing', 'public'
AS $$
DECLARE
  v_url text;
  v_token text;
BEGIN
  PERFORM billing.enqueue_billing_months(
    ARRAY(SELECT id FROM billing.v_active_months), 3);

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'billing_tick_url' LIMIT 1;
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'billing_tick_token' LIMIT 1;
  IF v_url IS NULL OR v_token IS NULL THEN
    RETURN;  -- unarmed: queue holds the work; the next tick always comes
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
  NULL;  -- wake is best-effort by design; the enqueue already happened
END;
$$;
