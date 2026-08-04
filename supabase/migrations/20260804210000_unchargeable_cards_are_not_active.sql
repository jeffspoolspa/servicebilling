-- A card we cannot charge is not active: fold expiry and same-card supersession
-- into the one flag the whole billing path already reads.
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- Prompted by "add duplicate detection" after the public card-collection form
-- went live. Measuring first changed the answer.
--
-- Duplicates are rare: exactly ONE same-card pair in 1,029 cards. But it is not
-- a double-submit — it is customer 2568 (MOJICA, JASON) re-entering the same
-- Discover ···2530 with a new expiry when the old one ran out. A renewal.
--
-- The bigger problem was sitting next to it. QBO reports a card as `status:
-- ACTIVE` forever; it does not retire expired cards, and `fetch()` in
-- f/billing/_lib/payment_methods filters on exactly that flag. So as of
-- 2026-08-04:
--
--     1,029 cards on file
--        63 expired
--        60 of those still marked usable
--        17 customers whose DEFAULT payment method is an expired card
--
-- Those 17 are queued to decline. Nothing in the system knew, because
-- `is_active` meant "QBO still lists it" rather than "we can charge it".
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- Everything downstream already routes off `is_active`:
--   - fn_maintain_default_pm picks the newest is_active card as the default
--   - pick_target_payment_method requires is_active
--   - fn_set_payment_method_ok_from_cpm derives payment_method_ok from it
--
-- So this does NOT add a parallel "expired" concept for every caller to
-- remember. It extends the existing rule that a card can be inactive for
-- reasons QBO knows nothing about — the precedent is
-- fn_user_deactivation_wins, which already forces is_active = false when a
-- human deactivates a card ("a human's decision outranks QBO's"). Expiry and
-- supersession are the same shape: facts QBO ignores that make a card
-- unchargeable.
--
-- 1. billing.pm_expires_on(raw) — the last day a card is good. IMMUTABLE and a
--    pure function of the QBO payload, so it can be indexed and there is exactly
--    one definition of "when does this card die".
--
-- 2. fn_user_deactivation_wins gains two clauses. Order matters: a human's
--    reactivation must not resurrect a card that is expired or superseded.
--
-- 3. Supersession keys on `raw->>'numberSHA512'`, QBO's own hash of the card
--    number — the same physical card across renewals, without this database
--    ever seeing a PAN. The entry that EXPIRES LATEST wins (created date is only
--    the tiebreak); see the note in the function for why ranking on created date
--    strands a customer with no usable card.
--
-- 4. pick_target_payment_method ALSO excludes expired cards directly. Belt and
--    braces on purpose: the trigger only re-evaluates when a row is written, so
--    a card that expires between refreshes is briefly stale in the table. The
--    charge path must never hand QBO a dead card even for that window.
--
-- ─────────────────────────────────────────────────────────────────
-- WHAT WE KEEP / WHAT WE LOSE
-- ─────────────────────────────────────────────────────────────────
-- Rows are never deleted — an expired or superseded card stays on file with its
-- charge history, it just stops being selectable. `deactivated_at` still means
-- "a human turned this off" and is untouched; expiry is inferred, not recorded,
-- so a card cannot get stuck "expired" if QBO later corrects the date.
--
-- We deliberately do NOT block the vault from creating a duplicate in QBO.
-- QBO permits it, we cannot prevent it from our side, and dedup at the point of
-- USE is what actually protects billing.

-- 1. When does this card stop being good? (last day of its expiry month)
CREATE OR REPLACE FUNCTION billing.pm_expires_on(p_raw jsonb)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_raw->>'expYear' ~ '^\d{4}$' AND p_raw->>'expMonth' ~ '^\d{1,2}$'
         AND (p_raw->>'expMonth')::int BETWEEN 1 AND 12
    THEN (make_date((p_raw->>'expYear')::int, (p_raw->>'expMonth')::int, 1)
          + interval '1 month' - interval '1 day')::date
  END;
$$;

COMMENT ON FUNCTION billing.pm_expires_on(jsonb) IS
  'Last day a card on file is chargeable, from the QBO payload. NULL when the '
  'payload has no usable expiry (ACH, or malformed) — callers must treat NULL '
  'as "no expiry known", never as expired.';

-- 2. Unchargeable => not active. Extends the human-deactivation rule.
CREATE OR REPLACE FUNCTION billing.fn_user_deactivation_wins()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
declare
  v_expires date := billing.pm_expires_on(new.raw);
