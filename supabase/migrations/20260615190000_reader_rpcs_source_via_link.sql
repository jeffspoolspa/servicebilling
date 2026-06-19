-- ADR 005, Phase 4 (readers): repoint the RPCs that read service_locations.account_id
-- onto the ownership link / explicit customer_id, so they're correct after Phase 5
-- drops account_id. Equivalent results today (account_id mirrors the active owner).
--
-- Unchanged (account_id is on a different table): get_maintenance_lead_detail and
-- get_service_bodies use leads.account_id / service_bodies.account_id; the public
-- get_service_locations wrapper just delegates.

-- "this customer's service locations" → locations where the customer is the active owner
create or replace function maintenance.get_service_locations(p_account_id bigint)
 returns jsonb language sql security definer
as $function$
  select coalesce(jsonb_agg(row_to_json(r) order by r.is_primary desc, r.id), '[]'::jsonb)
  from (
    select sl.* from public.service_locations sl
    join public.customer_service_addresses csa
      on csa.service_location_id = sl.id and csa.is_active
    where csa.customer_id = p_account_id and sl.is_active
  ) r;
$function$;

create or replace function maintenance.search_accounts_by_address(p_street text)
 returns jsonb language plpgsql security definer
as $function$
declare v_pattern text;
begin
  v_pattern := '%' || (string_to_array(trim(p_street), ' '))[1] || ' ' || (string_to_array(trim(p_street), ' '))[2] || '%';
  return coalesce((
    select jsonb_agg(j) from (
      select distinct on (c.id) jsonb_build_object(
        'id', c.id, 'qbo_customer_id', c.qbo_customer_id,
        'display_name', c.display_name, 'account_name', c.account_name,
        'first_name', c.first_name, 'last_name', c.last_name,
        'email', c.email, 'phone', c.phone, 'account_type', c.account_type,
        'street', c.street, 'city', c.city, 'state', c.state, 'zip', c.zip,
        'service_street', sl.street, 'service_city', sl.city,
        'service_state', sl.state, 'service_zip', sl.zip,
        'location_id', sl.id,
        'is_active', c.is_active
      ) as j
      from public.service_locations sl
      join public.customer_service_addresses csa on csa.service_location_id = sl.id and csa.is_active
      join "Customers" c on c.id = csa.customer_id
      where c.is_active = true and sl.is_active = true
        and sl.street ilike v_pattern
    ) r
  ), '[]'::jsonb);
end $function$;

-- chemistry history is per-customer via the explicit visit.customer_id (correct across
-- owner changes — a repointed visit keeps its original owner)
create or replace function public.zc_customer_history(p_customer_id bigint)
 returns json language sql security definer set search_path to 'public','maintenance'
as $function$
  with fc as (
    select vi.visit_date,
           nullif(regexp_replace(vr.value,'[^0-9.]','','g'),'')::numeric as fc
    from maintenance.visit_readings vr
    join maintenance.visits vi on vi.id = vr.visit_id
    where vr.name='Free Chlorine' and vi.customer_id = p_customer_id and vi.visit_date is not null
  ),
  per_day as (
    select visit_date, min(fc) as fc from fc where fc is not null group by visit_date
  )
  select json_build_object(
    'zeros_30d', (select count(*) from per_day where fc = 0 and visit_date >= current_date - 30),
    'prev_zero', (select (fc = 0) from per_day where visit_date < current_date order by visit_date desc limit 1),
    'recent', (select coalesce(json_agg(json_build_object('date', visit_date, 'fc', fc) order by visit_date desc), '[]'::json)
               from (select visit_date, fc from per_day order by visit_date desc limit 3) t)
  );
$function$;

create or replace function public.zc_search_customers(q text)
 returns table(id bigint, display_name text, city text, street text)
 language sql security definer set search_path to 'public'
as $function$
  select c.id, c.display_name,
    (select sl.city   from service_locations sl
        join customer_service_addresses csa on csa.service_location_id=sl.id and csa.is_active
        where csa.customer_id=c.id order by sl.is_primary desc nulls last limit 1),
    (select sl.street from service_locations sl
        join customer_service_addresses csa on csa.service_location_id=sl.id and csa.is_active
        where csa.customer_id=c.id order by sl.is_primary desc nulls last limit 1)
  from "Customers" c
  where c.is_active = true
    and (c.display_name ilike '%'||q||'%' or c.company ilike '%'||q||'%' or c.last_name ilike '%'||q||'%')
  order by c.display_name
  limit 20;
$function$;
