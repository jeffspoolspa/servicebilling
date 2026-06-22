-- Remove a service_location from a customer (ADR 007 §9). For cleaning up duplicate / orphan
-- rows the editor's "replace"/"correct" flows left behind (e.g. GRAND HARBOR's two extra
-- "Green Island Road" rows). Safe by construction: REFUSES if the row still has tasks or visits
-- (deleting it would orphan billing data) -- those must be merged/repointed first
-- (merge_service_location). Otherwise it drops the customer link(s) and soft-deletes the row
-- (is_active=false; the maintenance page shows only active rows, so it disappears).
create or replace function public.retire_service_location(p_location_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_tasks int;
  v_visits int;
begin
  if p_location_id is null then raise exception 'retire_service_location: p_location_id required'; end if;
  select count(*) into v_tasks  from maintenance.tasks  where service_location_id = p_location_id;
  select count(*) into v_visits from maintenance.visits where service_location_id = p_location_id;
  if v_tasks > 0 or v_visits > 0 then
    return jsonb_build_object('ok', false, 'reason', 'in_use', 'tasks', v_tasks, 'visits', v_visits);
  end if;

  delete from public.customer_service_addresses where service_location_id = p_location_id;
  update public.service_locations
     set is_active = false, is_primary = false, updated_at = now()
   where id = p_location_id;
  return jsonb_build_object('ok', true, 'location_id', p_location_id);
end
$function$;

grant execute on function public.retire_service_location(bigint) to authenticated, service_role, anon;
