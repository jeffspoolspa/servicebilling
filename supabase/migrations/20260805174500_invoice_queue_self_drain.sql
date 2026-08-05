-- Queues ALWAYS self-drain (ADR 008): a row in billing.invoice_queue means
-- "safe to process", so landing rows wakes the drainer. STATEMENT-level
-- (the 706k postmortem: one wake per statement, never per row); pg_net
-- direct to the app's machine door via the same vault secrets as the tick;
-- best-effort — the nightly tick remains the liveness backstop.
-- (The vault url secret billing_invoice_drain_url was created at apply
-- time; create_secret is not repeated here to keep the migration rerunnable.)
CREATE OR REPLACE FUNCTION billing.wake_invoice_queue()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'billing', 'public'
AS $$
DECLARE
  v_url text;
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'billing_invoice_drain_url' LIMIT 1;
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'billing_tick_token' LIMIT 1;
  IF v_url IS NULL OR v_token IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM net.http_post(
    url     := v_url,
    body    := '{"wake":true}'::jsonb,
    headers := jsonb_build_object('x-drain-token', v_token, 'Content-Type', 'application/json'),
    timeout_milliseconds := 5000
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;  -- wake is best-effort by design
END;
$$;

DROP TRIGGER IF EXISTS trg_wake_invoice_queue ON billing.invoice_queue;
CREATE TRIGGER trg_wake_invoice_queue
  AFTER INSERT ON billing.invoice_queue
  FOR EACH STATEMENT EXECUTE FUNCTION billing.wake_invoice_queue();
