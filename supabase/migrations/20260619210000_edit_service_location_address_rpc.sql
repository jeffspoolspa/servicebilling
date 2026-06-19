-- Correct a service_location's address IN PLACE (ADR 005/007). Unlike the relink flow
-- (which moves a customer to a different canonical location and leaves tasks.service_location_id
-- pointing at the old row), this fixes the existing row -- so the tasks, visits, and route map
-- that reference it all update at once. For wrong addresses (e.g. an ION-mislabeled Sea Island
-- pool recorded as Savannah), this is the right operation. The picked address comes from the
-- Google Places autocomplete, so it carries a confirmed rooftop place_id + coordinate.

create or replace function public.edit_service_location_address(
  p_location_id bigint,
  p_place_id    text,
  p_street      text,
  p_city        text,
  p_state       text default 'GA',
  p_zip         text default null,
  p_lat         double precision default null,
  p_lng         double precision default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_existing bigint;
begin
  if p_location_id is null then raise exception 'edit_service_location_address: p_location_id required'; end if;
  if p_place_id  is null then raise exception 'edit_service_location_address: p_place_id required'; end if;

  -- place_id is globally unique: if another row already IS this place, don't collide --
  -- report it so the caller can repoint to the canonical row instead.
  select id into v_existing
    from public.service_locations
   where place_id = p_place_id and id <> p_location_id
   limit 1;
  if v_existing is not null then
    return jsonb_build_object('ok', false, 'reason', 'duplicate', 'existing_location_id', v_existing);
  end if;

  update public.service_locations set
    place_id       = p_place_id,
    place_provider = 'google',
    street         = p_street,
    city           = p_city,
    state          = coalesce(p_state, 'GA'),
    zip            = p_zip,
    latitude       = p_lat,
    longitude      = p_lng,
    geocoded_at    = now(),
    geocode_source = 'app+autocomplete',
    geocode_status = 'ok',
    duplicate_of_location_id = null,
    updated_at     = now()
  where id = p_location_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'location_id', p_location_id);
end
$function$;

grant execute on function public.edit_service_location_address(bigint,text,text,text,text,text,double precision,double precision)
  to authenticated, service_role, anon;
