-- ADR 005, Phase 4 (the canonical write path): make upsert_service_location dedup
-- on the GLOBAL place_id and manage the ownership link.
--
-- Before this, dedup was per-account, which conflicts with the global unique(place_id):
-- a new customer whose address matches an existing canonical address would hit the
-- unique and error. Now: if the place_id already exists we reuse that canonical row,
-- make the caller its ACTIVE owner (demoting any prior active link — owner change),
-- and mirror service_locations.account_id to the active owner so every legacy reader
-- stays correct until Phase 5 drops account_id. Only a genuinely new address inserts.

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
  v_was_primary boolean := false;
  v_will_be_primary boolean;
begin
  if p_account_id is null then
    raise exception 'upsert_service_location: p_account_id is required';
  end if;

  -- 1. Find the canonical address row.
  if p_place_id is not null then
    -- place_id is globally unique → the one canonical row for this place, any owner
    select id into v_id from public.service_locations where place_id = p_place_id;
  else
    -- no place_id: reuse this account's existing active location if any
    select id into v_id
      from public.service_locations
     where account_id = p_account_id and is_active
     order by is_primary desc, id
     limit 1;
  end if;

  -- Single-primary-per-account is a partial unique index; pre-clear before we set it.
  if v_id is not null then
    select is_primary into v_was_primary from public.service_locations where id = v_id;
  end if;
  v_will_be_primary := coalesce(v_was_primary, false) or p_is_primary;
  if v_will_be_primary then
    update public.service_locations set is_primary = false
     where account_id = p_account_id and is_primary
       and (v_id is null or id <> v_id);
  end if;

  -- 2. Create or update the canonical row; account_id mirrors the active owner.
  if v_id is null then
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
  else
    update public.service_locations set
      account_id     = p_account_id,                                   -- mirror active owner
      place_id       = coalesce(place_id, p_place_id),                 -- keep canonical place_id
      place_provider = coalesce(place_provider, case when p_place_id is not null then 'google' end),
      street         = coalesce(p_street, street),
      city           = coalesce(p_city, city),
      state          = coalesce(p_state, state),
      zip            = coalesce(p_zip, zip),
      latitude       = coalesce(latitude, p_lat),                      -- don't clobber canonical geocode
      longitude      = coalesce(longitude, p_lng),
      geocoded_at    = case when latitude is null and p_lat is not null then now() else geocoded_at end,
      geocode_source = coalesce(geocode_source, p_geocode_source),
      geocode_status = coalesce(geocode_status, p_geocode_status),
      is_primary     = v_will_be_primary,
      label          = coalesce(p_label, label),
      is_active      = true,
      updated_at     = now()
    where id = v_id;
  end if;

  -- 3. Ownership link: caller is the active owner; demote any other active owner.
  update public.customer_service_addresses set is_active = false
   where service_location_id = v_id and is_active and customer_id <> p_account_id;
  insert into public.customer_service_addresses (customer_id, service_location_id, is_active)
    values (p_account_id, v_id, true)
    on conflict (customer_id, service_location_id) do update set is_active = true;

  return v_id;
end
$function$;
