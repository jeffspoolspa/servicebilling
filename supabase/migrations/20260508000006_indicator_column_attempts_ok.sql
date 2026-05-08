-- Phase 2A.4: 5th indicator — attempts_ok.
--
-- Why this exists:
--   The 4-indicator model (subtotal_ok / credits_ok / payment_method_ok /
--   enrichment_ok) captures "is the data ready to process." It does NOT
--   capture "is a prior failed attempt blocking retry." A previously-
--   declined card with no resolution should not auto-promote back to
--   ready_to_process — re-charging the same card produces the same decline.
--
-- Rule:
--   attempts_ok = TRUE
--     UNLESS the most recent processing_attempts row (stage='process')
--     has a blocking status: 'charge_declined' or 'payment_orphan'.
--
-- Unblock path (no override column needed):
--   The user takes one of two actions, both of which create a NEW
--   processing_attempts row that supersedes the blocking one:
--     1. Change payment_method (e.g., to 'invoice') and click Re-process
--        → process_invoice runs → new attempt row → attempts_ok flips
--     2. Click Force-recharge → new attempt with NEW idempotency key →
--        attempts_ok flips
--
-- payment_orphan is also blocking. That state means a charge succeeded but
-- the QBO Payment record failed — money moved, ledger didn't. Auto-retry
-- would NOT replay the charge (idempotency key persists), but it would
-- attempt the QBO Payment record. Still, this state needs human verification
-- in QBO + Intuit before any retry — keep it blocking until a human
-- explicitly resolves via the Recover Payment UI flow.

ALTER TABLE billing.invoices
  ADD COLUMN IF NOT EXISTS attempts_ok boolean;

COMMENT ON COLUMN billing.invoices.attempts_ok IS
  'Indicator: no prior process_invoice attempt is blocking retry. FALSE when the most recent processing_attempts row (stage=process) has status charge_declined or payment_orphan. Resolved by creating a new attempt row (Re-process or Force-recharge UI flow). NULL = never computed.';

------------------------------------------------------------------------------
-- Compute function
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.compute_attempts_ok(p_qbo_invoice_id text)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_last_status text;
BEGIN
  SELECT status INTO v_last_status
    FROM billing.processing_attempts
   WHERE qbo_invoice_id = p_qbo_invoice_id
     AND stage = 'process'
   ORDER BY attempted_at DESC
   LIMIT 1;

  IF v_last_status IS NULL THEN
    RETURN TRUE;
  END IF;

  IF v_last_status IN ('charge_declined', 'payment_orphan') THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

------------------------------------------------------------------------------
-- bootstrap_indicators redefined to write 4 indicators including attempts_ok
-- (subtotal_ok / credits_ok / payment_method_ok / attempts_ok). enrichment_ok
-- remains pre_process's responsibility.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.bootstrap_indicators(p_qbo_invoice_id text)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.work_orders w
     WHERE w.qbo_invoice_id = p_qbo_invoice_id
       AND w.billable     = true
       AND w.skipped_at IS NULL
  ) THEN
    RETURN;
  END IF;

  UPDATE billing.invoices
     SET subtotal_ok       = billing.compute_subtotal_ok      (p_qbo_invoice_id),
         credits_ok        = billing.compute_credits_ok       (p_qbo_invoice_id),
         payment_method_ok = billing.compute_payment_method_ok(p_qbo_invoice_id),
         attempts_ok       = billing.compute_attempts_ok      (p_qbo_invoice_id)
   WHERE qbo_invoice_id = p_qbo_invoice_id;
END;
$$;
