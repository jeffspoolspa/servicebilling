-- Reconcile is_default drift, and expose expiry as a column.
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- Surfaced while applying 20260804210000 (unchargeable cards). The invariant
-- billing.fn_maintain_default_pm exists to hold — exactly one usable default per
-- customer — was not actually holding on data already on file:
--
--     22 customers carried MORE THAN ONE is_default row
--      2 defaulted to a card that is not usable
--      6 had a usable card but NO default at all
--
-- That last group is the one that cost money: billing.pick_target_payment_method
-- requires is_default = true, so six customers with a perfectly good card on file
-- were resolving to nothing and falling through to email.
--
-- The drift is pre-existing, not caused by the expiry rule. The expiry backfill
-- only made it visible: it skipped rows that were already is_active = false, so
-- a stale is_default on an already-inactive row (Stanberry, QBO 8747) stayed put.
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- 1. Re-fire fn_maintain_default_pm for the affected customers. It already
--    computes the right answer; it had simply never run since the drift appeared.
--    `SET is_active = is_active` is what re-fires it — the trigger is
--    AFTER UPDATE **OF is_active**, and Postgres keys that on the SET list, not
--    on a value actually changing. One row per customer suffices: the function
--    rewrites is_default across all of that customer's rows in one pass.
--
-- 2. expires_on as a STORED generated column. "Expired" and "removed in QBO"
--    both land as is_active = false but call for different action — ask the
--    customer for a new card, versus it was deleted upstream — and the payment
--    methods UI could not tell them apart without it. Generated rather than
--    trigger-maintained because billing.pm_expires_on is IMMUTABLE and a pure
--    function of `raw`, so the column cannot drift from its source.

-- 1. Reconcile.
UPDATE billing.customer_payment_methods
   SET is_active = is_active
 WHERE id IN (
   SELECT DISTINCT ON (qbo_customer_id) id
     FROM billing.customer_payment_methods
    WHERE qbo_customer_id IN (
      SELECT qbo_customer_id
        FROM billing.customer_payment_methods
       GROUP BY qbo_customer_id
      HAVING count(*) FILTER (WHERE is_default) > 1
          OR count(*) FILTER (WHERE is_default AND (NOT is_active OR deactivated_at IS NOT NULL)) > 0
          OR (count(*) FILTER (WHERE is_default) = 0
              AND count(*) FILTER (WHERE is_active AND deactivated_at IS NULL) > 0)
    )
    ORDER BY qbo_customer_id, (raw->>'created') DESC NULLS LAST, fetched_at DESC
 );

-- 2. Expiry as a first-class column.
ALTER TABLE billing.customer_payment_methods
  ADD COLUMN IF NOT EXISTS expires_on date
  GENERATED ALWAYS AS (billing.pm_expires_on(raw)) STORED;

COMMENT ON COLUMN billing.customer_payment_methods.expires_on IS
  'Last day this card is chargeable, derived from raw. NULL for ACH or a payload '
  'without a usable expiry — NULL means "no expiry known", not "expired".';

CREATE INDEX IF NOT EXISTS customer_payment_methods_expires_on_idx
  ON billing.customer_payment_methods (expires_on)
  WHERE expires_on IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
-- Verified 2026-08-04 — all five return 0:
--   expired but still usable; default is expired; same physical card active
--   twice; more than one default per customer; usable card but no default.
--
-- And the resolver still returns a card for healthy customers (QBO 7657, 2568,
-- 8747 all resolve). 18 customers are left with no usable card at all — that is
-- correct, their cards are genuinely expired, and it is the call list for the
-- card-collection link.
