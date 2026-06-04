-- Make the canonical "Gen-2" leads model whole: recreate the two dropped child
-- tables and repair the functions that reference them; thread a source through intake.
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- A 2026-06-03 audit of the leads backend (decisions in ADR 004 +
-- ~/.claude/plans/snoopy-hugging-lantern.md) found the system half-migrated
-- between two schema generations. The live, canonical "Gen-2" model is
-- public.leads (envelope) + maintenance.residential_lead_details (child status).
-- Two Gen-2 child tables had been dropped but are still referenced by live
-- functions, so those functions error today:
--   * maintenance.lead_activities       — referenced by log_lead_activity /
--       add_lead_note / delete_maintenance_lead. Inserts were silently swallowed
--       (every caller wraps the call in EXCEPTION WHEN OTHERS THEN NULL), so the
--       lead activity audit trail has NOT been recording anything.
--   * maintenance.commercial_lead_details — referenced by get_maintenance_lead_detail,
--       get_maintenance_leads, accept_lead, create_lead, mark_lead_quoted,
--       bulk_update_lead_status, and the sync_lead_lifecycle_from_child trigger.
--       Any call that touches the commercial branch (incl. the residential detail
--       reader's LEFT JOIN) errors with "relation does not exist".
-- Two more bugs: create_lead hardcodes source='website' (so an internal-form lead
-- is mislabeled), and submit_maintenance_onboarding writes public.leads.status — a
-- column that does not exist (status lives on the child).
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- 1. Recreate maintenance.lead_activities (Gen-2: lead_id -> public.leads.id).
-- 2. Recreate maintenance.commercial_lead_details (empty; mirrors residential's
--    PK/FK/status-CHECK; columns reconstructed from create_lead + the detail reader).
-- 3. create_lead: add p_source text DEFAULT 'website' (last arg) and write it to
--    leads.source instead of the hardcoded literal. Drop the old 8-arg signature so
--    no ambiguous overload remains.
-- 4. submit_website_lead: add p_source text DEFAULT 'website' (last arg), pass it to
--    create_lead. Drop the old 12-arg signature.
-- 5. submit_maintenance_onboarding: write residential_lead_details.status, not the
--    non-existent public.leads.status.
-- 6. update_lead_qbo_customer: rewrite onto Gen-2 — stamp public."Customers".
--    qbo_customer_id for the lead's account_id (it wrote the dead maintenance.leads).
--
-- ─────────────────────────────────────────────────────────────────
-- WHAT WE KEEP / WHAT WE LOSE
-- ─────────────────────────────────────────────────────────────────
-- KEEP: all existing Gen-2 data (public.leads, residential_lead_details, onboarding,
--   card_collection_requests). Recreated tables start empty — they were already gone,
--   so no rows are lost that still existed. External-website RPC contracts are
--   preserved: every new function arg is defaulted, so calls without p_source still
--   resolve. LOSE: nothing live — only the broken/hardcoded behavior is replaced.
--   Dead Gen-1 RPCs are dropped in a separate follow-up migration, not here.

-- 1. ────────────────────────────────────────────────────────────── lead_activities
create table if not exists maintenance.lead_activities (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.leads(id) on delete cascade,
  activity_type text not null,                       -- 'system' | 'note' | ...
  description   text,
  metadata      jsonb not null default '{}'::jsonb,
  created_by    text,
  created_at    timestamptz not null default now()
);
create index if not exists lead_activities_lead_id_idx
  on maintenance.lead_activities (lead_id, created_at desc);

-- 2. ──────────────────────────────────────────────────── commercial_lead_details
create table if not exists maintenance.commercial_lead_details (
  lead_id                 uuid primary key references public.leads(id) on delete cascade,
  status                  text not null default 'new'
                            check (status = any (array['new','quoted','accepted','converted','expired','declined'])),
  company_name            text,
  closes_for_winter       boolean,
  summer_frequency        integer,
  winter_frequency        integer,
  property_manager_name   text,
  property_manager_phone  text,
  property_manager_email  text,
  commercial_description  text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- keep the commercial child's updated_at fresh + project lifecycle from its status,
-- mirroring the residential triggers.
drop trigger if exists trg_commercial_lead_details_updated on maintenance.commercial_lead_details;
create trigger trg_commercial_lead_details_updated
  before update on maintenance.commercial_lead_details
  for each row execute function maintenance.set_updated_at();

drop trigger if exists trg_sync_lifecycle_from_commercial on maintenance.commercial_lead_details;
create trigger trg_sync_lifecycle_from_commercial
  after insert or update on maintenance.commercial_lead_details
  for each row execute function maintenance.sync_lead_lifecycle_from_child();

-- 3. ─────────────────────────────────────────────────────────────── create_lead
drop function if exists public.create_lead(bigint, text, text, jsonb, numeric, numeric, text, jsonb);

create or replace function public.create_lead(
  p_customer_id bigint,
  p_type text,
  p_office text,
  p_qualifying jsonb,
  p_quoted_per_visit numeric default null,
  p_first_months_deposit numeric default null,
  p_referral_source text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_source text default 'website'
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'maintenance'
as $function$
declare
  v_lead public.leads;
  v_body jsonb;
  v_child_status text;
  v_company_name text;
begin
  if p_customer_id is null then
    raise exception 'customer_id required';
  end if;
  if p_type not in ('residential_maintenance','commercial_maintenance','service_request') then
    raise exception 'invalid type: %', p_type;
  end if;
  perform 1 from public."Customers" where id = p_customer_id;
  if not found then
    raise exception 'customer not found: %', p_customer_id;
  end if;

  if p_type = 'service_request' then
    insert into public.leads (
      account_id, type, source, office, referral_source,
      resume_token, resume_token_expires_at, metadata,
      lifecycle_state, closed_at, closed_reason
    ) values (
      p_customer_id, p_type, p_source, p_office, p_referral_source,
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
    returning * into v_lead;
    v_child_status := null;

  else
    insert into public.leads (
      account_id, type, source, office, referral_source,
      resume_token, resume_token_expires_at, metadata, site_visit_required
    ) values (
      p_customer_id, p_type, p_source, p_office, p_referral_source,
      replace(gen_random_uuid()::text, '-', ''),
      now() + interval '14 days',
      p_metadata,
      case when p_type = 'commercial_maintenance' then true else null end
    )
    returning * into v_lead;

    if p_type = 'residential_maintenance' then
      v_child_status := 'new';
      insert into maintenance.residential_lead_details (
        lead_id, status,
        visits_per_week, quoted_per_visit, first_months_deposit,
        pool_condition, issue_description, lead_context, contact_preference
      ) values (
        v_lead.id, v_child_status,
        nullif(p_qualifying->>'visits_per_week','')::numeric,
        p_quoted_per_visit,
        p_first_months_deposit,
        p_qualifying->>'pool_condition',
        nullif(trim(p_qualifying->>'issue_description'), ''),
        nullif(trim(p_qualifying->>'lead_context'), ''),
        nullif(trim(p_qualifying->>'contact_preference'), '')
      );

      for v_body in select * from jsonb_array_elements(coalesce(p_qualifying->'bodies','[]'::jsonb)) loop
        perform maintenance.create_service_body(
          p_customer_id, null,
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
      end loop;

    elsif p_type = 'commercial_maintenance' then
      v_child_status := 'new';
      v_company_name := nullif(trim(p_qualifying->>'company_name'), '');
      insert into maintenance.commercial_lead_details (
        lead_id, status, company_name, closes_for_winter,
        summer_frequency, winter_frequency,
        property_manager_name, property_manager_phone, property_manager_email,
        commercial_description
      ) values (
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
    end if;
  end if;

  begin
    perform public.log_lead_activity(
      v_lead.id, 'system',
      'Lead created (' || p_type || ', source=' || p_source || ')',
      jsonb_build_object('type', p_type, 'customer_id', p_customer_id, 'source', p_source),
      p_source
    );
  exception when others then null;
  end;

  return jsonb_build_object(
    'ok', true,
    'lead_id', v_lead.id,
    'resume_token', v_lead.resume_token,
    'resume_token_expires_at', v_lead.resume_token_expires_at,
    'lifecycle_state', v_lead.lifecycle_state,
    'closed_reason', v_lead.closed_reason,
    'child_status', v_child_status
  );
end;
$function$;

-- 4. ──────────────────────────────────────────────────────── submit_website_lead
drop function if exists public.submit_website_lead(jsonb, jsonb, text, text, text, jsonb, text, bigint, numeric, numeric, text, jsonb);

create or replace function public.submit_website_lead(
  p_contact jsonb,
  p_address jsonb,
  p_office text,
  p_type text,
  p_account_type text,
  p_qualifying jsonb,
  p_customer_action text default null,
  p_existing_customer_id bigint default null,
  p_quoted_per_visit numeric default null,
  p_first_months_deposit numeric default null,
  p_referral_source text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_source text default 'website'
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'maintenance'
as $function$
declare
  v_account_name text;
  v_customer_result jsonb;
  v_customer_id bigint;
  v_returning boolean;
  v_lead_result jsonb;
begin
  if p_account_type = 'commercial' then
    v_account_name := nullif(trim(p_qualifying->>'company_name'), '');
  end if;

  v_customer_result := public.check_or_create_customer(
    p_contact, p_address, p_account_type,
    p_customer_action, p_existing_customer_id,
    v_account_name
  );

  if (v_customer_result ? 'dedup_required') then
    return v_customer_result;
  end if;

  v_customer_id := (v_customer_result->>'customer_id')::bigint;
  v_returning := coalesce((v_customer_result->>'returning')::boolean, false);

  v_lead_result := public.create_lead(
    v_customer_id, p_type, p_office, p_qualifying,
    p_quoted_per_visit, p_first_months_deposit,
    p_referral_source, p_metadata, p_source
  );

  return v_lead_result || jsonb_build_object(
    'account_id', v_customer_id,
    'returning', v_returning
  );
end;
$function$;

-- 5. ───────────────────────────────────────────────── submit_maintenance_onboarding
-- Fix: the conversion-status write belongs on the child, not public.leads.status.
create or replace function public.submit_maintenance_onboarding(p_lead_id uuid, p_payload jsonb)
  returns json
  language plpgsql
  security definer
as $function$
declare
  v_account_id bigint;
  v_onboarding_id uuid;
  v_pool jsonb;
  v_primary_body_id bigint;
  v_payment_on_file boolean;
  v_new_status text;
begin
  select account_id into v_account_id from public.leads where id = p_lead_id;
  if v_account_id is null then
    return json_build_object('ok', false, 'error', 'Lead not found');
  end if;

  v_pool := coalesce(p_payload->'pool_details', '{}'::jsonb);

  select id into v_primary_body_id
    from maintenance.service_bodies
   where account_id = v_account_id and is_primary = true
   order by created_at asc
   limit 1;

  if v_primary_body_id is not null then
    update maintenance.service_bodies set
      is_inground          = coalesce((v_pool->>'is_inground')::boolean,       is_inground),
      is_screened_in       = coalesce((v_pool->>'is_screened_in')::boolean,    is_screened_in),
      chlorination_system  = coalesce(v_pool->>'chlorination_system',          chlorination_system),
      filter_type          = coalesce(v_pool->>'filter_type',                  filter_type),
      vegetation_level     = coalesce(v_pool->>'vegetation_level',             vegetation_level),
      has_auto_cleaner     = coalesce((v_pool->>'has_auto_cleaner')::boolean,  has_auto_cleaner),
      has_dogs             = coalesce((v_pool->>'has_dogs')::boolean,          has_dogs),
      pool_volume          = coalesce((v_pool->>'pool_volume')::numeric,       pool_volume),
      access_instructions  = coalesce(v_pool->>'access_instructions',          access_instructions),
      special_instructions = coalesce(v_pool->>'special_instructions',         special_instructions),
      updated_at = now()
    where id = v_primary_body_id;
  end if;

  select id, payment_on_file into v_onboarding_id, v_payment_on_file
    from maintenance.onboarding where lead_id = p_lead_id limit 1;

  if v_onboarding_id is null then
    insert into maintenance.onboarding (
      lead_id, status, payment_on_file, payment_collected,
      preferred_start_date, service_day_preference
    ) values (
      p_lead_id, 'pending_payment', false, false,
      nullif(p_payload->>'preferred_start_date','')::date,
      p_payload->>'service_day_preference'
    )
    returning id, payment_on_file into v_onboarding_id, v_payment_on_file;
  else
    update maintenance.onboarding set
      preferred_start_date   = coalesce(nullif(p_payload->>'preferred_start_date','')::date, preferred_start_date),
      service_day_preference = coalesce(p_payload->>'service_day_preference', service_day_preference),
      updated_at = now()
    where id = v_onboarding_id;
  end if;

  if v_payment_on_file then
    update maintenance.residential_lead_details
       set status = 'accepted', updated_at = now()
     where lead_id = p_lead_id and status = 'quoted';
    v_new_status := 'accepted';
  else
    v_new_status := 'quoted';
  end if;

  return json_build_object(
    'ok', true,
    'onboarding_id', v_onboarding_id,
    'payment_on_file', v_payment_on_file,
    'status', v_new_status
  );
end;
$function$;

-- 6. ────────────────────────────────────────────────────── update_lead_qbo_customer
-- Rewrite onto Gen-2: stamp the customer's qbo id (it wrote the dead maintenance.leads).
create or replace function public.update_lead_qbo_customer(
  p_lead_id uuid, p_qbo_customer_id text, p_customer_id bigint default null
) returns void
  language plpgsql
  security definer
  set search_path to 'public', 'maintenance'
as $function$
declare
  v_account_id bigint;
begin
  v_account_id := coalesce(p_customer_id, (select account_id from public.leads where id = p_lead_id));
  if v_account_id is null then
    raise exception 'update_lead_qbo_customer: no account for lead %', p_lead_id;
  end if;

  update public."Customers"
     set qbo_customer_id = p_qbo_customer_id
   where id = v_account_id;

  begin
    perform public.log_lead_activity(
      p_lead_id, 'system', 'QBO customer linked',
      jsonb_build_object('qbo_customer_id', p_qbo_customer_id, 'account_id', v_account_id),
      'windmill'
    );
  exception when others then null;
  end;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('maintenance.lead_activities') is null then
    raise exception 'lead_activities was not created';
  end if;
  if to_regclass('maintenance.commercial_lead_details') is null then
    raise exception 'commercial_lead_details was not created';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='create_lead'
      and pg_get_function_identity_arguments(p.oid) like '%p_source%'
  ) then
    raise exception 'create_lead p_source arg missing';
  end if;
  if exists (  -- old 8-arg create_lead must be gone
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='create_lead'
      and pg_get_function_identity_arguments(p.oid) not like '%p_source%'
  ) then
    raise exception 'old 8-arg create_lead still present (ambiguous overload)';
  end if;
end $$;
