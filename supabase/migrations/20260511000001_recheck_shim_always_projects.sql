-- Phase 2B follow-up: the compat shim must always invoke projection,
-- not just rely on an indicator-change trigger.
--
-- Bug:
--   The Phase 2B recheck_invoice_status compat shim called bootstrap_indicators
--   and assumed the projection trigger would fire from indicator changes.
--   But the trigger has WHEN (... IS DISTINCT FROM ...) gates on the 5
--   indicator columns, so when bootstrap rewrote indicators to the SAME
--   value (very common — bootstrap is idempotent), the trigger short-
--   circuited and projection never ran.
--
-- Real-world hit:
--   User opens triage on an invoice in needs_review for charge_declined
--   (attempts_ok=false, all other indicators true). They edit the memo
--   and click Save Edits. push_invoice_edits writes:
--     needs_review_reason = NULL    -- the user's "clear it" intent
--     enrichment_ok       = true    -- already true; not a change
--   then calls recheck_invoice_status(). bootstrap rewrites indicators
--   to identical values; trigger doesn't fire. Result:
--     billing_status      = 'needs_review' (unchanged from before)
--     needs_review_reason = NULL (just written, never re-derived)
--   → invoice shows up in the Needs Review queue with empty reason column.
--
-- Fix:
--   Shim explicitly calls project_billing_status() after bootstrap.
--   project_billing_status is itself idempotent — only writes if
--   billing_status or needs_review_reason actually differ. So the cost
--   when nothing changed is one extra read + comparison.

CREATE OR REPLACE FUNCTION billing.recheck_invoice_status(p_qbo_invoice_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_inv         billing.invoices%ROWTYPE;
  v_proj_result jsonb;
BEGIN
  SELECT * INTO v_inv FROM billing.invoices WHERE qbo_invoice_id = p_qbo_invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'invoice not found');
  END IF;

  -- Re-derive all 4 trigger-owned indicators from current source state.
  PERFORM billing.bootstrap_indicators(p_qbo_invoice_id);

  -- Explicitly project. Bootstrap might not have fired the trigger if no
  -- indicator value actually changed, but we still want billing_status +
  -- needs_review_reason to reflect current truth (e.g., when an external
  -- writer cleared needs_review_reason and we need to rebuild it).
  v_proj_result := billing.project_billing_status(p_qbo_invoice_id);

  RETURN jsonb_build_object(
    'status',     'ok',
    'note',       'compat shim — bootstrap + project ran',
    'projection', v_proj_result,
    'invoice',    (SELECT to_jsonb(i.*) FROM billing.invoices i
                    WHERE i.qbo_invoice_id = p_qbo_invoice_id)
  );
END;
$$;
