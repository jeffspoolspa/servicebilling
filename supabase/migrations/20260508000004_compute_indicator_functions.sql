-- Phase 2A.2: Pure compute functions for each indicator.
--
-- Each takes a qbo_invoice_id and returns the boolean indicator value
-- given the CURRENT state of all source data. They have no side effects —
-- they read, they return. This is what makes them testable in isolation
-- and safe to call from anywhere (triggers, backfills, ad-hoc SQL).
--
-- Idempotency comes for free: same source state in, same answer out.
-- No timestamps, no UUIDs, no random.

-- compute_subtotal_ok ------------------------------------------------------
CREATE OR REPLACE FUNCTION billing.compute_subtotal_ok(p_qbo_invoice_id text)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_wo_sub_total     numeric;
  v_invoice_subtotal numeric;
BEGIN
  SELECT subtotal INTO v_invoice_subtotal
    FROM billing.invoices WHERE qbo_invoice_id = p_qbo_invoice_id;

  SELECT sub_total INTO v_wo_sub_total
    FROM public.work_orders
   WHERE qbo_invoice_id = p_qbo_invoice_id
   ORDER BY wo_number LIMIT 1;

  IF v_wo_sub_total IS NULL OR v_invoice_subtotal IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN abs(v_wo_sub_total - v_invoice_subtotal) < 0.02;
END;
$$;

-- compute_credits_ok -------------------------------------------------------
CREATE OR REPLACE FUNCTION billing.compute_credits_ok(p_qbo_invoice_id text)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_customer_id        text;
  v_overridden_at      timestamptz;
  v_unmatched_count    int;
BEGIN
  SELECT qbo_customer_id, credit_review_overridden_at
    INTO v_customer_id, v_overridden_at
    FROM billing.invoices WHERE qbo_invoice_id = p_qbo_invoice_id;

  IF v_customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*) INTO v_unmatched_count
    FROM billing.customer_payments
   WHERE qbo_customer_id = v_customer_id
     AND unapplied_amt > 0
     AND (txn_date IS NULL OR txn_date >= CURRENT_DATE - INTERVAL '180 days')
     AND (memo IS NULL OR memo !~* 'maint')
     AND (v_overridden_at IS NULL OR txn_date IS NULL
          OR txn_date > v_overridden_at::date);

  RETURN v_unmatched_count = 0;
END;
$$;

-- compute_payment_method_ok ------------------------------------------------
CREATE OR REPLACE FUNCTION billing.compute_payment_method_ok(p_qbo_invoice_id text)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_pm                       text;
  v_target_id                uuid;
  v_preferred_type           text;
  v_customer_id              text;
BEGIN
  SELECT payment_method, target_payment_method_id, preferred_payment_type,
         qbo_customer_id
    INTO v_pm, v_target_id, v_preferred_type, v_customer_id
    FROM billing.invoices WHERE qbo_invoice_id = p_qbo_invoice_id;

  IF v_customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN v_pm = 'invoice'
      OR v_target_id IS NOT NULL
      OR v_preferred_type IS NOT NULL;
END;
$$;

-- bootstrap_indicators -----------------------------------------------------
-- Initial helper that writes 3 indicators in one UPDATE. The 5th indicator
-- (attempts_ok) is added in 20260508000006 which redefines this function.
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
         payment_method_ok = billing.compute_payment_method_ok(p_qbo_invoice_id)
   WHERE qbo_invoice_id = p_qbo_invoice_id;
END;
$$;
