-- BACKFILLED 2026-05-26 from supabase_migrations.schema_migrations.
-- This migration was applied to the live DB on 2026-05-22 17:13 UTC but the
-- file was never committed to the repo. Recovered verbatim from the
-- statements column. See AUDIT_2026-05-26.md for context on the drift.

-- Split the monolithic submit_website_lead RPC into two well-defined RPCs:
--   * check_or_create_customer — dedup + create/link customer
--   * create_lead              — create lead under an existing customer
--
-- Each does ONE thing and can be composed. The existing submit_website_lead
-- becomes a thin wrapper that calls both atomically (so /api/leads/submit
-- keeps working with no behavior change). The new flow (contact-after-
-- qualifier) will call the two new functions directly via separate
-- endpoints, giving the frontend flexibility to reorder steps.

-- ─────────────────────────────────────────────────────────────────
-- public.check_or_create_customer
-- ─────────────────────────────────────────────────────────────────
-- Inputs:
--   p_contact   { first_name, last_name, email?, phone? }
--   p_address   { street, city, state?, zip }
--   p_account_type 'residential' | 'commercial'
--   p_customer_action  NULL | 'auto' | 'use_existing' | 'create_new'
--     NULL/'auto' → run dedup; if matches, return for confirmation
--     'use_existing' → require p_existing_customer_id, update contact
--     'create_new' → skip dedup, force-create
--   p_existing_customer_id  required when p_customer_action='use_existing'
--   p_account_name  required when p_account_type='commercial' (company name)
--
-- Returns:
--   { dedup_required: true, matches: [...] }   when dedup matches found
--   { ok: true, customer_id, returning: bool } on success
--
-- RAISES on validation failure or RPC misuse.
CREATE OR REPLACE FUNCTION public.check_or_create_customer(
  p_contact jsonb,
  p_address jsonb,
  p_account_type text,
  p_customer_action text DEFAULT NULL,
  p_existing_customer_id bigint DEFAULT NULL,
  p_account_name text DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'maintenance'
AS $function$
DECLARE
  v_first_name text := nullif(trim(p_contact->>'first_name'), '');
  v_last_name  text := nullif(trim(p_contact->>'last_name'),  '');
  v_email      text := nullif(lower(trim(coalesce(p_contact->>'email',''))), '');
  v_phone_raw  text := p_contact->>'phone';
  v_phone10    text;
  v_street     text := nullif(trim(p_address->>'street'), '');
  v_city       text := nullif(trim(p_address->>'city'),   '');
  v_state      text := coalesce(nullif(trim(p_address->>'state'), ''), 'GA');
  v_zip        text := nullif(trim(p_address->>'zip'),    '');
  v_account_id bigint;
  v_returning  boolean := false;
  v_acct       jsonb;
  v_matches    jsonb;
  v_resolved_action text := COALESCE(p_customer_action, 'auto');
BEGIN
  -- Validate contact
  IF v_first_name IS NULL OR v_last_name IS NULL THEN
    RAISE EXCEPTION 'first_name and last_name required';
  END IF;
  IF v_email IS NULL AND v_phone_raw IS NULL THEN
    RAISE EXCEPTION 'email or phone required';
  END IF;
  -- Validate address (only needed for create_new path; use_existing has the
  -- address on the existing customer row already)
  IF v_resolved_action IN ('auto', 'create_new') THEN
    IF v_street IS NULL OR v_city IS NULL OR v_zip IS NULL THEN
      RAISE EXCEPTION 'incomplete address';
    END IF;
  END IF;
  IF p_account_type NOT IN ('residential','commercial') THEN
    RAISE EXCEPTION 'invalid account_type: %', p_account_type;
  END IF;

  -- Normalize phone to last 10 digits if we have at least 10
  v_phone10 := CASE
    WHEN length(regexp_replace(coalesce(v_phone_raw,''), '\D', '', 'g')) >= 10
    THEN right(regexp_replace(coalesce(v_phone_raw,''), '\D', '', 'g'), 10)
    ELSE NULL
  END;

  -- Auto-dedup pass
  IF v_resolved_action = 'auto' THEN
    SELECT jsonb_agg(row_to_json(m))
    INTO v_matches
    FROM (
      SELECT
        c.id AS customer_id,
        c.display_name,
        c.first_name,
        c.last_name,
        CASE
          WHEN c.phone IS NOT NULL AND length(regexp_replace(c.phone, '\D', '', 'g')) >= 4 THEN
            '***-***-' || right(regexp_replace(c.phone, '\D', '', 'g'), 4)
          ELSE NULL
        END AS redacted_phone,
        CASE
          WHEN c.email IS NOT NULL AND c.email LIKE '%@%' THEN
            left(c.email, 1) || '***@' || split_part(c.email, '@', 2)
          ELSE NULL
        END AS redacted_email,
        c.account_type
      FROM public."Customers" c
      WHERE coalesce(c.is_active, true) = true
        AND c.deleted_at IS NULL
        AND (
          (v_phone10 IS NOT NULL AND right(regexp_replace(coalesce(c.phone,''), '\D', '', 'g'), 10) = v_phone10)
          OR
          (v_email IS NOT NULL AND lower(c.email) = v_email)
        )
      ORDER BY c.created_at DESC
      LIMIT 3
    ) m;

    IF v_matches IS NOT NULL THEN
      RETURN jsonb_build_object('dedup_required', true, 'matches', v_matches);
    END IF;

    -- No matches → fall through to create_new
    v_resolved_action := 'create_new';
  END IF;

  IF v_resolved_action = 'use_existing' THEN
    IF p_existing_customer_id IS NULL THEN
      RAISE EXCEPTION 'existing_customer_id required when customer_action=use_existing';
    END IF;
    SELECT id INTO v_account_id FROM public."Customers" WHERE id = p_existing_customer_id;
    IF v_account_id IS NULL THEN
      RAISE EXCEPTION 'existing_customer_id not found: %', p_existing_customer_id;
    END IF;
    v_returning := true;

    -- Always use the 7-arg variant of update_account_contact to dodge
    -- function-resolution ambiguity. Pass NULL for account_name/account_type
    -- when residential so they're not overwritten.
    IF p_account_type = 'commercial' THEN
      PERFORM maintenance.update_account_contact(
        v_account_id, v_first_name, v_last_name, v_email, v_phone10,
        nullif(trim(p_account_name), ''), 'commercial'
      );
    ELSE
      PERFORM maintenance.update_account_contact(
        v_account_id, v_first_name, v_last_name, v_email, v_phone10,
        NULL::text, NULL::text
      );
    END IF;

  ELSIF v_resolved_action = 'create_new' THEN
    v_acct := maintenance.create_account(
      v_first_name, v_last_name, v_email, v_phone10,
      p_account_type,
      v_street, v_city, v_state, v_zip,
      nullif(trim(p_account_name), ''),
      v_street, v_city, v_state, v_zip
    );
    v_account_id := coalesce(
      (v_acct->>'account_id')::bigint,
      (v_acct->>'id')::bigint
    );
    IF v_account_id IS NULL THEN
      RAISE EXCEPTION 'create_account did not return an account id: %', v_acct;
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid customer_action: %', v_resolved_action;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'customer_id', v_account_id,
    'returning', v_returning
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────
-- public.create_lead
-- ─────────────────────────────────────────────────────────────────
-- Inputs:
--   p_customer_id  required — caller must have just created/linked this customer
--                  via check_or_create_customer. Authorization is enforced at
--                  the API layer (customer_token signed by the server).
--   p_type         'residential_maintenance' | 'commercial_maintenance' | 'service_request'
--   p_office       'richmond_hill' | 'brunswick' (validated by the API layer
--                   via service-area lookup against the address zip)
--   p_qualifying   per-type payload, same shape as today's submit_website_lead
--   p_quoted_per_visit, p_first_months_deposit  computed by /api/quote/calculate
--   p_referral_source, p_metadata  passthrough
--
-- Returns:
--   { ok: true, lead_id, resume_token, lifecycle_state, closed_reason, child_status }
--
-- Initial child_status is 'new' (not 'quoted') — mark_lead_quoted() flips it
-- to 'quoted' when the customer actually fires Email Quote or Text Quote.
CREATE OR REPLACE FUNCTION public.create_lead(
  p_customer_id bigint,
  p_type text,
  p_office text,
  p_qualifying jsonb,
  p_quoted_per_visit numeric DEFAULT NULL,
  p_first_months_deposit numeric DEFAULT NULL,
  p_referral_source text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'maintenance'
AS $function$
DECLARE
  v_lead public.leads;
  v_body jsonb;
  v_child_status text;
  v_company_name text;
BEGIN
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'customer_id required';
  END IF;
  IF p_type NOT IN ('residential_maintenance','commercial_maintenance','service_request') THEN
    RAISE EXCEPTION 'invalid type: %', p_type;
  END IF;
  -- Verify customer exists (defensive; API layer should have already)
  PERFORM 1 FROM public."Customers" WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer not found: %', p_customer_id;
  END IF;

  IF p_type = 'service_request' THEN
    INSERT INTO public.leads (
      account_id, type, source, office, referral_source,
      resume_token, resume_token_expires_at,
      metadata,
      lifecycle_state, closed_at, closed_reason
    ) VALUES (
      p_customer_id, p_type, 'website', p_office, p_referral_source,
      replace(gen_random_uuid()::text, '-', ''),
      now() + interval '14 days',
      p_metadata || jsonb_build_object(
        'service_request', jsonb_build_object(
          'kind', coalesce(p_qualifying->>'kind', 'service'),
          'issue_description', nullif(trim(p_qualifying->>'issue_description'), ''),
          'pool_condition', p_qualifying->>'pool_condition',
          'urgency', p_qualifying->>'urgency',
          'ticketed_at', now()
        )
      ),
      'closed', now(), 'ticketed'
    )
    RETURNING * INTO v_lead;
    v_child_status := NULL;

  ELSE
    INSERT INTO public.leads (
      account_id, type, source, office, referral_source,
      resume_token, resume_token_expires_at,
      metadata,
      site_visit_required
    ) VALUES (
      p_customer_id, p_type, 'website', p_office, p_referral_source,
      replace(gen_random_uuid()::text, '-', ''),
      now() + interval '14 days',
      p_metadata,
      CASE WHEN p_type = 'commercial_maintenance' THEN true ELSE NULL END
    )
    RETURNING * INTO v_lead;

    IF p_type = 'residential_maintenance' THEN
      v_child_status := 'new';
      INSERT INTO maintenance.residential_lead_details (
        lead_id, status,
        visits_per_week, quoted_per_visit, first_months_deposit,
        pool_condition, issue_description, lead_context, contact_preference
      ) VALUES (
        v_lead.id, v_child_status,
        nullif(p_qualifying->>'visits_per_week','')::numeric,
        p_quoted_per_visit,
        p_first_months_deposit,
        p_qualifying->>'pool_condition',
        nullif(trim(p_qualifying->>'issue_description'), ''),
        nullif(trim(p_qualifying->>'lead_context'), ''),
        nullif(trim(p_qualifying->>'contact_preference'), '')
      );

      FOR v_body IN SELECT * FROM jsonb_array_elements(coalesce(p_qualifying->'bodies','[]'::jsonb)) LOOP
        PERFORM maintenance.create_service_body(
          p_customer_id,
          NULL,
          v_body->>'body_type',
          coalesce((v_body->>'is_primary')::boolean, false),
          coalesce((v_body->>'is_short_term_rental')::boolean, false),
          (v_body->>'is_inground')::boolean,
          (v_body->>'is_screened_in')::boolean,
          v_body->>'chlorination_system',
          v_body->>'filter_type',
          v_body->>'vegetation_level',
          coalesce((v_body->>'has_auto_cleaner')::boolean, false),
          coalesce((v_body->>'has_dogs')::boolean, false),
          nullif(v_body->>'pool_volume','')::numeric,
          nullif(trim(v_body->>'access_instructions'), ''),
          nullif(trim(v_body->>'special_instructions'), '')
        );
      END LOOP;

    ELSIF p_type = 'commercial_maintenance' THEN
      v_child_status := 'new';
      v_company_name := nullif(trim(p_qualifying->>'company_name'), '');
      INSERT INTO maintenance.commercial_lead_details (
        lead_id, status, company_name, closes_for_winter,
        summer_frequency, winter_frequency,
        property_manager_name, property_manager_phone, property_manager_email,
        commercial_description
      ) VALUES (
        v_lead.id, v_child_status,
        v_company_name,
        (p_qualifying->>'closes_for_winter')::boolean,
        nullif(p_qualifying->>'summer_frequency','')::integer,
        nullif(p_qualifying->>'winter_frequency','')::integer,
        nullif(trim(p_qualifying->>'property_manager_name'), ''),
        nullif(p_qualifying->>'property_manager_phone', ''),
        nullif(p_qualifying->>'property_manager_email', ''),
        nullif(trim(p_qualifying->>'commercial_description'), '')
      );
    END IF;
  END IF;

  BEGIN
    PERFORM public.log_lead_activity(
      v_lead.id, 'system',
      'Lead created (' || p_type || ')',
      jsonb_build_object('type', p_type, 'customer_id', p_customer_id),
      'website'
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'lead_id', v_lead.id,
    'resume_token', v_lead.resume_token,
    'resume_token_expires_at', v_lead.resume_token_expires_at,
    'lifecycle_state', v_lead.lifecycle_state,
    'closed_reason', v_lead.closed_reason,
    'child_status', v_child_status
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────
-- public.submit_website_lead — REWRITE as a thin wrapper
-- ─────────────────────────────────────────────────────────────────
-- Keeps the existing /api/leads/submit endpoint working with no
-- behavior change. The wrapper:
--   1. Calls check_or_create_customer; if dedup match → return matches
--   2. Calls create_lead with the resolved customer_id
--   3. Merges and returns the same response shape as before
-- Because both functions run inside the same statement (PL/pgSQL),
-- atomicity is preserved — if create_lead throws, the customer row
-- created in step 1 is rolled back.
CREATE OR REPLACE FUNCTION public.submit_website_lead(
  p_contact jsonb,
  p_address jsonb,
  p_office text,
  p_type text,
  p_account_type text,
  p_qualifying jsonb,
  p_customer_action text DEFAULT NULL::text,
  p_existing_customer_id bigint DEFAULT NULL::bigint,
  p_quoted_per_visit numeric DEFAULT NULL::numeric,
  p_first_months_deposit numeric DEFAULT NULL::numeric,
  p_referral_source text DEFAULT NULL::text,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'maintenance'
AS $function$
DECLARE
  v_account_name text;
  v_customer_result jsonb;
  v_customer_id bigint;
  v_returning boolean;
  v_lead_result jsonb;
BEGIN
  -- Commercial paths pass company_name via qualifying.company_name
  IF p_account_type = 'commercial' THEN
    v_account_name := nullif(trim(p_qualifying->>'company_name'), '');
  END IF;

  v_customer_result := public.check_or_create_customer(
    p_contact, p_address, p_account_type,
    p_customer_action, p_existing_customer_id,
    v_account_name
  );

  -- Short-circuit on dedup
  IF (v_customer_result ? 'dedup_required') THEN
    RETURN v_customer_result;
  END IF;

  v_customer_id := (v_customer_result->>'customer_id')::bigint;
  v_returning := coalesce((v_customer_result->>'returning')::boolean, false);

  v_lead_result := public.create_lead(
    v_customer_id, p_type, p_office, p_qualifying,
    p_quoted_per_visit, p_first_months_deposit,
    p_referral_source, p_metadata
  );

  RETURN v_lead_result || jsonb_build_object(
    'account_id', v_customer_id,
    'returning', v_returning
  );
END;
$function$;
