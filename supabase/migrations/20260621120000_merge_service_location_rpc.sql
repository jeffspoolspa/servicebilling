-- Merge a DUPLICATE service_location onto a canonical one (ADR 007). Used when a customer's
-- tasks sit on a raw, un-geocoded service_location while a correct, geocoded one already exists
-- for the same physical place (the editor's "replace" flow created the canonical row but never
-- repointed the tasks -- the O'BRIEN case). Repoints every FK reference from p_from -> p_into,
-- then retires p_from.
--
-- maintenance.visits has no unique key beyond its PK and pools likewise, so visit/pool repoints
-- never collide. customer_service_addresses has UNIQUE(customer_id, service_location_id), so a
-- customer linked to BOTH gets the redundant from-link dropped; one linked only to from gets it
-- repointed.
--
-- SAFETY GUARD: refuses to merge a source that carries tasks for MORE THAN ONE customer (a shared
-- "junk" catch-all SL, e.g. a "." street). Merging by service_location_id moves every task/visit on
-- it regardless of owner, so a shared source would drag unrelated customers onto the target. Those
-- need per-customer untangling, not a blind merge. The caller is otherwise responsible for
-- confirming from/into are the same physical place (the editor does this: the user picks the
-- address, and its place_id identifies the canonical row to merge into).
create or replace function public.merge_service_location(
  p_from bigint,
  p_into bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_tasks int; v_visits int; v_pools int; v_bodies int; v_links_moved int; v_links_dropped int;
  v_owners int;
begin
  if p_from is null or p_into is null or p_from = p_into then
    raise exception 'merge_service_location: distinct from/into required (from=%, into=%)', p_from, p_into;
  end if;
  perform 1 from public.service_locations where id = p_into;
  if not found then raise exception 'merge_service_location: into % not found', p_into; end if;

  select count(distinct customer_id) into v_owners
    from maintenance.tasks where service_location_id = p_from and customer_id is not null;
  if v_owners > 1 then
    raise exception 'merge_service_location: source % has tasks for % customers (shared SL) — untangle per-customer, do not blind-merge', p_from, v_owners;
  end if;

  update maintenance.tasks  set service_location_id = p_into, updated_at = now() where service_location_id = p_from;
  get diagnostics v_tasks = row_count;
  update maintenance.visits set service_location_id = p_into, updated_at = now() where service_location_id = p_from;
  get diagnostics v_visits = row_count;
  update public.pools       set service_location_id = p_into, updated_at = now() where service_location_id = p_from;
  get diagnostics v_pools = row_count;
  update maintenance.service_bodies set location_id = p_into where location_id = p_from;
  get diagnostics v_bodies = row_count;

  -- link to into for any customer linked to from but not yet into (respect the unique)...
  update public.customer_service_addresses csa
     set service_location_id = p_into
   where csa.service_location_id = p_from
     and not exists (select 1 from public.customer_service_addresses c2
                      where c2.customer_id = csa.customer_id and c2.service_location_id = p_into);
  get diagnostics v_links_moved = row_count;
  -- ...and drop the now-redundant from-links (customer already linked to into).
  delete from public.customer_service_addresses where service_location_id = p_from;
  get diagnostics v_links_dropped = row_count;

  update public.service_locations
     set is_active = false, is_primary = false, duplicate_of_location_id = p_into, updated_at = now()
   where id = p_from;

  return jsonb_build_object(
    'ok', true, 'from', p_from, 'into', p_into,
    'tasks_moved', v_tasks, 'visits_moved', v_visits, 'pools_moved', v_pools,
    'service_bodies_moved', v_bodies, 'links_moved', v_links_moved, 'links_dropped', v_links_dropped
  );
end
$function$;

grant execute on function public.merge_service_location(bigint, bigint) to authenticated, service_role, anon;
