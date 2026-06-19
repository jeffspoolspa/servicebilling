-- place_id: the stable, canonical identity for a service address.
--
-- A geocode coordinate is an OUTPUT and is not a safe dedup key (it drifts across
-- provider data vintages, and the same physical place reached via different query
-- strings returns different coordinates). The resolver's stable place identifier
-- is. We standardize on Google Places `place_id` (Mapbox feature ids are explicitly
-- not stable, so they are NOT used as the key). This lets service_locations be the
-- deduplicated unique-address list that routing is built on.
--
-- The partial unique index (one ACTIVE location per place_id) is added in a later
-- migration, AFTER the one-time backfill populates place_id and reconciles the few
-- legitimate same-address-different-owner rows.

alter table public.service_locations
  add column if not exists place_id       text,
  add column if not exists place_provider text;

comment on column public.service_locations.place_id is
  'Stable canonical place identifier from the address resolver (Google Places place_id). The dedup key: at most one ACTIVE service location per place_id (enforced by a partial unique index once backfilled).';
comment on column public.service_locations.place_provider is
  'Resolver that produced place_id (e.g. google). Mapbox feature ids are not stable and are not used as the dedup key.';
