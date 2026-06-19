-- ADR 005 follow-up: enforce the invariant "service_locations holds ONLY confirmed
-- rooftop / interpolated addresses — addresses that resolve on Google Maps."
--
-- Root cause of the bad data: Google's Geocoding API returns a COARSE fallback when
-- it cannot find a street — location_type 'APPROXIMATE' with partial_match=true, whose
-- place_id is the CITY (or ZIP / route) centroid, not the address. Example proven live:
--   "1891 FIELD, Fernandina Beach", "484 CROSSWOOD DRIVE, Fernandina Beach", and
--   "210 JEAN LAFITA BLVD, Fernandina Beach" ALL returned the SAME place_id
--   (ChIJF7wAluz-5IgR4zzyykZvENM) = formatted_address "Fernandina Beach, FL 32034".
-- Because place_id is globally unique, the first un-findable address in a city claimed
-- that city centroid's place_id and every later un-findable address in the same city
-- hit unique(place_id), got rolled back, and was mislabeled duplicate_of the first.
-- Those are NOT duplicates — they are unresolved addresses with mangled legacy input.
--
-- Scope (measured): 502 non-'ok' rows were holding a coarse place_id; 156 duplicate_of
-- links across 55 coarse "magnet" canonicals were false (vs 113 links across 88 real
-- rooftop 'ok' canonicals, which are genuine same-building duplicates and are KEPT).
--
-- This migration does NOT delete rows or unlink customers. 850 customers (79 active
-- maintenance, 5,838 visits, 284 task_billing_periods, 64 pools) reference these rows;
-- they stay in place — just flagged non-'ok' with no place_id — until the address is
-- corrected to a real rooftop (or the customer is relinked / left address-less).
--
-- Post-condition:  place_id IS NOT NULL  <=>  geocode_status = 'ok'.

-- 1. Drop coarse place_ids. Any non-'ok' row holding a place_id is holding a city /
--    ZIP / route centroid masquerading as an address-level id — remove it. (Latitude /
--    longitude are kept as a rough, non-authoritative pin for routing continuity.)
update public.service_locations
   set place_id = null,
       place_provider = null,
       updated_at = now()
 where geocode_status is distinct from 'ok'
   and place_id is not null;

-- 2. Break the false duplicate links. A duplicate_of pointer is only meaningful when
--    the canonical is a confirmed rooftop ('ok'). Pointers at coarse canonicals are
--    collision artifacts. Genuine duplicate_of -> 'ok' links are LEFT INTACT for the
--    collapse-or-keep review.
update public.service_locations dup
   set duplicate_of_location_id = null,
       updated_at = now()
  from public.service_locations can
 where dup.duplicate_of_location_id = can.id
   and can.geocode_status is distinct from 'ok';
