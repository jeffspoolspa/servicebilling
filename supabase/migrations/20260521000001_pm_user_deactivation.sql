-- User-driven payment method deactivation, separate from QBO-driven is_active.
--
-- Problem: QBO doesn't let you delete payment methods. When a customer adds
-- an ACH for a one-time payment over their usual credit card, then asks us
-- to go back to charging the card, our resolver currently keeps picking the
-- most-recently-added active method — so it keeps trying the ACH. We need
-- a way to mark a PM as "the user said skip this one" without QBO involvement.
--
-- Design: a separate column owned exclusively by the app UI, never touched
-- by the 4-hourly sync. The sync stays the sole authority on `is_active`
-- (mirror of QBO presence); this column is the sole authority on user intent.
-- A row is "usable" iff is_active = true AND deactivated_at IS NULL.
--
-- `pull_customer_payment_methods.py` already only mentions specific columns
-- in its ON CONFLICT DO UPDATE SET clause — so adding a new column requires
-- zero changes to the script: the new column survives every sync untouched.
--
-- Both resolver functions
-- (`billing.resolve_preferred_payment_type`, `billing.pick_target_payment_method`)
-- get an extra `AND deactivated_at IS NULL` filter, mirroring how they
-- already filter on `is_active`. And the cpm-change trigger is extended
-- to fire on UPDATE OF deactivated_at so toggling the flag automatically
-- cascades through every non-overridden billable invoice for that customer,
-- same way QBO-side changes already do.

------------------------------------------------------------------------------
-- Step 1: columns
------------------------------------------------------------------------------

ALTER TABLE billing.customer_payment_methods
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS deactivated_by uuid NULL REFERENCES auth.users(id);

COMMENT ON COLUMN billing.customer_payment_methods.deactivated_at IS
  'User-driven deactivation timestamp. NULL = active per user intent. '
  'Independent of is_active (which mirrors QBO presence). Set via the '
  'per-customer Payment Methods UI; never written by the sync script.';

COMMENT ON COLUMN billing.customer_payment_methods.deactivated_by IS
  'auth.users.id of the user who last set deactivated_at. NULL when '
  'deactivated_at is NULL or when an older system did the write.';

------------------------------------------------------------------------------
-- Step 2: resolvers — add deactivated_at filter
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing.resolve_preferred_payment_type(
  p_qbo_customer_id text,
  p_wo_description  text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  v_customer_pref text;
  v_account_type  text;
  v_default_type  text;
BEGIN
  IF p_wo_description IS NOT NULL AND p_wo_description ILIKE '%*bill*%' THEN
    RETURN 'email';
  END IF;

  SELECT preferred_payment_type, account_type
    INTO v_customer_pref, v_account_type
    FROM public."Customers"
   WHERE qbo_customer_id = p_qbo_customer_id;

  IF v_customer_pref IS NOT NULL THEN RETURN v_customer_pref; END IF;
  IF v_account_type = 'commercial' THEN RETURN 'email'; END IF;

  SELECT type INTO v_default_type
    FROM billing.customer_payment_methods
   WHERE qbo_customer_id = p_qbo_customer_id
     AND is_active = true
     AND deactivated_at IS NULL
     AND is_default = true
   ORDER BY (raw->>'created') DESC NULLS LAST, fetched_at DESC
   LIMIT 1;

  IF v_default_type IS NOT NULL THEN RETURN v_default_type; END IF;
  RETURN 'email';
END;
$function$;

CREATE OR REPLACE FUNCTION billing.pick_target_payment_method(
  p_qbo_customer_id text,
  p_preferred_type  text
)
RETURNS uuid
LANGUAGE plpgsql STABLE
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
   ORDER BY (raw->>'created') DESC NULLS LAST, fetched_at DESC
   LIMIT 1;

  IF v_pm_id IS NOT NULL THEN RETURN v_pm_id; END IF;

  SELECT id INTO v_pm_id
    FROM billing.customer_payment_methods
   WHERE qbo_customer_id = p_qbo_customer_id
     AND is_active = true
     AND deactivated_at IS NULL
     AND is_default = true
   ORDER BY (raw->>'created') DESC NULLS LAST, fetched_at DESC
   LIMIT 1;

  RETURN v_pm_id;
END;
$function$;

------------------------------------------------------------------------------
-- Step 3: extend the auto-resolve trigger to fire on user deactivation toggle
------------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_resolve_pm_on_cpm_change ON billing.customer_payment_methods;
CREATE TRIGGER trg_resolve_pm_on_cpm_change
AFTER INSERT
   OR UPDATE OF is_active, is_default, deactivated_at
   OR DELETE
ON billing.customer_payment_methods
FOR EACH ROW
EXECUTE FUNCTION billing.fn_resolve_pm_on_cpm_change();
