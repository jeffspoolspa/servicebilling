-- Address-FIRST view (the correct framing for ADR 005): the address is the entity,
-- customers attach to it (many over time, exactly one active). One row per
-- service_location with its place_id, status, and the JSON array of linked customers
-- (active flag + serviced flag). This is the surface for the active-owner decision
-- (which linked customer is current at a shared address) and the address registry review.
create or replace view public.v_service_address_customers as
with sc as (select distinct customer_id from maintenance.tasks)
select
  sl.id                       as location_id,
  sl.place_id,
  sl.street, sl.city, sl.state, sl.zip,
  sl.geocode_status, sl.geocode_source,
  sl.latitude, sl.longitude,
  count(csa.customer_id)                        as customer_count,
  count(*) filter (where csa.is_active)         as active_count,
  coalesce(jsonb_agg(jsonb_build_object(
    'customer_id', c.id, 'name', c.display_name, 'type', c.account_type,
    'is_active', csa.is_active,
    'serviced', (sc.customer_id is not null)
  ) order by csa.is_active desc nulls last, c.display_name)
    filter (where c.id is not null), '[]'::jsonb) as customers
from public.service_locations sl
left join public.customer_service_addresses csa on csa.service_location_id = sl.id
left join public."Customers" c on c.id = csa.customer_id
left join sc on sc.customer_id = c.id
group by sl.id;
