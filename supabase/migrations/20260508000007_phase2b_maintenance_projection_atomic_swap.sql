-- Phase 2B: Per-source maintenance triggers + projection trigger.
-- Atomic swap with the legacy recheck triggers in one transaction.
--
-- Architecture (after this migration):
--   - 7 maintenance triggers, each watches one source mutation and writes
--     ONE specific indicator column on billing.invoices.
--   - 1 projection trigger watches the 5 indicator columns + pre_processed_at
--     and writes billing_status + needs_review_reason.
--   - billing_status and needs_review_reason are owned EXCLUSIVELY by the
--     projection function. No external script writes them directly
--     (pre_process will be slimmed in a follow-up to honor this).
--   - recheck_invoice_status remains as a thin compat shim for the 2
--     Windmill scripts (refresh_payment, refresh_invoice) that call it
--     directly.

------------------------------------------------------------------------------
-- compute_billing_status — pure function returning (status, reason)
-- given current state of an invoice. Read-only.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.compute_billing_status(p_qbo_invoice_id text)
RETURNS TABLE(billing_status text, needs_review_reason text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_inv               billing.invoices%ROWTYPE;
  v_has_wo_link       boolean;
  v_reasons           text[];
  v_wo_subtotal       numeric;
  v_credit_count      int;
  v_credit_sum        numeric;
  v_attempt_status    text;
  v_attempt_error     text;
BEGIN
  SELECT * INTO v_inv FROM billing.invoices WHERE qbo_invoice_id = p_qbo_invoice_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.work_orders w
     WHERE w.qbo_invoice_id = p_qbo_invoice_id
       AND w.billable     = true
       AND w.skipped_at IS NULL
  ) INTO v_has_wo_link;

  IF NOT v_has_wo_link THEN
    billing_status := v_inv.billing_status;
    needs_review_reason := v_inv.needs_review_reason;
    RETURN NEXT; RETURN;
  END IF;

  IF v_inv.billing_status = 'processed' THEN
    billing_status := v_inv.billing_status;
    needs_review_reason := v_inv.needs_review_reason;
    RETURN NEXT; RETURN;
  END IF;

  IF v_inv.pre_processed_at IS NULL THEN
    billing_status := 'awaiting_pre_processing';
    needs_review_reason := NULL;
    RETURN NEXT; RETURN;
  END IF;

  v_reasons := ARRAY[]::text[];

  IF v_inv.subtotal_ok IS NOT TRUE THEN
    SELECT sub_total INTO v_wo_subtotal
      FROM public.work_orders WHERE qbo_invoice_id = p_qbo_invoice_id
      ORDER BY wo_number LIMIT 1;
    IF v_wo_subtotal IS NOT NULL AND v_inv.subtotal IS NOT NULL THEN
      v_reasons := v_reasons || format(
        'subtotal_mismatch (WO $%s vs QBO $%s)',
        to_char(v_wo_subtotal, 'FM999999.00'),
        to_char(v_inv.subtotal, 'FM999999.00')
      );
    ELSE
      v_reasons := array_append(v_reasons, 'subtotal_mismatch');
    END IF;
  END IF;

  IF v_inv.credits_ok IS NOT TRUE THEN
    SELECT COUNT(*)::int, COALESCE(SUM(unapplied_amt), 0)
      INTO v_credit_count, v_credit_sum
      FROM billing.customer_payments
      WHERE qbo_customer_id = v_inv.qbo_customer_id
        AND unapplied_amt > 0
        AND (txn_date IS NULL OR txn_date >= CURRENT_DATE - INTERVAL '180 days')
        AND (memo IS NULL OR memo !~* 'maint')
        AND (v_inv.credit_review_overridden_at IS NULL OR txn_date IS NULL
             OR txn_date > v_inv.credit_review_overridden_at::date);
    IF v_credit_count > 0 THEN
      v_reasons := v_reasons || format(
        'credit_review (%s unmatched credit(s), $%s unapplied)',
        v_credit_count, to_char(v_credit_sum, 'FM999999.00')
      );
    ELSE
      v_reasons := array_append(v_reasons, 'credit_review');
    END IF;
  END IF;

  IF v_inv.payment_method_ok IS NOT TRUE THEN
    v_reasons := array_append(v_reasons, 'no_payment_method');
  END IF;

  IF v_inv.attempts_ok IS NOT TRUE THEN
    SELECT status, LEFT(COALESCE(error_message, ''), 200)
      INTO v_attempt_status, v_attempt_error
      FROM billing.processing_attempts
      WHERE qbo_invoice_id = p_qbo_invoice_id AND stage = 'process'
      ORDER BY attempted_at DESC LIMIT 1;
    IF v_attempt_status IS NOT NULL THEN
      IF v_attempt_error IS NOT NULL AND length(v_attempt_error) > 0 THEN
        v_reasons := v_reasons || format('%s (%s)', v_attempt_status, v_attempt_error);
      ELSE
        v_reasons := array_append(v_reasons, v_attempt_status);
      END IF;
    ELSE
      v_reasons := array_append(v_reasons, 'prior_attempt_blocked');
    END IF;
  END IF;

  IF v_inv.enrichment_ok IS NOT TRUE THEN
    v_reasons := array_append(v_reasons, 'enrichment_failed');
  END IF;

  IF array_length(v_reasons, 1) IS NULL THEN
    billing_status := 'ready_to_process';
    needs_review_reason := NULL;
  ELSE
    billing_status := 'needs_review';
    needs_review_reason := array_to_string(v_reasons, ', ');
  END IF;
  RETURN NEXT;
