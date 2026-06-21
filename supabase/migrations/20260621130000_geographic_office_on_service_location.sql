-- ADR 007: office is ONE geographic value, derived from the SERVICE location (the pool),
-- not billing and not the deprecated maintenance.task_schedules.office.
--
-- Problem: office was assigned three ways -- (a) Customers.office_id from resolve_office on
-- the BILLING coordinate (wrong for snowbirds, null when billing isn't geocoded), (b) the
-- routing UI read maintenance.task_schedules.office (deprecated, null on ~41 customers ->
-- "Unassigned"), (c) work_orders.office_name (free-text ION). This makes office the nearest
-- branch to the POOL coordinate, the single source of truth, and repoints the routing views.

-- 1. Geographic office ON the service location (nearest branch to the pool's own coordinate)
alter table public.service_locations
  add column if not exists office_id uuid references public.branches(id),
  add column if not exists office_distance_mi numeric;

-- 2. Keep it fresh: (re)derive whenever the location's coordinate changes (e.g. the geocoder
--    pins it, or the editor corrects it). No coordinate -> no office.
create or replace function public.set_service_location_office()
returns trigger language plpgsql as $$
begin
  if new.geocode_status = 'ok' and new.latitude is not null and new.longitude is not null then
    select r.office_id, r.distance_mi
      into new.office_id, new.office_distance_mi
      from public.resolve_office(new.latitude, new.longitude) r;
  else
    new.office_id := null;
    new.office_distance_mi := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_set_sl_office on public.service_locations;
create trigger trg_set_sl_office
  before insert or update of latitude, longitude, geocode_status on public.service_locations
  for each row execute function public.set_service_location_office();

-- 3. Backfill existing locations from their own coordinate
update public.service_locations sl
set office_id = sub.office_id, office_distance_mi = sub.distance_mi
from (
  select s.id, r.office_id, r.distance_mi
  from public.service_locations s
  cross join lateral public.resolve_office(s.latitude, s.longitude) r
  where s.geocode_status = 'ok' and s.latitude is not null and s.longitude is not null
) sub
where sub.id = sl.id and sl.office_id is distinct from sub.office_id;

update public.service_locations
set office_id = null, office_distance_mi = null
where (geocode_status is distinct from 'ok' or latitude is null) and office_id is not null;

-- 4. Account office now follows the SERVICE location (was billing-based). Pick the customer's
--    representative service location: primary first, then most-recently geocoded.
with rep as (
  select distinct on (sl.account_id)
         sl.account_id as cid, sl.office_id, sl.office_distance_mi
  from public.service_locations sl
  where sl.account_id is not null and sl.office_id is not null and sl.is_active
  order by sl.account_id, sl.is_primary desc nulls last, sl.geocoded_at desc nulls last
)
update public."Customers" c
set office_id = rep.office_id,
    office_distance_mi = rep.office_distance_mi,
    office_resolved_at = now()
from rep
where rep.cid = c.id and c.office_id is distinct from rep.office_id;

-- 5. Repoint the routing views off task_schedules.office and onto the geographic branch.
--    short office label (split "Brunswick, GA" -> "Brunswick") so the existing UI labels hold.
create or replace view maintenance.v_routes_summary as
 select split_part(b.name, ',', 1)                  as office,
    ts.tech_employee_id,
    (emp.first_name || ' '::text) || emp.last_name  as tech_name,
    ts.day_of_week,
    count(*)                                          as stop_count,
    sum(t.price_per_visit_cents)                      as total_price_cents,
    sum(case when t.billing_method = 'flat_rate_monthly'::text then t.price_per_visit_cents else 0 end) as flat_rate_per_visit_cents,
    sum(case when t.billing_method = 'per_visit'::text         then t.price_per_visit_cents else 0 end) as per_visit_cents,
    sum(case when ts.frequency = 'weekly'::text   then 1 else 0 end) as weekly_count,
    sum(case when ts.frequency ~~ 'biweekly%'::text then 1 else 0 end) as biweekly_count,
    sum(case when ts.frequency = 'monthly'::text  then 1 else 0 end) as monthly_count
   from maintenance.task_schedules ts
     join maintenance.tasks t          on t.id = ts.task_id and t.status = 'active'::text
     left join public.service_locations sl on sl.id = t.service_location_id
     left join public.branches b       on b.id = sl.office_id
     left join public.employees emp    on emp.id = ts.tech_employee_id
  where ts.active and ts.tech_employee_id is not null and ts.day_of_week is not null
  group by split_part(b.name, ',', 1), ts.tech_employee_id, emp.first_name, emp.last_name, ts.day_of_week;

-- v_route_stops: same substrate, but office is the geographic branch (not ts.office).
drop view if exists public.v_route_load;
drop view if exists public.v_route_stops;

create view public.v_route_stops as
with base as (
  select
    ts.id                                                                    as schedule_id,
    ts.tech_employee_id,
    nullif(trim(coalesce(e.first_name,'') || ' ' || coalesce(e.last_name,'')), '') as tech_name,
    split_part(b.name, ',', 1)        as office,        -- geographic office (nearest branch to the pool)
    ts.day_of_week, ts.sequence, ts.frequency, ts.ion_task_id,
    t.id as task_id, t.customer_id, c.display_name as customer_name,
    t.service_location_id,
    sl.street, sl.city, sl.state, sl.zip,
    sl.latitude, sl.longitude, sl.geocode_status, sl.place_id,
    sl.office_distance_mi,
    (sl.geocode_status = 'ok' and sl.place_id is not null)                   as geo_trusted
  from maintenance.task_schedules ts
  join      maintenance.tasks      t  on t.id  = ts.task_id
  left join public.service_locations sl on sl.id = t.service_location_id
  left join public.branches        b  on b.id  = sl.office_id
  left join public.employees       e  on e.id  = ts.tech_employee_id
  left join public."Customers"     c  on c.id  = t.customer_id
  where ts.active
),
office_centers as (
  select office,
    percentile_cont(0.5) within group (order by latitude)  as clat,
    percentile_cont(0.5) within group (order by longitude) as clng
  from base where geo_trusted and office is not null group by office
),
route_centers as (
  select tech_employee_id, day_of_week,
    percentile_cont(0.5) within group (order by latitude)  as rlat,
    percentile_cont(0.5) within group (order by longitude) as rlng,
    count(*) as route_mates
  from base where geo_trusted and tech_employee_id is not null and day_of_week is not null
  group by tech_employee_id, day_of_week
),
nearest_mate as (
  select a.schedule_id,
    min(sqrt(power((a.latitude - b.latitude) * 69.0, 2) + power((a.longitude - b.longitude) * 57.9, 2))) as nm_mi
  from base a
  join base b
    on b.tech_employee_id = a.tech_employee_id and b.day_of_week = a.day_of_week
   and b.schedule_id <> a.schedule_id and b.geo_trusted
  where a.geo_trusted and a.tech_employee_id is not null and a.day_of_week is not null
  group by a.schedule_id
),
enriched as (
  select b.*,
    case when b.geo_trusted then
      (select sqrt(power((b.latitude - c.clat) * 69.0, 2) + power((b.longitude - c.clng) * 57.9, 2))
         from office_centers c where c.office = b.office) end as office_center_mi,
    onn.office as nearest_office,
    onn.mi     as nearest_office_mi,
    rc.route_mates,
    case when b.geo_trusted and rc.rlat is not null then
      sqrt(power((b.latitude - rc.rlat) * 69.0, 2) + power((b.longitude - rc.rlng) * 57.9, 2))
    end as route_center_mi,
    nm.nm_mi as nearest_mate_mi
  from base b
  left join lateral (
    select c.office, sqrt(power((b.latitude - c.clat) * 69.0, 2) + power((b.longitude - c.clng) * 57.9, 2)) as mi
    from office_centers c where b.geo_trusted order by mi asc limit 1
  ) onn on true
  left join route_centers rc on rc.tech_employee_id = b.tech_employee_id and rc.day_of_week = b.day_of_week
  left join nearest_mate  nm on nm.schedule_id = b.schedule_id
)
select e.*,
  (e.geo_trusted and e.office is not null and e.nearest_office is not null
    and e.nearest_office <> e.office and e.office_center_mi is not null
    and (e.office_center_mi - e.nearest_office_mi) > 8)                       as is_cross_office,
  (e.geo_trusted and coalesce(e.route_mates, 0) >= 3
    and e.route_center_mi is not null and e.route_center_mi > 25)            as far_from_route
from enriched e;

comment on view public.v_route_stops is
  'Route analysis substrate: one row per active task_schedules slot + pinned service_location geocode + tech + customer. office = the GEOGRAPHIC branch nearest the pool (service_locations.office_id -> branches), ADR 007 -- not the deprecated task_schedules.office. geo_trusted = rooftop-confirmed coordinate. far_from_route (>25mi from the median center of the stop''s own tech x day route, routes of >=3 located stops) is the wrong-address signal. Untrusted coords are never used for geography.';

create view public.v_route_load as
with centroid as (
  select tech_employee_id, day_of_week, avg(latitude) as clat, avg(longitude) as clng
  from public.v_route_stops where geo_trusted and day_of_week is not null group by 1, 2
)
select
  s.tech_employee_id, max(s.tech_name) as tech_name, s.day_of_week,
  mode() within group (order by s.office)           as office,
  count(*)                                          as stops,
  count(*) filter (where not s.geo_trusted)         as ungeocoded,
  count(*) filter (where s.far_from_route)          as far_stops,
  round(avg(sqrt(power((s.latitude - c.clat) * 69.0, 2) + power((s.longitude - c.clng) * 57.9, 2)))
        filter (where s.geo_trusted)::numeric, 1)   as avg_radius_mi,
  round(max(sqrt(power((s.latitude - c.clat) * 69.0, 2) + power((s.longitude - c.clng) * 57.9, 2)))
        filter (where s.geo_trusted)::numeric, 1)   as max_radius_mi
from public.v_route_stops s
left join centroid c on c.tech_employee_id = s.tech_employee_id and c.day_of_week = s.day_of_week
where s.day_of_week is not null
group by s.tech_employee_id, s.day_of_week;

comment on view public.v_route_load is
  'Per-route (tech x day_of_week) rollup over v_route_stops: stop count, ungeocoded, far_stops, and dispersion (avg/max miles from route centroid) over TRUSTED coords only.';

grant select on public.v_route_stops to anon, authenticated, service_role;
grant select on public.v_route_load  to anon, authenticated, service_role;
