-- Phase 2B follow-up: attempts_ok should clear when the user changes
-- the payment configuration (payment_method, target_payment_method_id,
-- preferred_payment_type). The next attempt won't repeat the same charge
-- against the same card; whatever made the last attempt block is no
-- longer relevant.
--
-- Before this migration:
--   compute_attempts_ok looked only at the latest processing_attempts row.
--   If it was charge_declined or payment_orphan, attempts_ok=false. The
--   only "unblock" path was creating a brand-new attempt row by clicking
--   Re-process. But the natural user flow is to flip payment_method to
--   email-only first and THEN process — which couldn't promote out of
--   needs_review without an explicit re-process to create a fresh
--   non-blocking attempt.
--
-- After:
--   Any change to (payment_method, target_payment_method_id,
--   preferred_payment_type) stamps invoices.attempts_unblocked_at.
--   compute_attempts_ok treats the latest blocking attempt as resolved
--   when attempts_unblocked_at is more recent than its attempted_at.

------------------------------------------------------------------------------
-- 1. Column
------------------------------------------------------------------------------

ALTER TABLE billing.invoices
  ADD COLUMN IF NOT EXISTS attempts_unblocked_at timestamptz;

COMMENT ON COLUMN billing.invoices.attempts_unblocked_at IS
  'Most recent moment the user changed payment configuration (payment_method, target_payment_method_id, or preferred_payment_type). compute_attempts_ok treats blocking attempts (charge_declined / payment_orphan) as resolved when their attempted_at is older than this timestamp.';

------------------------------------------------------------------------------
-- 2. BEFORE UPDATE trigger on PM-config changes
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.fn_set_attempts_unblocked_at_on_pm_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.attempts_unblocked_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_attempts_unblocked_at_on_pm_change ON billing.invoices;
CREATE TRIGGER trg_set_attempts_unblocked_at_on_pm_change
BEFORE UPDATE OF payment_method, target_payment_method_id, preferred_payment_type
ON billing.invoices
FOR EACH ROW
WHEN (
  OLD.payment_method            IS DISTINCT FROM NEW.payment_method            OR
  OLD.target_payment_method_id  IS DISTINCT FROM NEW.target_payment_method_id  OR
  OLD.preferred_payment_type    IS DISTINCT FROM NEW.preferred_payment_type
)
EXECUTE FUNCTION billing.fn_set_attempts_unblocked_at_on_pm_change();

------------------------------------------------------------------------------
-- 3. compute_attempts_ok with timestamp resolution
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.compute_attempts_ok(p_qbo_invoice_id text)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_last_status     text;
  v_last_attempt_at timestamptz;
  v_unblocked_at    timestamptz;
BEGIN
  SELECT status, attempted_at INTO v_last_status, v_last_attempt_at
    FROM billing.processing_attempts
   WHERE qbo_invoice_id = p_qbo_invoice_id
     AND stage = 'process'
   ORDER BY attempted_at DESC
   LIMIT 1;

  -- No prior attempt → safe to attempt now.
  IF v_last_status IS NULL THEN
    RETURN TRUE;
  END IF;

  -- Last attempt is non-blocking → safe.
  IF v_last_status NOT IN ('charge_declined', 'payment_orphan') THEN
    RETURN TRUE;
  END IF;

  -- Last attempt was blocking. Check whether the user has changed
  -- payment configuration since — if so, the next attempt will use the
  -- new config and the prior block is moot.
  SELECT attempts_unblocked_at INTO v_unblocked_at
    FROM billing.invoices WHERE qbo_invoice_id = p_qbo_invoice_id;

  IF v_unblocked_at IS NOT NULL AND v_unblocked_at > v_last_attempt_at THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

------------------------------------------------------------------------------
-- 4. Backfill: invoices currently stuck at attempts_ok=false where the
--    user has already switched to email — the trigger didn't exist yet,
--    so the timestamp wasn't recorded.
------------------------------------------------------------------------------

UPDATE billing.invoices
   SET attempts_unblocked_at = now()
 WHERE attempts_ok IS FALSE
   AND payment_method = 'invoice';

------------------------------------------------------------------------------
-- 5. Force attempts_ok recompute across the pipeline so anything stuck
--    flips through the projection immediately.
------------------------------------------------------------------------------

UPDATE billing.invoices i
   SET attempts_ok = billing.compute_attempts_ok(i.qbo_invoice_id)
  FROM public.work_orders w
 WHERE w.qbo_invoice_id = i.qbo_invoice_id
   AND w.billable    = true
   AND w.skipped_at IS NULL
   AND i.billing_status IN ('awaiting_pre_processing','needs_review','ready_to_process');