begin
  if new.deactivated_at is not null then
    new.is_active := false;                       -- a human said no
  elsif tg_op = 'UPDATE' and old.deactivated_at is not null then
    new.is_active := true;                        -- ...and then said yes again
  end if;

  -- QBO keeps reporting expired cards as ACTIVE; it does not retire them. An
  -- expired card is not chargeable no matter who says otherwise, so this is
  -- checked AFTER the reactivation branch above.
  if v_expires is not null and v_expires < current_date then
    new.is_active := false;
  end if;

  -- Superseded by another entry for the SAME physical card that lives longer
  -- (numberSHA512 is QBO's hash of the number, so a reissue re-entered with a
  -- new expiry matches its predecessor).
  if new.raw->>'numberSHA512' is not null
     and exists (
       select 1 from billing.customer_payment_methods m
        where m.qbo_customer_id = new.qbo_customer_id
          and m.qbo_payment_method_id <> new.qbo_payment_method_id
          and m.raw->>'numberSHA512' = new.raw->>'numberSHA512'
          and (
            -- Rank by EXPIRY, not by when the entry was created. The two agree
            -- in the normal case (a reissue is added after the card it
            -- replaces), but re-adding the same number with an OLD expiry — a
            -- mistyped date, or a card already replaced — makes the newest
            -- entry the shortest-lived one. Keying on `created` there would
            -- deactivate the good card AND the new one (expired), leaving the
            -- customer with nothing usable while holding a valid card.
            billing.pm_expires_on(m.raw) > v_expires
            or (billing.pm_expires_on(m.raw) is not distinct from v_expires
                and coalesce(m.raw->>'created', '') > coalesce(new.raw->>'created', ''))
          )
     )
  then
    new.is_active := false;
  end if;

  return new;
end $function$;

-- 3. The charge path refuses an expired card even if the row is stale.
CREATE OR REPLACE FUNCTION billing.pick_target_payment_method(
  p_qbo_customer_id text, p_preferred_type text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE v_pm_id uuid;
BEGIN
  IF p_preferred_type IS NULL OR p_preferred_type = 'email' THEN RETURN NULL; END IF;

  SELECT id INTO v_pm_id
    FROM billing.customer_payment_methods
   WHERE qbo_customer_id = p_qbo_customer_id
     AND is_active = true
     AND deactivated_at IS NULL
     AND is_default = true
     AND type = p_preferred_type
     AND (billing.pm_expires_on(raw) IS NULL OR billing.pm_expires_on(raw) >= current_date)
   ORDER BY (raw->>'created') DESC NULLS LAST, fetched_at DESC
   LIMIT 1;

  IF v_pm_id IS NOT NULL THEN RETURN v_pm_id; END IF;

  SELECT id INTO v_pm_id
    FROM billing.customer_payment_methods
   WHERE qbo_customer_id = p_qbo_customer_id
     AND is_active = true
     AND deactivated_at IS NULL
     AND is_default = true
     AND (billing.pm_expires_on(raw) IS NULL OR billing.pm_expires_on(raw) >= current_date)
   ORDER BY (raw->>'created') DESC NULLS LAST, fetched_at DESC
   LIMIT 1;

  RETURN v_pm_id;
END;
$function$;

-- 4. Apply the rule to rows already on file.
--
--    `SET is_active = is_active` looks pointless but is load-bearing:
--    trg_maintain_default_pm is AFTER UPDATE **OF is_active**, and Postgres fires
--    that on the columns named in SET, not on whether a value actually changed.
--    Touching fetched_at instead would flip is_active via the BEFORE trigger and
--    then never recompute the default — the 17 customers would keep pointing at
--    a dead card.
--
--    Scoped to only the rows whose is_active should flip (~64), not all 1,029:
--    every touched row also fires fn_resolve_pm_on_cpm_change, and there is no
--    reason to re-resolve invoices for cards that are fine.
UPDATE billing.customer_payment_methods
   SET is_active = is_active
 WHERE type = 'credit_card'
   AND is_active = true
   AND (
     billing.pm_expires_on(raw) < current_date
     OR EXISTS (
       SELECT 1 FROM billing.customer_payment_methods m
        WHERE m.qbo_customer_id = customer_payment_methods.qbo_customer_id
          AND m.qbo_payment_method_id <> customer_payment_methods.qbo_payment_method_id
          AND m.raw->>'numberSHA512' = customer_payment_methods.raw->>'numberSHA512'
          AND coalesce(m.raw->>'created','') > coalesce(customer_payment_methods.raw->>'created','')
     )
   );

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
-- Expect 0 rows from each of these after the backfill:
--
--   -- no expired card is still usable
--   SELECT count(*) FROM billing.customer_payment_methods
--    WHERE is_active AND deactivated_at IS NULL
--      AND billing.pm_expires_on(raw) < current_date;
--
--   -- no customer's default is an expired card
--   SELECT count(*) FROM billing.customer_payment_methods
--    WHERE is_default AND billing.pm_expires_on(raw) < current_date;
--
--   -- no two active rows for the same physical card
--   SELECT qbo_customer_id, raw->>'numberSHA512'
--     FROM billing.customer_payment_methods
--    WHERE is_active AND raw->>'numberSHA512' IS NOT NULL
--    GROUP BY 1,2 HAVING count(*) > 1;
