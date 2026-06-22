-- Office, like routing, must flow through the customer_service_addresses LINK TABLE, not the
-- legacy service_locations.account_id (PR #21 used account_id and missed the ~10 customer_id ≠
-- account_id cases). Read office from v_customer_primary_location; recompute on link changes too.

create or replace function public.recompute_customer_office(p_customer_id bigint)
returns void language plpgsql security definer set search_path = public
as $function$
declare v_office uuid; v_dist numeric;
begin
  if p_customer_id is null then return; end if;
  if exists (select 1 from public."Customers" where id = p_customer_id and office_overridden) then return; end if;
  select cpl.office_id, cpl.office_distance_mi into v_office, v_dist
  from public.v_customer_primary_location cpl where cpl.customer_id = p_customer_id;
  update public."Customers"
     set office_id = v_office, office_distance_mi = v_dist, office_resolved_at = now()
   where id = p_customer_id
     and (office_id is distinct from v_office or office_distance_mi is distinct from v_dist);
end $function$;

create or replace function public.sync_customer_office_from_sl()
returns trigger language plpgsql
as $function$
begin
  perform public.recompute_customer_office(csa.customer_id)
    from public.customer_service_addresses csa where csa.service_location_id = new.id;
  return null;
end $function$;

create or replace function public.sync_customer_office_from_csa()
returns trigger language plpgsql
as $function$
begin
  perform public.recompute_customer_office(coalesce(new.customer_id, old.customer_id));
  return null;
end $function$;

drop trigger if exists trg_sync_customer_office_csa on public.customer_service_addresses;
create trigger trg_sync_customer_office_csa
  after insert or update or delete on public.customer_service_addresses
  for each row execute function public.sync_customer_office_from_csa();

update public."Customers" c
   set office_id = cpl.office_id, office_distance_mi = cpl.office_distance_mi, office_resolved_at = now()
from public.v_customer_primary_location cpl
where cpl.customer_id = c.id and not c.office_overridden
  and (c.office_id is distinct from cpl.office_id or c.office_distance_mi is distinct from cpl.office_distance_mi);
