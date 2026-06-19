-- The single service-address write door, plus composing create_account on it.
--
-- All writes to public.service_locations should flow through upsert_service_location
-- (directly, or via create_account which composes it). The RPC owns dedup (on
-- place_id), the single-primary invariant, and geocode persistence. RESOLUTION
-- (raw text -> place_id + coordinate) happens upstream in app/edge code against
-- Google Places — never in here: a plpgsql function must not make synchronous
-- external HTTP calls. This RPC is pure, deterministic SQL over already-resolved
-- inputs.

create or replace function public.upsert_service_location(
  p_account_id     bigint,
  p_place_id       text default null,
  p_street         text default null,
  p_city           text default null,
  p_state          text default 'GA',
  p_zip            text default null,
  p_lat            double precision default null,
  p_lng            double precision default null,
  p_is_primary     boolean default false,
  p_label          text default null,
  p_geocode_source text default null,
  p_geocode_status text default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_id bigint;
begin
  if p_account_id is null then
    raise exception 'upsert_service_location: p_account_id is required';
  end if;

  -- Dedup: reuse this account's existing ACTIVE location with the same place_id.
  if p_place_id is not null then
    select id into v_id
      from public.service_locations
     where account_id = p_account_id and place_id = p_place_id and is_active
     order by is_primary desc, id
     limit 1;
  end if;

  if v_id is not null then
    update public.service_locations set
      street         = coalesce(p_street, street),
      city           = coalesce(p_city, city),
      state          = coalesce(p_state, state),
      zip            = coalesce(p_zip, zip),
      latitude       = coalesce(p_lat, latitude),
      longitude      = coalesce(p_lng, longitude),
      label          = coalesce(p_label, label),
      is_primary     = is_primary or p_is_primary,
      place_provider = coalesce(place_provider, case when p_place_id is not null then 'google' end),
      geocode_source = coalesce(p_geocode_source, geocode_source),
      geocode_status = coalesce(p_geocode_status, geocode_status),
      geocoded_at    = case when p_lat is not null then now() else geocoded_at end,
      updated_at     = now()
    where id = v_id;
  else
    if p_is_primary then
      update public.service_locations set is_primary = false
       where account_id = p_account_id and is_primary;
    end if;
    insert into public.service_locations(
      account_id, place_id, place_provider, street, city, state, zip,
      latitude, longitude, geocoded_at, geocode_source, geocode_status,
      is_primary, is_active, label)
    values (
      p_account_id, p_place_id,
      case when p_place_id is not null then 'google' end,
      p_street, p_city, coalesce(p_state, 'GA'), p_zip,
      p_lat, p_lng,
      case when p_lat is not null then now() end,
      p_geocode_source, p_geocode_status,
      p_is_primary, true, p_label)
    returning id into v_id;
  end if;

  -- Single-primary invariant.
  if p_is_primary then
    update public.service_locations set is_primary = false
     where account_id = p_account_id and id <> v_id and is_primary;
  end if;

  return v_id;
end
$function$;

grant execute on function public.upsert_service_location(
  bigint,text,text,text,text,text,double precision,double precision,boolean,text,text,text
) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- create_account composes upsert_service_location (no inline service_locations
-- insert). New trailing params (place_id + service coords) default null, so the
-- existing callers (check_or_create_customer, start_website_lead,
-- submit_commercial_lead, lead intake) keep working unchanged.
-- ---------------------------------------------------------------------------
drop function if exists public.create_account(text,text,text,text,text,text,text,text,text,text,text,text,text,text);
drop function if exists maintenance.create_account(text,text,text,text,text,text,text,text,text,text,text,text,text,text);

create function maintenance.create_account(
  p_first_name text, p_last_name text, p_email text default null, p_phone text default null,
  p_account_type text default 'residential',
  p_billing_street text default null, p_billing_city text default null,
  p_billing_state text default 'GA', p_billing_zip text default null,
  p_account_name text default null,
  p_service_street text default null, p_service_city text default null,
  p_service_state text default 'GA', p_service_zip text default null,
  p_place_id text default null,
  p_service_lat double precision default null,
  p_service_lng double precision default null
) returns jsonb
language plpgsql
security definer
as $function$
declare
  v_account_id bigint;
  v_display_name text;
  v_location_id bigint;
  v_svc_street text; v_svc_city text; v_svc_state text; v_svc_zip text;
begin
  if p_account_type = 'commercial' then
    v_display_name := coalesce(nullif(p_account_name,''), coalesce(p_last_name,''));
  else
    v_display_name := coalesce(p_last_name,'') || ', ' || coalesce(p_first_name,'');
  end if;

  insert into "Customers"(display_name, account_name, first_name, last_name, email, phone,
                          street, city, state, zip, account_type, is_active)
  values (v_display_name, nullif(p_account_name,''), p_first_name, p_last_name, p_email, p_phone,
          p_billing_street, p_billing_city, p_billing_state, p_billing_zip, p_account_type, true)
  returning id into v_account_id;

  v_svc_street := coalesce(p_service_street, p_billing_street);
  v_svc_city   := coalesce(p_service_city, p_billing_city);
  v_svc_state  := coalesce(p_service_state, p_billing_state);
  v_svc_zip    := coalesce(p_service_zip, p_billing_zip);

  if v_svc_street is not null or p_place_id is not null then
    v_location_id := public.upsert_service_location(
      p_account_id => v_account_id,
      p_place_id   => p_place_id,
      p_street     => v_svc_street,
      p_city       => v_svc_city,
      p_state      => v_svc_state,
      p_zip        => v_svc_zip,
      p_lat        => p_service_lat,
      p_lng        => p_service_lng,
      p_is_primary => true
    );
  end if;

  return jsonb_build_object('account_id', v_account_id, 'display_name', v_display_name, 'location_id', v_location_id);
end
$function$;

create function public.create_account(
  p_first_name text, p_last_name text, p_email text default null, p_phone text default null,
  p_account_type text default 'residential',
  p_billing_street text default null, p_billing_city text default null,
  p_billing_state text default 'GA', p_billing_zip text default null,
  p_account_name text default null,
  p_service_street text default null, p_service_city text default null,
  p_service_state text default 'GA', p_service_zip text default null,
  p_place_id text default null,
  p_service_lat double precision default null,
  p_service_lng double precision default null
) returns jsonb
language sql
security definer
as $function$
  select maintenance.create_account(
    p_first_name, p_last_name, p_email, p_phone, p_account_type,
    p_billing_street, p_billing_city, p_billing_state, p_billing_zip, p_account_name,
    p_service_street, p_service_city, p_service_state, p_service_zip,
    p_place_id, p_service_lat, p_service_lng);
$function$;

grant execute on function public.create_account(
  text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,double precision,double precision
) to anon, authenticated, service_role;
