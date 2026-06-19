-- ADR 005: link-table management RPCs for the address detail page (set active owner /
-- unlink). Security-definer so the app's authenticated office users can manage links
-- without per-row RLS. The link itself (find-or-create by place_id + link active) reuses
-- the existing upsert_service_location.

-- Make a specific customer the active owner of an address (or deactivate them). Setting
-- active=true demotes any other active customer at that address (one active owner).
create or replace function public.set_customer_address_active(
  p_customer_id bigint, p_location_id bigint, p_active boolean
) returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if p_active then
    update public.customer_service_addresses set is_active = false, updated_at = now()
     where service_location_id = p_location_id and customer_id <> p_customer_id and is_active;
  end if;
  update public.customer_service_addresses set is_active = p_active, updated_at = now()
   where service_location_id = p_location_id and customer_id = p_customer_id;
end $$;

-- Remove a customer↔address link entirely.
create or replace function public.unlink_customer_address(
  p_customer_id bigint, p_location_id bigint
) returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  delete from public.customer_service_addresses
   where service_location_id = p_location_id and customer_id = p_customer_id;
end $$;

grant execute on function public.set_customer_address_active(bigint, bigint, boolean) to authenticated, service_role;
grant execute on function public.unlink_customer_address(bigint, bigint) to authenticated, service_role;
