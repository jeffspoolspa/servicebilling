-- Customers with ACTIVE maintenance tasks whose service address is unresolved, so they
-- can't be geocoded -> can't get a geographic office -> can't be placed on a route. The
-- prominent banner in the maintenance shell (app/(shell)/maintenance/layout.tsx) reads this;
-- resolving the address (in-app editor on the customer page) clears the row. (ADR 007: a
-- city-less / unresolved address is flagged needs_review rather than guessed.)
create or replace view public.v_maintenance_unrouted as
select distinct on (c.id)
  c.id                                            as customer_id,
  c.display_name,
  sl.id                                           as service_location_id,
  sl.street,
  sl.city,
  sl.zip,
  case
    when t.service_location_id is null then 'no_location'
    else coalesce(sl.geocode_status, 'no_location')
  end                                             as reason
from maintenance.tasks t
join public."Customers" c             on c.id = t.customer_id
left join public.service_locations sl on sl.id = t.service_location_id
where t.status = 'active'
  and ( t.service_location_id is null
        or sl.geocode_status is distinct from 'ok'
        or sl.latitude is null )
order by c.id, sl.geocode_status nulls first;

grant select on public.v_maintenance_unrouted to anon, authenticated, service_role;
