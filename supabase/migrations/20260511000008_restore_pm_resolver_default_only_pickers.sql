-- Revert 20260511000007. Per architectural correction: a card existing
-- in QBO's wallet should NOT silently start auto-charging it just
-- because it's there. The customer's billing preference (email vs
-- charge) is INDEPENDENT of which PMs exist. The auto-charge selection
-- should require one of:
--   (a) the card flagged as default in QBO, OR
--   (b) explicit customer-level preferred_payment_type, OR
--   (c) per-invoice override
--
-- The Country Inn case (single non-default card not getting charged)
-- is fixed in the UI layer — show all active PMs in the
-- PaymentMethodsCard so the user can SEE what's on file and click to
-- override per-invoice if they want this one charged. The cache
-- correctly reflected QBO; the resolver correctly defaulted to email
-- (commercial account, no explicit pref, no flagged default).

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
     AND is_active = true AND is_default = true
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
     AND is_active = true AND is_default = true AND type = p_preferred_type
   ORDER BY (raw->>'created') DESC NULLS LAST, fetched_at DESC
   LIMIT 1;

  IF v_pm_id IS NOT NULL THEN RETURN v_pm_id; END IF;

  SELECT id INTO v_pm_id
    FROM billing.customer_payment_methods
   WHERE qbo_customer_id = p_qbo_customer_id
     AND is_active = true AND is_default = true
   ORDER BY (raw->>'created') DESC NULLS LAST, fetched_at DESC
   LIMIT 1;

  RETURN v_pm_id;
END;
$function$;
