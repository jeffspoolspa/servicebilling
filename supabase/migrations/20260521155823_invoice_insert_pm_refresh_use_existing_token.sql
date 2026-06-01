-- BACKFILLED 2026-05-26 from supabase_migrations.schema_migrations.
-- This migration was applied to the live DB on 2026-05-21 15:58 UTC but the
-- file was never committed to the repo. Recovered verbatim from the
-- statements column. See AUDIT_2026-05-26.md for context on the drift.

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

  SELECT pm_last_checked_at > (now() - interval '60 seconds')
    INTO v_recent
    FROM public."Customers"
   WHERE qbo_customer_id = NEW.qbo_customer_id;

  IF COALESCE(v_recent, false) THEN
    RETURN NEW;
  END IF;

  -- Reuse the shared DB-webhook token registered in 2026-04-14. It's the
  -- standard secret for any trigger that fans out to Windmill scripts —
  -- one place to rotate. Bumped from per-feature secrets after this trigger
  -- nearly added a duplicate.
  SELECT decrypted_secret INTO v_token
    FROM vault.decrypted_secrets
   WHERE name = 'windmill_token'
   LIMIT 1;

  IF v_token IS NULL THEN
    RETURN NEW;
  END IF;

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

-- Clean up the per-feature token I added by mistake — the shared
-- 'windmill_token' is the canonical one.
DELETE FROM vault.secrets WHERE name = 'windmill_pm_webhook_token';
