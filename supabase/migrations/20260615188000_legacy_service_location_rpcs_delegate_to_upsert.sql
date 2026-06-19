-- ADR 005, Phase 4 (writers): route the legacy service-location RPCs through the
-- canonical door. Signatures unchanged (they're a live contract for any external
-- caller); only the bodies change so every write dedups/normalizes via
-- public.upsert_service_location instead of a blind INSERT.

create or replace function maintenance.create_service_location(
  p_account_id bigint, p_street text, p_city text default null,
  p_state text default 'GA', p_zip text default null,
  p_is_primary boolean default false, p_label text default null
) returns jsonb
language plpgsql security definer
as $function$
begin
  return jsonb_build_object('location_id',
    public.upsert_service_location(
      p_account_id => p_account_id,
      p_place_id   => null,
      p_street     => p_street,
      p_city       => p_city,
      p_state      => p_state,
      p_zip        => p_zip,
      p_is_primary => p_is_primary,
      p_label      => p_label));
end
$function$;

-- update_service_location stays an update-by-id, but a changed street invalidates
-- the geocode → clear place_id + flag for re-resolution (so street and place_id/coord
-- can never silently disagree).
create or replace function maintenance.update_service_location(
  p_location_id bigint, p_street text default null, p_city text default null,
  p_state text default null, p_zip text default null
) returns jsonb
language plpgsql security definer
as $function$
begin
  update public.service_locations set
    street         = coalesce(p_street, street),
    city           = coalesce(p_city, city),
    state          = coalesce(p_state, state),
    zip            = coalesce(p_zip, zip),
    place_id       = case when p_street is not null and p_street is distinct from street then null else place_id end,
    geocode_status = case when p_street is not null and p_street is distinct from street then 'needs_review' else geocode_status end,
    updated_at     = now()
  where id = p_location_id;
  return jsonb_build_object('location_id', p_location_id);
end
$function$;
