-- Data layer for the customer-list/detail UI (ADR 005): each customer -> its ACTIVE,
-- valid (rooftop) service address(es) as a JSON array, for the clickable address pills.
-- Many-to-one is supported (a customer can be the active owner of several addresses);
-- today every serviced customer has exactly one, but the UI renders an array of pills.
create or replace view public.v_customer_active_addresses as
select csa.customer_id,
  jsonb_agg(jsonb_build_object(
    'location_id', sl.id, 'street', sl.street, 'city', sl.city, 'state', sl.state,
    'zip', sl.zip, 'place_id', sl.place_id, 'is_primary', sl.is_primary,
    'lat', sl.latitude, 'lng', sl.longitude
  ) order by sl.is_primary desc nulls last, sl.id) as addresses
from public.customer_service_addresses csa
join public.service_locations sl on sl.id = csa.service_location_id
where csa.is_active and sl.geocode_status='ok'
group by csa.customer_id;
