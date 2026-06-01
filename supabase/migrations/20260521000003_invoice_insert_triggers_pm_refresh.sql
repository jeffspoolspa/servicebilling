-- Fire a PM-refresh webhook the moment a new invoice lands in billing.invoices,
-- so the existing trg_resolve_pm_on_cpm_change cascade can flip the invoice's
-- target_payment_method_id before anyone tries to charge it.
--
-- Previously the only path that wrote rows into billing.customer_payment_methods
-- was the 4-hourly sweep, which (a) required the customer to already have a
-- billable invoice with the OLD invoice_number gate and (b) could lag by up to
-- 4h. Both contributed to COKER MIKE (6254) sitting with no PM data despite
-- having an ACH on file in QBO for 9 days.
--
-- Mechanism:
--   1. pg_net lets a Postgres function fire HTTP without blocking the calling
--      transaction. Requests go into net.http_request_queue and are picked up
--      by Supabase's background worker.
--   2. supabase_vault stores the Windmill API token so it's not in source.
--      The token is inserted out-of-band (see comment below for the SELECT
--      vault.create_secret invocation Carter ran via MCP).
--   3. AFTER INSERT trigger on billing.invoices reads the secret, posts to
--      the Windmill webhook for pull_customer_payment_methods with the new
--      invoice's qbo_customer_id, via the only_customer_id arg added in
--      20260521000002.
--
-- Dedup: a burst of inserts for the same customer (e.g. QBO sync writing 30
-- invoices for one big commercial customer) must NOT fire 30 webhook calls.
-- We skip the trigger if the customer was PM-checked within the last 60s
-- (Customers.pm_last_checked_at).
--
-- Failure mode: if the HTTP call fails (Windmill down, token expired, network
-- blip) we silently no-op. The daily backstop schedule catches anything missed.
-- We NEVER want a PM-refresh failure to roll back an invoice insert.

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- Token: reuses the existing shared `windmill_token` Vault secret (registered
-- 2026-04-14) — the canonical token for ANY DB-trigger that fans out to
-- Windmill scripts. One place to rotate; one place to audit.

CREATE OR REPLACE FUNCTION billing.fn_request_pm_refresh_on_invoice_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_recent       boolean;
  v_token        text;
  v_webhook_url  constant text :=
    'https://app.windmill.dev/api/w/jps-internal/jobs/run/p/f/service_billing/pull_customer_payment_methods';
BEGIN
  IF NEW.qbo_customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Dedup window. Same-customer invoice insert within 60s of the last
  -- successful PM check is a no-op (the prior fetch already covers this
  -- customer's PMs).
  SELECT pm_last_checked_at > (now() - interval '60 seconds')
    INTO v_recent
    FROM public."Customers"
   WHERE qbo_customer_id = NEW.qbo_customer_id;

  IF COALESCE(v_recent, false) THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_token
    FROM vault.decrypted_secrets
   WHERE name = 'windmill_token'
   LIMIT 1;

  -- No token configured — silently no-op. Daily backstop will catch this.
  -- Better than erroring and blocking invoice ingestion.
  IF v_token IS NULL THEN
    RETURN NEW;
  END IF;

  -- Fire and forget. pg_net queues; the response goes into net._http_response
  -- and we don't read it. If the call fails the daily backstop is the safety net.
  PERFORM net.http_post(
    url     := v_webhook_url,
    body    := jsonb_build_object('only_customer_id', NEW.qbo_customer_id),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Content-Type',  'application/json'
    ),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_request_pm_refresh_on_invoice_insert
AFTER INSERT ON billing.invoices
FOR EACH ROW
EXECUTE FUNCTION billing.fn_request_pm_refresh_on_invoice_insert();
