-- Phase 2A.1: Add the two missing indicator columns.
--
-- billing.invoices already has subtotal_ok and enrichment_ok. We're adding
-- credits_ok and payment_method_ok so that all four indicators projected
-- by billing_status live as first-class columns instead of being
-- recomputed inline by recheck_invoice_status.
--
-- Both columns are nullable. NULL means "never computed" — for processed
-- (terminal) invoices we leave them NULL (irrelevant) and for non-processed
-- invoices the backfill in 20260508000005 will populate them.
--
-- No default. No NOT NULL constraint. This makes the schema change a
-- catalog-only operation — Postgres adds the column metadata without
-- rewriting the table. On a 5k-row table the rewrite would be cheap
-- anyway, but the catalog-only approach is the safe default.

ALTER TABLE billing.invoices
  ADD COLUMN IF NOT EXISTS credits_ok        boolean,
  ADD COLUMN IF NOT EXISTS payment_method_ok boolean;

COMMENT ON COLUMN billing.invoices.credits_ok IS
  'Indicator: customer has no unmatched open credits OR a human overrode the credit review. Maintained by per-source triggers (customer_payments changes, credit_review_overridden_at changes). NULL = never computed (e.g. invoice has no WO link).';

COMMENT ON COLUMN billing.invoices.payment_method_ok IS
  'Indicator: a payment channel is settled — payment_method=invoice OR target_payment_method_id NOT NULL OR preferred_payment_type NOT NULL. Maintained by per-source triggers.';
