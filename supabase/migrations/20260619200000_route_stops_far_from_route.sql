-- Add a "far from its own route" detector to v_route_stops -- the sharpest wrong-address
-- signal. A stop far from the rest of the pools the tech services that day is almost
-- certainly a bad address (e.g. a Sea Island pool mislabeled to "Savannah" in ION geocodes
-- 60mi from the rest of the Brunswick route). Flag on distance to the route's MEDIAN center
-- (its main body), so two bad addresses that cluster together (STUCKEY + REHLAENDER, both
-- Savannah on one route) are still caught -- distance-to-nearest-mate would miss them.
-- nearest_mate_mi is kept as displayed context (how isolated from the closest route-mate).
-- Matches the existing geo.ts far_from_route convention (>25mi from the tech x day center).

drop view if exists public.v_route_load;
drop view if exists public.v_route_stops;

create view public.v_route_stops as
with base as (
  select
    ts.id                                                                    as schedule_id,
    ts.tech_employee_id,
    nullif(trim(coalesce(e.first_name,'') || ' ' || coalesce(e.last_name,'')), '') as tech_name,
    ts.office, ts.day_of_week, ts.sequence, ts.frequency, ts.ion_task_id,
    t.id as task_id, t.customer_id, c.display_name as customer_name,
    t.service_location_id,
    sl.street, sl.city, sl.state, sl.zip,
    sl.latitude, sl.longitude, sl.geocode_status, sl.place_id,
    (sl.geocode_status = 'ok' and sl.place_id is not null)                   as geo_trusted
  from maintenance.task_schedules ts
  join      maintenance.tasks      t  on t.id  = ts.task_id
  left join public.service_locations sl on sl.id = t.service_location_id
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
  'Route analysis substrate: one row per active task_schedules slot + pinned service_location geocode + tech + customer. geo_trusted = rooftop-confirmed coordinate. is_cross_office = office-territory lens (nearest office >8mi closer than assigned). route_center_mi = miles from the median center of the stop''s own (tech x day) route; far_from_route (>25mi, routes of >=3 located stops) is the wrong-address signal. nearest_mate_mi = miles to the closest other pool on the route (context). Untrusted coords are never used for geography.';

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
  'Per-route (tech x day_of_week) rollup over v_route_stops: stop count, ungeocoded, far_stops (far-from-route count), and dispersion (avg/max miles from route centroid) over TRUSTED coords only.';

grant select on public.v_route_stops to anon, authenticated, service_role;
grant select on public.v_route_load  to anon, authenticated, service_role;
