-- Fix: the customer's primary confirmed location comes from the customer_service_addresses LINK
-- TABLE (ADR 005 — the authoritative customer↔location link), not service_locations.account_id
-- (the legacy owner, which mismatches the task's authoritative customer_id for ~10 customers, e.g.
-- BEANE BOB1 #475 whose location is owned by account_id 474). Link-table coverage is 474/474 active.
create or replace view public.v_customer_primary_location as
select distinct on (csa.customer_id)
  csa.customer_id,
  sl.id                  as service_location_id,
  sl.street, sl.city, sl.state, sl.zip,
  sl.latitude, sl.longitude, sl.place_id, sl.geocode_status,
  sl.office_id, sl.office_distance_mi
from public.customer_service_addresses csa
join public.service_locations sl on sl.id = csa.service_location_id
where csa.is_active and sl.is_active and sl.geocode_status = 'ok' and sl.place_id is not null
order by csa.customer_id, sl.is_primary desc nulls last, sl.geocoded_at desc nulls last;
