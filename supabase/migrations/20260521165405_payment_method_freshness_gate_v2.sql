-- BACKFILLED 2026-05-26 from supabase_migrations.schema_migrations.
-- This migration was applied to the live DB on 2026-05-21 16:54 UTC but the
-- file was never committed to the repo. Recovered verbatim from the
-- statements column. See AUDIT_2026-05-26.md for context on the drift.
--
-- HISTORICAL NOTE: This v2 implementation has since been identified as the
-- root cause of a $2,500 compute spike on 2026-05-23/24/25. The "self-healing
-- loop" assumption broke because refresh_open_invoices bulk-updates fetched_at
-- on every open invoice every 4h, firing the trigger ~100 times per scheduled
-- run before any async script could update pm_last_checked_at to satisfy the
-- 60s dedup. A follow-up migration on 2026-05-26 reverts this design — see
-- 20260526000001_drop_pm_refresh_on_fetched_update.sql.

-- Re-introduce the freshness gate on payment_method_ok. This time the
-- script-side has 429 retry (deployed in the previous step), so the
-- burst-loss case that left invoices permanently stuck no longer applies:
-- a stale invoice triggers a webhook, the webhook retries through 429s
-- if needed, eventually bumps pm_last_checked_at, and the customer-side
-- trigger below flips payment_method_ok back true. Self-healing loop.

CREATE OR REPLACE FUNCTION billing.compute_payment_method_ok(p_qbo_invoice_id text)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  v_pm                text;
  v_target_id         uuid;
  v_preferred_type    text;
  v_customer_id       text;
  v_invoice_fetched   timestamptz;
  v_pm_last_checked   timestamptz;
BEGIN
  SELECT i.payment_method, i.target_payment_method_id, i.preferred_payment_type,
         i.qbo_customer_id, i.fetched_at, c.pm_last_checked_at
    INTO v_pm, v_target_id, v_preferred_type,
         v_customer_id, v_invoice_fetched, v_pm_last_checked
    FROM billing.invoices i
    LEFT JOIN public."Customers" c ON c.qbo_customer_id = i.qbo_customer_id
   WHERE i.qbo_invoice_id = p_qbo_invoice_id;

  IF v_customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_pm_last_checked IS NULL OR v_pm_last_checked < v_invoice_fetched THEN
    RETURN false;
  END IF;

  RETURN v_pm = 'invoice'
      OR v_target_id IS NOT NULL
      OR v_preferred_type IS NOT NULL;
END;
$function$;

-- Customer-side cascade: when the sweep bumps pm_last_checked_at, every
-- open invoice for that customer auto-recomputes its gate. That's how
-- invoices return to ready_to_process after a refresh completes.
CREATE OR REPLACE FUNCTION billing.fn_recompute_pm_ok_on_customer_pm_check()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE billing.invoices
     SET payment_method_ok = billing.compute_payment_method_ok(qbo_invoice_id)
   WHERE qbo_customer_id = NEW.qbo_customer_id
     AND billing_status  != 'processed';
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_recompute_pm_ok_on_customer_pm_check ON public."Customers";
CREATE TRIGGER trg_recompute_pm_ok_on_customer_pm_check
AFTER UPDATE OF pm_last_checked_at ON public."Customers"
FOR EACH ROW
WHEN (NEW.pm_last_checked_at IS DISTINCT FROM OLD.pm_last_checked_at)
EXECUTE FUNCTION billing.fn_recompute_pm_ok_on_customer_pm_check();

-- Invoice-side: extend the existing trigger to fire on fetched_at changes too.
-- That way when QBO re-syncs an invoice and the freshness window resets,
-- payment_method_ok flips false → billing_status → needs_review →
-- pg_net trigger fires webhook → script (with 429 retry) → bumps
-- pm_last_checked_at → customer trigger above flips back to true.
DROP TRIGGER IF EXISTS trg_set_payment_method_ok_from_invoice ON billing.invoices;
CREATE TRIGGER trg_set_payment_method_ok_from_invoice
AFTER UPDATE OF payment_method, target_payment_method_id, preferred_payment_type, fetched_at
ON billing.invoices
FOR EACH ROW
WHEN (
  OLD.payment_method            IS DISTINCT FROM NEW.payment_method
  OR OLD.target_payment_method_id IS DISTINCT FROM NEW.target_payment_method_id
  OR OLD.preferred_payment_type   IS DISTINCT FROM NEW.preferred_payment_type
  OR OLD.fetched_at               IS DISTINCT FROM NEW.fetched_at
)
EXECUTE FUNCTION billing.fn_set_payment_method_ok_from_invoice();

-- One-shot recompute over open invoices. The 2 currently-stale invoices
-- will move to needs_review; the pg_net trigger already fired for them
-- (or the next invoice update will), and the script with 429 retry will
-- now succeed, flipping them back through the cascade.
UPDATE billing.invoices
   SET payment_method_ok = billing.compute_payment_method_ok(qbo_invoice_id)
 WHERE billing_status != 'processed'
   AND qbo_customer_id IS NOT NULL;
