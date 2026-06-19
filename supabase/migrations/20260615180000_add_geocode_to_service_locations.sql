-- Geocodes belong on the service (pool) address, not the account's billing address.
--
-- Until now the only coordinates in the system lived on public."Customers"
-- (account-level), populated by f/google_maps/geocode_customers.py geocoding the
-- BILLING address. For ~26 active maintenance customers the billing address is an
-- out-of-state snowbird/owner address, so the cached coordinate landed far outside
-- the SE-GA / NE-FL service area and corrupted route analysis (see app/(shell)/
-- maintenance/_lib/geo.ts SERVICE_BBOX).
--
-- The real pool address already lives on public.service_locations (street/city/
-- state/zip). This migration gives that table its own geocode so routing can read
-- per-service-location coordinates and the billing address stops mattering for maps.

alter table public.service_locations
  add column if not exists latitude       double precision,
  add column if not exists longitude      double precision,
  add column if not exists geocoded_at    timestamptz,
  add column if not exists geocode_source text,
  add column if not exists geocode_status text;

-- Known vocabulary for geocode_status (NULL = not yet attempted).
alter table public.service_locations
  drop constraint if exists service_locations_geocode_status_check;
alter table public.service_locations
  add constraint service_locations_geocode_status_check
  check (geocode_status is null or geocode_status in ('ok', 'out_of_area', 'needs_review', 'failed'));

comment on column public.service_locations.latitude is
  'Geocoded latitude of the service (pool) address. Source of truth for route geocoding; supersedes the legacy account-level Customers.latitude.';
comment on column public.service_locations.longitude is
  'Geocoded longitude of the service (pool) address.';
comment on column public.service_locations.geocoded_at is
  'When latitude/longitude were last set by the geocoding pipeline.';
comment on column public.service_locations.geocode_source is
  'Geocoder that produced the coordinate: google | mapbox | manual.';
comment on column public.service_locations.geocode_status is
  'ok = inside service bbox; out_of_area = geocoded outside the SE-GA/NE-FL bbox; needs_review = ambiguous / street-only / no result; failed = geocoder error. NULL = not yet attempted.';

-- Find active locations that still need a (re)geocode.
create index if not exists idx_service_locations_geocode_pending
  on public.service_locations (id)
  where is_active and latitude is null;
