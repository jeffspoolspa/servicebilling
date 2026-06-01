-- BACKFILLED 2026-05-26 from supabase_migrations.schema_migrations.
-- This migration was applied to the live DB on 2026-05-22 18:56 UTC but the
-- file was never committed to the repo. Recovered verbatim from the
-- statements column. See AUDIT_2026-05-26.md for context on the drift.

-- Fix three onboarding RPCs that still reference the OLD pre-migration
-- table names (maintenance.maintenance_leads, maintenance.maintenance_onboarding).
-- Repoint them at the current schema (public.leads, maintenance.onboarding,
-- maintenance.residential_lead_details).
--
-- Also: switch mark_payment_on_file to flip lead status to 'converted'
-- (was 'accepted') per the payment-only-triggers-conversion rule. The
-- 'accepted' transition still happens earlier when the user clicks
-- "Get Started Now" (accept_lead RPC) — payment_on_file moves it the
-- last hop to 'converted'.

-- ─────────────────────────────────────────────────────────────────
-- public.create_card_collection_request
-- Resolves account via public.leads (was maintenance.maintenance_leads).
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_card_collection_request(
  p_lead_id uuid,
  p_pre_auth_amount integer DEFAULT NULL::integer
) RETURNS json
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $function$
DECLARE
  v_token text;
  v_account_id bigint;
  v_request record;
BEGIN
  SELECT account_id INTO v_account_id
  FROM public.leads
  WHERE id = p_lead_id;

  IF v_account_id IS NULL THEN
    RETURN json_build_object('error', 'Lead has no linked account.');
  END IF;

  -- Reuse an existing pending, unexpired request for this account
  SELECT * INTO v_request
  FROM public.card_collection_requests
  WHERE customer_id = v_account_id
    AND status = 'pending'
    AND expires_at > now()
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_request.id IS NOT NULL THEN
    IF p_pre_auth_amount IS NOT NULL
       AND coalesce(v_request.pre_auth_amount, -1) <> p_pre_auth_amount THEN
      UPDATE public.card_collection_requests
         SET pre_auth_amount = p_pre_auth_amount
       WHERE id = v_request.id
      RETURNING * INTO v_request;
    END IF;
    RETURN json_build_object(
      'id', v_request.id,
      'token', v_request.token,
      'expires_at', v_request.expires_at,
      'pre_auth_amount', v_request.pre_auth_amount
    );
  END IF;

  v_token := encode(gen_random_bytes(16), 'hex');

  INSERT INTO public.card_collection_requests (
    customer_id, token, status, pre_auth_amount, expires_at
  ) VALUES (
    v_account_id, v_token, 'pending', p_pre_auth_amount, now() + interval '14 days'
  )
  RETURNING * INTO v_request;

  RETURN json_build_object(
    'id', v_request.id,
    'token', v_request.token,
    'expires_at', v_request.expires_at,
    'pre_auth_amount', v_request.pre_auth_amount
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────
-- public.get_lead_by_accept_token
-- Resolves lead via public.leads (was maintenance.maintenance_leads).
-- Returns the same shape as before (lead detail via
-- get_maintenance_lead_detail + token expiry + payment_on_file flag).
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_lead_by_accept_token(p_token text)
  RETURNS json
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $function$
DECLARE
  v_req record;
  v_lead_id uuid;
  v_detail jsonb;
BEGIN
  SELECT * INTO v_req
  FROM public.card_collection_requests
  WHERE token = p_token
  LIMIT 1;

  IF v_req.id IS NULL THEN
    RETURN json_build_object('error', 'Invalid token');
  END IF;
  IF v_req.expires_at <= now() THEN
    RETURN json_build_object('error', 'Token expired', 'expired_at', v_req.expires_at);
  END IF;

  -- Most recent lead for this account
  SELECT id INTO v_lead_id
  FROM public.leads
  WHERE account_id = v_req.customer_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_lead_id IS NULL THEN
    RETURN json_build_object('error', 'No lead found for this token');
  END IF;

  SELECT public.get_maintenance_lead_detail(v_lead_id) INTO v_detail;

  RETURN json_build_object(
    'token_expires_at', v_req.expires_at,
    'payment_on_file', (v_req.status = 'completed'),
    'lead', v_detail
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────
-- public.mark_payment_on_file
-- Repoint to maintenance.onboarding + maintenance.residential_lead_details.
-- Per the payment-only-triggers-conversion rule: when payment lands,
-- flip lead status to 'converted' (no longer just 'accepted').
-- The 'accepted' transition happens earlier in accept_lead when the
-- customer clicks Get Started Now.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_payment_on_file(p_lead_id uuid)
  RETURNS json
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $function$
DECLARE
  v_onboarding_id uuid;
  v_new_lead_status text;
BEGIN
  -- Upsert onboarding row with payment_on_file=true
  SELECT id INTO v_onboarding_id
  FROM maintenance.onboarding
  WHERE lead_id = p_lead_id
  LIMIT 1;

  IF v_onboarding_id IS NULL THEN
    INSERT INTO maintenance.onboarding (
      lead_id, status, payment_on_file, payment_collected
    ) VALUES (
      p_lead_id, 'payment_on_file', true, false
    )
    RETURNING id INTO v_onboarding_id;
  ELSE
    UPDATE maintenance.onboarding
       SET payment_on_file = true,
           status = CASE WHEN status = 'pending_payment' THEN 'payment_on_file' ELSE status END,
           updated_at = now()
     WHERE id = v_onboarding_id;
  END IF;

  -- Payment-only triggers conversion. Flip the lead's child status to
  -- 'converted' (from whatever it currently is — typically 'accepted'
  -- after the Get Started Now click, but also handles the case where
  -- card lands before accept_lead fires, e.g. an office-initiated
  -- card collection on a 'quoted' lead).
  UPDATE maintenance.residential_lead_details
     SET status = 'converted', updated_at = now()
   WHERE lead_id = p_lead_id
     AND status IN ('new', 'quoted', 'accepted');

  -- For commercial leads too, mirror the same transition
  UPDATE maintenance.commercial_lead_details
     SET status = 'converted', updated_at = now()
   WHERE lead_id = p_lead_id
     AND status IN ('new', 'quoted', 'accepted');

  -- Stamp the customer last_contacted_at so back-office views surface
  UPDATE public.leads
     SET updated_at = now()
   WHERE id = p_lead_id;

  v_new_lead_status := 'converted';

  RETURN json_build_object(
    'ok', true,
    'onboarding_id', v_onboarding_id,
    'lead_status', v_new_lead_status
  );
END;
$function$;
