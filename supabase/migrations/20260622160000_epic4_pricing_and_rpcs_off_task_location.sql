-- (1) Pricing: a flat-rate task has NO per-visit price -- blank the 54 legacy rows that carry one
-- (the $70.83-on-GRAND-HARBOR artifact). Pricing already lives on the task (task_schedules has no
-- price columns); per-visit is meaningless for flat_rate_monthly.
update maintenance.tasks
   set price_per_visit_cents = null, updated_at = now()
 where billing_method = 'flat_rate_monthly' and price_per_visit_cents is not null;

-- (2) merge_service_location: tasks no longer carry a location (ADR 007 §9), so don't repoint them;
-- detect a shared/junk source via VISITS' customers instead of tasks'.
create or replace function public.merge_service_location(p_from bigint, p_into bigint)
returns jsonb language plpgsql security definer set search_path = public
as $function$
declare v_visits int; v_pools int; v_bodies int; v_links_moved int; v_links_dropped int; v_owners int;
begin
  if p_from is null or p_into is null or p_from = p_into then
    raise exception 'merge_service_location: distinct from/into required (from=%, into=%)', p_from, p_into;
  end if;
  perform 1 from public.service_locations where id = p_into;
  if not found then raise exception 'merge_service_location: into % not found', p_into; end if;
  select count(distinct customer_id) into v_owners
    from maintenance.visits where service_location_id = p_from and customer_id is not null;
  if v_owners > 1 then
    raise exception 'merge_service_location: source % has visits for % customers (shared SL) -- untangle per-customer', p_from, v_owners;
  end if;
  update maintenance.visits set service_location_id = p_into, updated_at = now() where service_location_id = p_from;
  get diagnostics v_visits = row_count;
  update public.pools set service_location_id = p_into, updated_at = now() where service_location_id = p_from;
  get diagnostics v_pools = row_count;
  update maintenance.service_bodies set location_id = p_into where location_id = p_from;
  get diagnostics v_bodies = row_count;
  update public.customer_service_addresses csa
     set service_location_id = p_into
   where csa.service_location_id = p_from
     and not exists (select 1 from public.customer_service_addresses c2
                      where c2.customer_id = csa.customer_id and c2.service_location_id = p_into);
  get diagnostics v_links_moved = row_count;
  delete from public.customer_service_addresses where service_location_id = p_from;
  get diagnostics v_links_dropped = row_count;
  update public.service_locations
     set is_active = false, is_primary = false, duplicate_of_location_id = p_into, updated_at = now()
   where id = p_from;
  return jsonb_build_object('ok', true, 'from', p_from, 'into', p_into,
    'visits_moved', v_visits, 'pools_moved', v_pools, 'service_bodies_moved', v_bodies,
    'links_moved', v_links_moved, 'links_dropped', v_links_dropped);
end $function$;

-- (3) retire_service_location: only VISITS can block now (tasks don't reference a location).
create or replace function public.retire_service_location(p_location_id bigint)
returns jsonb language plpgsql security definer set search_path = public
as $function$
declare v_visits int;
begin
  if p_location_id is null then raise exception 'retire_service_location: p_location_id required'; end if;
  select count(*) into v_visits from maintenance.visits where service_location_id = p_location_id;
  if v_visits > 0 then
    return jsonb_build_object('ok', false, 'reason', 'in_use', 'visits', v_visits);
  end if;
  delete from public.customer_service_addresses where service_location_id = p_location_id;
  update public.service_locations
     set is_active = false, is_primary = false, updated_at = now()
   where id = p_location_id;
  return jsonb_build_object('ok', true, 'location_id', p_location_id);
end $function$;
