-- ADR 007 §9: a visit's service_location is derived from its CUSTOMER (found via the task, which
-- is linked authoritatively by ION event_id) -- NOT by independently resolving the raw address.
-- From the task's customer_id, look at the customer's CONFIRMED link-table locations:
--   * exactly one  -> take it
--   * more than one -> fuzzy-match the visit's raw_service_address (pg_trgm) to each, take the best
-- This never changes task_id (billing attribution is untouched) -- only where the visit sits.
-- Idempotent; safe to run on the visit-sync cadence.
create or replace function public.reconcile_visit_locations()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_single int;
  v_fuzzy int;
begin
  with conf as (
    select csa.customer_id, count(*) n, (array_agg(sl.id))[1] as only_loc
    from public.customer_service_addresses csa
    join public.service_locations sl on sl.id = csa.service_location_id
    where csa.is_active and sl.is_active and sl.geocode_status = 'ok' and sl.place_id is not null
    group by csa.customer_id
  ),
  upd as (
    update maintenance.visits v
       set service_location_id = conf.only_loc, updated_at = now()
      from maintenance.tasks t
      join conf on conf.customer_id = t.customer_id and conf.n = 1
     where v.task_id = t.id and v.service_location_id is distinct from conf.only_loc
    returning 1
  )
  select count(*) into v_single from upd;

  with cand as (
    select v.id as visit_id, sl.id as sl_id,
           similarity(upper(coalesce(v.raw_service_address, '')), upper(coalesce(sl.street, ''))) as sim
    from maintenance.visits v
    join maintenance.tasks t on t.id = v.task_id
    join public.customer_service_addresses csa on csa.customer_id = t.customer_id and csa.is_active
    join public.service_locations sl on sl.id = csa.service_location_id
       and sl.is_active and sl.geocode_status = 'ok' and sl.place_id is not null
    where v.raw_service_address is not null
      and t.customer_id in (
        select customer_id from public.customer_service_addresses csa2
        join public.service_locations sl2 on sl2.id = csa2.service_location_id
        where csa2.is_active and sl2.is_active and sl2.geocode_status='ok' and sl2.place_id is not null
        group by customer_id having count(*) > 1)
  ),
  best as (
    select distinct on (visit_id) visit_id, sl_id from cand order by visit_id, sim desc
  ),
  upd2 as (
    update maintenance.visits v
       set service_location_id = best.sl_id, updated_at = now()
      from best
     where v.id = best.visit_id and v.service_location_id is distinct from best.sl_id
    returning 1
  )
  select count(*) into v_fuzzy from upd2;

  return jsonb_build_object('ok', true, 'single_match', v_single, 'fuzzy_match', v_fuzzy);
end
$function$;

grant execute on function public.reconcile_visit_locations() to authenticated, service_role, anon;
select public.reconcile_visit_locations();