END;
$$;

------------------------------------------------------------------------------
-- project_billing_status — public wrapper that writes the projected
-- (status, reason). Idempotent. Safe to call from triggers, backfills,
-- ad-hoc SQL.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.project_billing_status(p_qbo_invoice_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_result    record;
  v_inv       billing.invoices%ROWTYPE;
  v_changed   boolean;
BEGIN
  SELECT * INTO v_result FROM billing.compute_billing_status(p_qbo_invoice_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'invoice not found');
  END IF;

  SELECT * INTO v_inv FROM billing.invoices WHERE qbo_invoice_id = p_qbo_invoice_id;

  v_changed := (v_inv.billing_status      IS DISTINCT FROM v_result.billing_status)
            OR (v_inv.needs_review_reason IS DISTINCT FROM v_result.needs_review_reason);

  IF v_changed THEN
    UPDATE billing.invoices
       SET billing_status      = v_result.billing_status,
           needs_review_reason = v_result.needs_review_reason
     WHERE qbo_invoice_id = p_qbo_invoice_id;
  END IF;

  RETURN jsonb_build_object(
    'status',              'ok',
    'changed',             v_changed,
    'prev_billing_status', v_inv.billing_status,
    'new_billing_status',  v_result.billing_status,
    'prev_reason',         v_inv.needs_review_reason,
    'new_reason',          v_result.needs_review_reason
  );
END;
$$;

------------------------------------------------------------------------------
-- The 7 per-source maintenance triggers
------------------------------------------------------------------------------

-- 1. fn_set_subtotal_ok_from_wo: WO sub_total changed → recompute subtotal_ok
CREATE OR REPLACE FUNCTION billing.fn_set_subtotal_ok_from_wo()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.qbo_invoice_id IS NULL
     OR NEW.billable IS NOT TRUE
     OR NEW.skipped_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  UPDATE billing.invoices
     SET subtotal_ok = billing.compute_subtotal_ok(NEW.qbo_invoice_id)
   WHERE qbo_invoice_id = NEW.qbo_invoice_id
     AND billing_status != 'processed';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_subtotal_ok_from_wo ON public.work_orders;
CREATE TRIGGER trg_set_subtotal_ok_from_wo
AFTER UPDATE OF sub_total ON public.work_orders
FOR EACH ROW
WHEN (OLD.sub_total IS DISTINCT FROM NEW.sub_total)
EXECUTE FUNCTION billing.fn_set_subtotal_ok_from_wo();

-- 2. fn_set_subtotal_ok_from_invoice: invoice subtotal changed
CREATE OR REPLACE FUNCTION billing.fn_set_subtotal_ok_from_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_status = 'processed' THEN RETURN NEW; END IF;
  UPDATE billing.invoices
     SET subtotal_ok = billing.compute_subtotal_ok(NEW.qbo_invoice_id)
   WHERE qbo_invoice_id = NEW.qbo_invoice_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_subtotal_ok_from_invoice ON billing.invoices;
CREATE TRIGGER trg_set_subtotal_ok_from_invoice
AFTER UPDATE OF subtotal ON billing.invoices
FOR EACH ROW
WHEN (OLD.subtotal IS DISTINCT FROM NEW.subtotal)
EXECUTE FUNCTION billing.fn_set_subtotal_ok_from_invoice();

-- 3. fn_set_credits_ok_from_payment: customer_payments change → fan-out per
-- linked invoice for that customer, recompute credits_ok
CREATE OR REPLACE FUNCTION billing.fn_set_credits_ok_from_payment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_customer_id text := COALESCE(NEW.qbo_customer_id, OLD.qbo_customer_id);
  v_inv_id      text;
BEGIN
  IF v_customer_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  FOR v_inv_id IN
    SELECT i.qbo_invoice_id
      FROM billing.invoices i
      JOIN public.work_orders w ON w.qbo_invoice_id = i.qbo_invoice_id
     WHERE i.qbo_customer_id = v_customer_id
       AND i.billing_status != 'processed'
       AND w.billable    = true
       AND w.skipped_at IS NULL
  LOOP
    UPDATE billing.invoices
       SET credits_ok = billing.compute_credits_ok(v_inv_id)
     WHERE qbo_invoice_id = v_inv_id;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_set_credits_ok_from_payment ON billing.customer_payments;
CREATE TRIGGER trg_set_credits_ok_from_payment
AFTER INSERT OR UPDATE OF unapplied_amt, txn_date, memo OR DELETE
ON billing.customer_payments
FOR EACH ROW
EXECUTE FUNCTION billing.fn_set_credits_ok_from_payment();

-- 4. fn_set_credits_ok_from_override: human flipped credit_review_overridden_at
CREATE OR REPLACE FUNCTION billing.fn_set_credits_ok_from_override()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_status = 'processed' THEN RETURN NEW; END IF;
  UPDATE billing.invoices
     SET credits_ok = billing.compute_credits_ok(NEW.qbo_invoice_id)
   WHERE qbo_invoice_id = NEW.qbo_invoice_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_credits_ok_from_override ON billing.invoices;
CREATE TRIGGER trg_set_credits_ok_from_override
AFTER UPDATE OF credit_review_overridden_at ON billing.invoices
FOR EACH ROW
WHEN (OLD.credit_review_overridden_at IS DISTINCT FROM NEW.credit_review_overridden_at)
EXECUTE FUNCTION billing.fn_set_credits_ok_from_override();

-- 5. fn_set_payment_method_ok_from_invoice: invoice PM cols changed
CREATE OR REPLACE FUNCTION billing.fn_set_payment_method_ok_from_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_status = 'processed' THEN RETURN NEW; END IF;
  UPDATE billing.invoices
     SET payment_method_ok = billing.compute_payment_method_ok(NEW.qbo_invoice_id)
   WHERE qbo_invoice_id = NEW.qbo_invoice_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_payment_method_ok_from_invoice ON billing.invoices;
CREATE TRIGGER trg_set_payment_method_ok_from_invoice
AFTER UPDATE OF payment_method, target_payment_method_id, preferred_payment_type
ON billing.invoices
FOR EACH ROW
WHEN (
  OLD.payment_method            IS DISTINCT FROM NEW.payment_method            OR
  OLD.target_payment_method_id  IS DISTINCT FROM NEW.target_payment_method_id  OR
  OLD.preferred_payment_type    IS DISTINCT FROM NEW.preferred_payment_type
)
EXECUTE FUNCTION billing.fn_set_payment_method_ok_from_invoice();

-- 6. fn_set_payment_method_ok_from_cpm: customer_payment_methods change
CREATE OR REPLACE FUNCTION billing.fn_set_payment_method_ok_from_cpm()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_customer_id text := COALESCE(NEW.qbo_customer_id, OLD.qbo_customer_id);
  v_inv_id      text;
BEGIN
  IF v_customer_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  FOR v_inv_id IN
    SELECT i.qbo_invoice_id
      FROM billing.invoices i
      JOIN public.work_orders w ON w.qbo_invoice_id = i.qbo_invoice_id
     WHERE i.qbo_customer_id = v_customer_id
       AND i.billing_status != 'processed'
       AND w.billable    = true
       AND w.skipped_at IS NULL
  LOOP
    UPDATE billing.invoices
       SET payment_method_ok = billing.compute_payment_method_ok(v_inv_id)
     WHERE qbo_invoice_id = v_inv_id;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_set_payment_method_ok_from_cpm ON billing.customer_payment_methods;
CREATE TRIGGER trg_set_payment_method_ok_from_cpm
AFTER INSERT OR UPDATE OF is_active OR DELETE
ON billing.customer_payment_methods
FOR EACH ROW
EXECUTE FUNCTION billing.fn_set_payment_method_ok_from_cpm();

-- 7. fn_set_attempts_ok_from_attempt: processing_attempts insert/update
CREATE OR REPLACE FUNCTION billing.fn_set_attempts_ok_from_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_inv_id text := COALESCE(NEW.qbo_invoice_id, OLD.qbo_invoice_id);
  v_stage  text := COALESCE(NEW.stage, OLD.stage);
BEGIN
  IF v_stage IS DISTINCT FROM 'process' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF v_inv_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  UPDATE billing.invoices
     SET attempts_ok = billing.compute_attempts_ok(v_inv_id)
   WHERE qbo_invoice_id = v_inv_id
     AND billing_status != 'processed';
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_set_attempts_ok_from_attempt ON billing.processing_attempts;
CREATE TRIGGER trg_set_attempts_ok_from_attempt
AFTER INSERT OR UPDATE OF status
ON billing.processing_attempts
FOR EACH ROW
EXECUTE FUNCTION billing.fn_set_attempts_ok_from_attempt();

------------------------------------------------------------------------------
-- The projection trigger — fires when any indicator (or pre_processed_at)
-- actually changes value. Watches columns the projection does NOT write,
-- so no recursion.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.fn_project_billing_status_on_indicator_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing.project_billing_status(NEW.qbo_invoice_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_billing_status_on_indicator_change ON billing.invoices;
CREATE TRIGGER trg_project_billing_status_on_indicator_change
AFTER UPDATE OF subtotal_ok, credits_ok, payment_method_ok, attempts_ok,
                enrichment_ok, pre_processed_at
ON billing.invoices
FOR EACH ROW
WHEN (
  OLD.subtotal_ok       IS DISTINCT FROM NEW.subtotal_ok       OR
  OLD.credits_ok        IS DISTINCT FROM NEW.credits_ok        OR
  OLD.payment_method_ok IS DISTINCT FROM NEW.payment_method_ok OR
  OLD.attempts_ok       IS DISTINCT FROM NEW.attempts_ok       OR
  OLD.enrichment_ok     IS DISTINCT FROM NEW.enrichment_ok     OR
  OLD.pre_processed_at  IS DISTINCT FROM NEW.pre_processed_at
)
EXECUTE FUNCTION billing.fn_project_billing_status_on_indicator_change();

------------------------------------------------------------------------------
-- Drop the legacy recheck triggers + functions
------------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_recheck_credits_on_payment_change ON billing.customer_payments;
DROP TRIGGER IF EXISTS trg_recheck_on_invoice_change         ON billing.invoices;
DROP TRIGGER IF EXISTS trg_recheck_on_wo_sub_total_change    ON public.work_orders;

DROP FUNCTION IF EXISTS billing.fn_recheck_credits_on_payment_change();
DROP FUNCTION IF EXISTS billing.fn_recheck_on_invoice_change();
DROP FUNCTION IF EXISTS billing.fn_recheck_on_wo_sub_total_change();
DROP FUNCTION IF EXISTS billing.fn_recheck_on_credit_review_override();

------------------------------------------------------------------------------
-- Replace recheck_invoice_status with a thin compat shim. The 2 Windmill
-- scripts (refresh_payment.py, refresh_invoice.py) keep working unchanged.
-- Internally the shim runs bootstrap_indicators which fires the projection
-- via the trigger.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.recheck_invoice_status(p_qbo_invoice_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_inv billing.invoices%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM billing.invoices WHERE qbo_invoice_id = p_qbo_invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'invoice not found');
  END IF;

  PERFORM billing.bootstrap_indicators(p_qbo_invoice_id);

  RETURN jsonb_build_object(
    'status',  'ok',
    'note',    'compat shim — bootstrap_indicators + projection ran via triggers',
    'invoice', (SELECT to_jsonb(i.*) FROM billing.invoices i
                 WHERE i.qbo_invoice_id = p_qbo_invoice_id)
  );
END;
$$;
