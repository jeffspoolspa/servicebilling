-- RULED (Carter, 2026-08-04): the machine DERIVES, it does not tag.
-- collect-needed = linked-instrument ∧ open balance ∧ no charge attempt —
-- read from billing.charges and the invoice mirror, so the collect outcome
-- columns (added hours ago) go. And payment-method RESOLUTION is a QUERY,
-- not a stage: collect asks the roster live at claim time and the method
-- used lands on the charge row — so the linked_payment_method_id marker
-- goes too. preprocessed_at remains as exactly one thing: credits checked.
ALTER TABLE billing.month_invoices DROP COLUMN IF EXISTS collected_at;
ALTER TABLE billing.month_invoices DROP COLUMN IF EXISTS collect_outcome;
ALTER TABLE billing.month_invoices DROP COLUMN IF EXISTS linked_payment_method_id;
COMMENT ON COLUMN billing.month_invoices.preprocessed_at IS
  'The credit-check stage''s moment: decided credits applied. The payment route is DERIVED live from the roster at collect time, never stored here.';
