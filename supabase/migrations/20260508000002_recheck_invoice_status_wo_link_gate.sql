-- Defense-in-depth: refuse to touch billing_status on invoices that don't
-- belong to the service-billing pipeline (no billable, non-skipped WO link).
-- Centralizes the rule in one place so every fan-out trigger inherits it.
--
-- Without this gate, a maintenance autopay invoice could have its
-- billing_status mutated by recheck if a customer_payments row changed or
-- an invoice column updated. The 164 stuck invoices we recently drained
-- happened to escape this only because their customers had no recent
-- payment activity AND no relevant column change while in a promotable
-- state. That's luck, not architecture.
--
-- This is a defensive precursor to the full indicator-column decomposition
-- (next migration). Both layers will keep the gate.

CREATE OR REPLACE FUNCTION billing.recheck_invoice_status(p_qbo_invoice_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_inv                 billing.invoices%ROWTYPE;
  v_wo_sub_total        numeric;
  v_invoice_subtotal    numeric;
  v_credit_count        int;
  v_credit_sum          numeric;
  v_new_subtotal_ok     boolean;
  v_has_credit_review   boolean;
  v_preserved_str       text;
  v_new_reasons         text[];
  v_new_reason          text;
  v_new_status          text;
  v_updated             jsonb;
  v_changed             boolean;
BEGIN
  SELECT * INTO v_inv
  FROM billing.invoices
  WHERE qbo_invoice_id = p_qbo_invoice_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'invoice not found');
  END IF;

  -- WO-link gate: this invoice must have a billable, non-skipped linked WO
  -- to participate in the service-billing pipeline. Maintenance autopay
  -- invoices and other non-WO invoices live in their own pipelines and
  -- their billing_status is not ours to set.
  IF NOT EXISTS (
    SELECT 1 FROM public.work_orders w
     WHERE w.qbo_invoice_id = p_qbo_invoice_id
       AND w.billable     = true
       AND w.skipped_at IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'status', 'noop',
      'reason', 'not_in_service_billing_pipeline',
      'invoice', to_jsonb(v_inv)
    );
  END IF;

  -- Terminal state: never demote back to review.
  IF v_inv.billing_status = 'processed' THEN
    RETURN jsonb_build_object(
      'status', 'noop',
      'reason', 'already_processed',
      'invoice', to_jsonb(v_inv)
    );
  END IF;

  v_invoice_subtotal := v_inv.subtotal;

  SELECT sub_total INTO v_wo_sub_total
  FROM public.work_orders
  WHERE qbo_invoice_id = p_qbo_invoice_id
  ORDER BY wo_number
  LIMIT 1;

  IF v_wo_sub_total IS NULL OR v_invoice_subtotal IS NULL THEN
    v_new_subtotal_ok := v_inv.subtotal_ok;
  ELSE
    v_new_subtotal_ok := abs(v_wo_sub_total - v_invoice_subtotal) < 0.02;
  END IF;

  SELECT COUNT(*)::int, COALESCE(SUM(unapplied_amt), 0)
  INTO v_credit_count, v_credit_sum
  FROM billing.customer_payments
  WHERE qbo_customer_id = v_inv.qbo_customer_id
    AND unapplied_amt > 0
    AND (txn_date IS NULL OR txn_date >= CURRENT_DATE - INTERVAL '180 days')
    AND (memo IS NULL OR memo !~* 'maint');

  v_has_credit_review := v_credit_count > 0
    AND v_inv.credit_review_overridden_at IS NULL;

  v_preserved_str := COALESCE(v_inv.needs_review_reason, '');
  v_preserved_str := regexp_replace(
    v_preserved_str,
    'credit_review \(\d+ unmatched credit\(s\), \$[\d,\.]+ unapplied\)',
    '', 'g'
  );
  v_preserved_str := regexp_replace(
    v_preserved_str,
    'subtotal_mismatch \(WO \$[\d,\.]+ vs QBO \$[\d,\.]+\)',
    '', 'g'
  );
  v_preserved_str := regexp_replace(
    v_preserved_str,
    '(^|, )subtotal_mismatch(, |$)',
    '\1\2', 'g'
  );
  v_preserved_str := regexp_replace(v_preserved_str, '(, ){2,}', ', ', 'g');
  v_preserved_str := regexp_replace(v_preserved_str, '^(,\s*)+', '', 'g');
  v_preserved_str := regexp_replace(v_preserved_str, '(\s*,)+\s*$', '', 'g');
  v_preserved_str := trim(v_preserved_str);

  v_new_reasons := ARRAY[]::text[];
  IF v_preserved_str IS NOT NULL AND length(v_preserved_str) > 0 THEN
    v_new_reasons := v_new_reasons || v_preserved_str;
  END IF;

  IF v_wo_sub_total IS NOT NULL AND v_invoice_subtotal IS NOT NULL
     AND NOT v_new_subtotal_ok THEN
    v_new_reasons := v_new_reasons ||
      format('subtotal_mismatch (WO $%s vs QBO $%s)',
             to_char(v_wo_sub_total, 'FM999999.00'),
             to_char(v_invoice_subtotal, 'FM999999.00'));
  END IF;

  IF v_has_credit_review THEN
    v_new_reasons := v_new_reasons ||
      format('credit_review (%s unmatched credit(s), $%s unapplied)',
             v_credit_count,
             to_char(v_credit_sum, 'FM999999.00'));
  END IF;

  IF array_length(v_new_reasons, 1) IS NULL THEN
    v_new_reason := NULL;
  ELSE
    v_new_reason := array_to_string(v_new_reasons, ', ');
  END IF;

  IF v_inv.pre_processed_at IS NULL THEN
    v_new_status := COALESCE(v_inv.billing_status, 'awaiting_pre_processing');
  ELSIF v_new_reason IS NULL AND v_inv.enrichment_ok IS TRUE THEN
    v_new_status := 'ready_to_process';
  ELSE
    v_new_status := 'needs_review';
  END IF;

  v_changed := (v_inv.billing_status IS DISTINCT FROM v_new_status)
            OR (v_inv.needs_review_reason IS DISTINCT FROM v_new_reason)
            OR (v_inv.subtotal_ok IS DISTINCT FROM v_new_subtotal_ok);

  IF v_changed THEN
    UPDATE billing.invoices
    SET needs_review_reason = v_new_reason,
        subtotal_ok         = v_new_subtotal_ok,
        billing_status      = v_new_status
    WHERE qbo_invoice_id = p_qbo_invoice_id
    RETURNING to_jsonb(billing.invoices.*) INTO v_updated;
  ELSE
    v_updated := to_jsonb(v_inv);
  END IF;

  RETURN jsonb_build_object(
    'status',              'ok',
    'changed',             v_changed,
    'prev_billing_status', v_inv.billing_status,
    'new_billing_status',  v_new_status,
    'prev_reason',         v_inv.needs_review_reason,
    'new_reason',          v_new_reason,
    'credit_count',        v_credit_count,
    'credit_sum',          v_credit_sum,
    'invoice',             v_updated
  );
END;
$function$;
