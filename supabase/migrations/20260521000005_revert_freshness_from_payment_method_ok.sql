-- Revert: payment_method_ok goes back to "PM is resolved" only.
--
-- The 20260521000004 freshness gate was too aggressive — it demoted 24 open
-- invoices with valid cards on file to needs_review just because the
-- customer's pm_last_checked_at predated the invoice. Carter's actual
-- requirement is "verify PM freshness right before charging," not "block
-- the invoice from being visible in the queue."
--
-- So payment_method_ok stays a pure resolution check (the original
-- compute), and we add a separate helper function
-- billing.invoice_pm_freshness_status(qbo_invoice_id) that processing
-- scripts call right before charging — returning 'fresh' | 'stale' |
-- 'never_checked' | 'unknown'. The charge script can then run
-- pull_customer_payment_methods(only_customer_id=…) inline if not fresh.
--
-- The pg_net trigger that fires a Windmill webhook on invoice
-- INSERT/UPDATE OF fetched_at stays in place — that keeps PMs continuously
-- refreshed in the background, so by the time anyone hits "process," the
-- helper almost always returns 'fresh' without needing the inline refresh.

CREATE OR REPLACE FUNCTION billing.compute_payment_method_ok(p_qbo_invoice_id text)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  v_pm                text;
  v_target_id         uuid;
  v_preferred_type    text;
  v_customer_id       text;
BEGIN
  SELECT payment_method, target_payment_method_id, preferred_payment_type, qbo_customer_id
    INTO v_pm, v_target_id, v_preferred_type, v_customer_id
    FROM billing.invoices WHERE qbo_invoice_id = p_qbo_invoice_id;

  IF v_customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN v_pm = 'invoice'
      OR v_target_id IS NOT NULL
      OR v_preferred_type IS NOT NULL;
END;
$function$;

-- Drop the customer-side trigger + function — they only mattered for the
-- freshness gate. The trigger that fires the Windmill PM refresh webhook
-- (trg_request_pm_refresh_on_invoice_*) stays — that's still the live path.
DROP TRIGGER IF EXISTS trg_recompute_pm_ok_on_customer_pm_check ON public."Customers";
DROP FUNCTION IF EXISTS billing.fn_recompute_pm_ok_on_customer_pm_check();

-- Revert trg_set_payment_method_ok_from_invoice to its pre-freshness fields.
DROP TRIGGER IF EXISTS trg_set_payment_method_ok_from_invoice ON billing.invoices;
CREATE TRIGGER trg_set_payment_method_ok_from_invoice
AFTER UPDATE OF payment_method, target_payment_method_id, preferred_payment_type
ON billing.invoices
FOR EACH ROW
WHEN (
  OLD.payment_method            IS DISTINCT FROM NEW.payment_method
  OR OLD.target_payment_method_id IS DISTINCT FROM NEW.target_payment_method_id
  OR OLD.preferred_payment_type   IS DISTINCT FROM NEW.preferred_payment_type
)
EXECUTE FUNCTION billing.fn_set_payment_method_ok_from_invoice();

-- Helper for processing scripts to call right before charging.
-- Returns: 'fresh' | 'stale' | 'never_checked' | 'unknown'.
CREATE OR REPLACE FUNCTION billing.invoice_pm_freshness_status(p_qbo_invoice_id text)
RETURNS text
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  v_invoice_fetched timestamptz;
  v_pm_last_checked timestamptz;
BEGIN
  SELECT i.fetched_at, c.pm_last_checked_at
    INTO v_invoice_fetched, v_pm_last_checked
    FROM billing.invoices i
    LEFT JOIN public."Customers" c ON c.qbo_customer_id = i.qbo_customer_id
   WHERE i.qbo_invoice_id = p_qbo_invoice_id;

  IF v_invoice_fetched IS NULL THEN RETURN 'unknown'; END IF;
  IF v_pm_last_checked IS NULL THEN RETURN 'never_checked'; END IF;
  IF v_pm_last_checked < v_invoice_fetched THEN RETURN 'stale'; END IF;
  RETURN 'fresh';
END;
$function$;

COMMENT ON FUNCTION billing.invoice_pm_freshness_status(text) IS
  'Per-invoice PM freshness status for processing scripts to gate on. '
  'Call right before charging. Values: fresh | stale | never_checked | unknown. '
  'If not fresh, run pull_customer_payment_methods with only_customer_id '
  'first, then re-check.';

-- Lift the freshness false-flags by recomputing payment_method_ok over
-- every open invoice. The downstream
-- trg_project_billing_status_on_indicator_change automatically moves
-- billing_status from needs_review back to ready_to_process for any
-- invoice whose payment_method_ok flips true.
UPDATE billing.invoices
   SET payment_method_ok = billing.compute_payment_method_ok(qbo_invoice_id)
 WHERE billing_status != 'processed'
   AND qbo_customer_id IS NOT NULL;
