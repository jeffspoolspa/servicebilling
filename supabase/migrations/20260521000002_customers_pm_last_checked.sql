-- Track when the QBO Payments sweep last checked a customer for cards/ACH,
-- regardless of whether any methods came back.
--
-- Background: pull_customer_payment_methods used to gate its TTL skip on
-- whether the customer already had a row in billing.customer_payment_methods
-- (`fetched_at > now() - 4hr`). That worked for customers with at least one
-- saved method, but customers with no PMs on file never get a row — so they
-- were either (a) re-fetched every cycle (waste) or (b) excluded from the
-- sweep entirely via the now-removed `invoice_number IS NOT NULL` gate.
--
-- We now sweep every active QBO-linked customer (so newly-added cards/ACH
-- show up before the customer has a billable invoice). To keep that bounded,
-- we anchor the TTL on the customer itself: pm_last_checked_at is bumped on
-- every successful QBO call (including the "QBO returned no methods" case),
-- and NOT bumped when the QBO call itself failed — so a transient 429/500
-- naturally retries next sweep instead of silently looking like "this
-- customer has no methods on file" for 4 hours.

ALTER TABLE public."Customers"
  ADD COLUMN IF NOT EXISTS pm_last_checked_at timestamptz NULL;

COMMENT ON COLUMN public."Customers".pm_last_checked_at IS
  'Last time pull_customer_payment_methods successfully queried QBO Payments '
  'for this customer (whether or not any cards/ACH were returned). NULL = '
  'never checked. Used as the TTL gate by the sweep so customers with no PMs '
  'on file are not re-fetched every cycle.';

-- Partial index drives the sweep selector. NULLS FIRST so customers that
-- have never been checked sort to the front of the queue on the next run.
CREATE INDEX IF NOT EXISTS customers_pm_last_checked_at_idx
  ON public."Customers" (pm_last_checked_at NULLS FIRST)
  WHERE qbo_customer_id IS NOT NULL
    AND is_active = true
    AND deleted_at IS NULL;
