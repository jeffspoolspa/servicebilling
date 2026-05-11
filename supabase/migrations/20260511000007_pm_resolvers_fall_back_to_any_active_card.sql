-- Adds a "fall back to any active card" tier to both PM resolver
-- functions. Shipped briefly to address Country Inn (1 card not flagged
-- default) before the architectural correction in
-- 20260511000008_restore_pm_resolver_default_only_pickers.sql.
--
-- Kept in the migration history (not deleted) so a re-run of migrations
-- on a fresh DB lands at the same final state by going through the
-- same sequence of changes.

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
  v_picked_type   text;
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

  SELECT type INTO v_picked_type
    FROM billing.customer_payment_methods
   WHERE qbo_customer_id = p_qbo_customer_id
     AND is_active = true
   ORDER BY is_default DESC NULLS LAST,
            (raw->>'created') DESC NULLS LAST,
            fetched_at DESC
   LIMIT 1;

  IF v_picked_type IS NOT NULL THEN RETURN v_picked_type; END IF;
  RETURN 'email';
END;
$function$;

CREATE OR REPLACE FUNCTION billing.pick_target_payment_method(
  p_qbo_customer_id  text,
  p_preferred_type   text
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
   ORDER BY (type = p_preferred_type) DESC,
            is_default DESC NULLS LAST,
            (raw->>'created') DESC NULLS LAST,
            fetched_at DESC
   LIMIT 1;

  RETURN v_pm_id;
END;
$function$;
