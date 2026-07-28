-- The indicator owns failure surfacing (engines stamp nothing): the blocking
-- set must speak EVERY halt status the charge path writes, or invoices strand
-- silently in ready_to_process. Found in the 2026-07-24 ceremony sweep: the
-- engine's explicit needs_review stamps were removed in the simplification,
-- and this set only knew charge_declined/payment_orphan.
-- (Applied as 20260724131052 v2 + 20260724131209 v3 via MCP; this file is
-- the combined final state.)
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
     AND COALESCE(dry_run, false) = false
   ORDER BY attempted_at DESC
   LIMIT 1;

  IF v_last_status IS NULL THEN
    RETURN TRUE;
  END IF;

  IF v_last_status IN ('charge_declined', 'payment_orphan', 'email_failed',
                       'needs_reconcile_review', 'no_payment_method') THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;
