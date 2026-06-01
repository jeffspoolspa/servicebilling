-- Hard gate: an invoice is only `payment_method_ok` if we re-verified the
-- customer's PMs from QBO AFTER the invoice synced. Without this we could
-- charge an invoice using PM data that pre-dates the invoice itself —
-- e.g., customer added an ACH in QBO between invoice creation and our
-- next PM sweep, but we'd already cached "no PM on file" and would still
-- bill them via email. The COKER MIKE case showed exactly this failure mode.
--
-- Mechanism is three pieces:
--
-- 1. `compute_payment_method_ok` now requires Customers.pm_last_checked_at
--    >= invoices.fetched_at. NULL pm_last_checked_at always fails (never
--    checked). This is the actual gate.
--
-- 2. A new trigger on Customers AFTER UPDATE OF pm_last_checked_at
--    recomputes payment_method_ok for that customer's open invoices the
--    moment their PMs get refreshed. Without this the gate would only
--    re-evaluate when the invoice itself changes — meaning a sweep that
--    finally fetched a customer's PMs wouldn't unblock their invoices.
--
-- 3. The existing trg_set_payment_method_ok_from_invoice gets extended to
--    fire on UPDATE OF fetched_at too. When QBO re-syncs an invoice, its
--    fetched_at bumps; the new gate makes that invoice not-OK until the
--    next PM refresh confirms freshness. We also extend the invoice
--    trigger that fires the Windmill webhook to fire on the same UPDATE,
--    so a re-synced invoice automatically queues a fresh PM check.
--
-- All three trigger paths converge: any invoice's payment_method_ok
-- accurately reflects "we have verified this customer's PMs since the
-- last time this invoice changed." Processing scripts already gate on
-- payment_method_ok via billing_status projection.

------------------------------------------------------------------------------
-- 1. Freshness check in the gate
------------------------------------------------------------------------------

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

  -- Freshness gate: PMs must have been re-verified AFTER the invoice synced.
  -- A NULL pm_last_checked_at means we have never checked this customer's
  -- PMs and can't tell whether the resolved PM (or absence of one) reflects
  -- current QBO state.
  IF v_pm_last_checked IS NULL OR v_pm_last_checked < v_invoice_fetched THEN
    RETURN false;
  END IF;

  -- Resolution check (unchanged): SOME billable PM (or explicit email path).
  RETURN v_pm = 'invoice'
      OR v_target_id IS NOT NULL
      OR v_preferred_type IS NOT NULL;
END;
$function$;

------------------------------------------------------------------------------
-- 2. Recompute invoice gate when Customer.pm_last_checked_at moves
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.fn_recompute_pm_ok_on_customer_pm_check()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Recompute for every open invoice for this customer. The downstream
  -- trg_project_billing_status_on_indicator_change picks up the
  -- payment_method_ok change and adjusts billing_status accordingly.
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

------------------------------------------------------------------------------
-- 3a. Re-fire the invoice-side payment_method_ok recompute on fetched_at too
------------------------------------------------------------------------------

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

------------------------------------------------------------------------------
-- 3b. Fire PM-refresh webhook on invoice UPDATE OF fetched_at too, not just
--     INSERT. When QBO re-syncs an invoice we want the customer's PMs
--     re-verified so the freshness gate can re-open. The 60s dedup in the
--     function still protects against bursts.
------------------------------------------------------------------------------

-- Split INSERT + UPDATE into two triggers: a WHEN clause on a trigger that
-- fires for both INSERT and UPDATE can't reference OLD (OLD doesn't exist
-- on INSERT). Both call the same function — the dedup window inside it
-- collapses bursts of either operation.
DROP TRIGGER IF EXISTS trg_request_pm_refresh_on_invoice_insert ON billing.invoices;

CREATE TRIGGER trg_request_pm_refresh_on_invoice_insert
AFTER INSERT ON billing.invoices
FOR EACH ROW
WHEN (NEW.qbo_customer_id IS NOT NULL)
EXECUTE FUNCTION billing.fn_request_pm_refresh_on_invoice_insert();

CREATE TRIGGER trg_request_pm_refresh_on_invoice_fetched_update
AFTER UPDATE OF fetched_at ON billing.invoices
FOR EACH ROW
WHEN (NEW.qbo_customer_id IS NOT NULL
      AND OLD.fetched_at IS DISTINCT FROM NEW.fetched_at)
EXECUTE FUNCTION billing.fn_request_pm_refresh_on_invoice_insert();

------------------------------------------------------------------------------
-- 4. One-shot recompute over open invoices so the new gate takes effect now.
--    Idempotent in the steady state we just verified (all 139 open invoices
--    have pm_last_checked_at >= fetched_at as of the cleanup sweep).
------------------------------------------------------------------------------

UPDATE billing.invoices
   SET payment_method_ok = billing.compute_payment_method_ok(qbo_invoice_id)
 WHERE billing_status != 'processed'
   AND qbo_customer_id IS NOT NULL;
