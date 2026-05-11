-- Expose two columns through the public.billing_invoices proxy view that
-- the app reads/writes via PostgREST:
--   - target_payment_method_id — the per-invoice card override the
--     /api/billing/invoices/[id]/charge-balance route writes to
--   - attempts_unblocked_at — the trigger-maintained timestamp some UI
--     surfaces want to read for "user touched PM" detection
--
-- Without target_payment_method_id, the charge-balance API failed with:
--   "failed to set target PM: Could not find the 'target_payment_method_id'
--    column of 'billing_invoices' in the schema cache"
--
-- CREATE OR REPLACE VIEW only APPENDS columns — both new ones go at the
-- end. The view is a plain pass-through SELECT so it remains auto-
-- updatable through PostgREST.

CREATE OR REPLACE VIEW public.billing_invoices AS
SELECT
  qbo_invoice_id,
  doc_number,
  qbo_customer_id,
  customer_name,
  txn_date,
  due_date,
  total_amt,
  subtotal,
  balance,
  email_status,
  raw,
  fetched_at,
  line_items,
  billing_status,
  needs_review_reason,
  payment_method,
  qbo_class,
  memo,
  statement_memo,
  subtotal_ok,
  enrichment_ok,
  pre_processed_at,
  processed_at,
  credits_applied,
  pre_process_stage,
  memo_locked,
  credit_review_overridden_at,
  credit_review_overridden_note,
  preferred_payment_type,
  preferred_payment_type_overridden_at,
  target_payment_method_id,
  attempts_unblocked_at
FROM billing.invoices;

NOTIFY pgrst, 'reload schema';
