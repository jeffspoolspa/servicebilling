-- ADR 005: customer-list status view + read grants for the address UI.
-- v_customers_with_status drives the customer list (so it can filter "no address + has
-- active task" server-side). Views run security-definer (owner reads the underlying
-- maintenance/link tables); the app's anon/authenticated read-roles just need SELECT.
create or replace view public.v_customers_with_status as
select c.id, c.qbo_customer_id, c.display_name, c.email, c.phone, c.is_active,
  exists(select 1 from public.customer_service_addresses csa
         join public.service_locations sl on sl.id=csa.service_location_id
         where csa.customer_id=c.id and csa.is_active and sl.geocode_status='ok') as has_active_address,
  exists(select 1 from maintenance.tasks t
         where t.customer_id=c.id and t.status='active'
           and (t.ends_on is null or t.ends_on>=current_date)) as has_active_task
from public."Customers" c;

grant select on public.v_customers_with_status        to anon, authenticated, service_role;
grant select on public.v_customer_active_addresses    to anon, authenticated, service_role;
grant select on public.v_service_address_customers    to anon, authenticated, service_role;
grant select on public.v_unresolved_service_addresses to anon, authenticated, service_role;
