-- Route analysis (task_schedules is routing-only). Two app-facing views in public
-- (PostgREST exposes public, same as v_customer_data_quality / v_addresses_needing_resolution).
-- The routing spine: active schedule slot -> task (pins service_location_id) -> geocoded
-- service_location, + tech name + customer. GA planar miles: 1deg lat=69.0, 1deg lng=57.9 (cos 31N).
-- Read by app/(shell)/maintenance/routes/map (the territory overview).

create or replace view public.v_route_stops as
with base as (
  select
    ts.id                                                                    as schedule_id,
    ts.tech_employee_id,
    nullif(trim(coalesce(e.first_name,'') || ' ' || coalesce(e.last_name,'')), '') as tech_name,
    ts.office,
    ts.day_of_week,
    ts.sequence,
    ts.frequency,
    ts.ion_task_id,
    t.id                                                                     as task_id,
    t.customer_id,
    c.display_name                                                           as customer_name,
    t.service_location_id,
    sl.street, sl.city, sl.state, sl.zip,
    sl.latitude, sl.longitude, sl.geocode_status, sl.place_id
  from maintenance.task_schedules ts
  join      maintenance.tasks      t  on t.id  = ts.task_id
  left join public.service_locations sl on sl.id = t.service_location_id
  left join public.employees       e  on e.id  = ts.tech_employee_id
  left join public."Customers"     c  on c.id  = t.customer_id
  where ts.active
)
select b.*,
  case when b.latitude is not null then
    sqrt(
      power((b.latitude  - avg(b.latitude)  over (partition by b.office)) * 69.0, 2) +
      power((b.longitude - avg(b.longitude) over (partition by b.office)) * 57.9, 2)
    )
  end as office_outlier_mi
from base b;

comment on view public.v_route_stops is
  'Route analysis substrate: one row per active task_schedules slot, enriched with the pinned service_location geocode, tech name, and customer. office_outlier_mi = miles from the slot office''s centroid (cross-office leakage signal). Routing-only schedule data per the task_schedules refactor.';

-- per-route (tech x day-of-week) rollup: load + geographic dispersion
create or replace view public.v_route_load as
with centroid as (
  select tech_employee_id, day_of_week,
         avg(latitude) as clat, avg(longitude) as clng
  from public.v_route_stops
  where latitude is not null and day_of_week is not null
  group by 1, 2
)
select
  s.tech_employee_id,
  max(s.tech_name)                                  as tech_name,
  s.day_of_week,
  mode() within group (order by s.office)           as office,
  count(*)                                          as stops,
  count(*) filter (where s.latitude is null)        as ungeocoded,
  round(avg(sqrt(power((s.latitude - c.clat) * 69.0, 2) + power((s.longitude - c.clng) * 57.9, 2)))::numeric, 1) as avg_radius_mi,
  round(max(sqrt(power((s.latitude - c.clat) * 69.0, 2) + power((s.longitude - c.clng) * 57.9, 2)))::numeric, 1) as max_radius_mi
from public.v_route_stops s
join centroid c
  on c.tech_employee_id = s.tech_employee_id and c.day_of_week = s.day_of_week
where s.day_of_week is not null
group by s.tech_employee_id, s.day_of_week;

comment on view public.v_route_load is
  'Per-route (tech x day_of_week) rollup over v_route_stops: stop count, ungeocoded count, and geographic dispersion (avg/max miles from the route centroid). High max_radius_mi with low avg = one far outlier stop.';

grant select on public.v_route_stops to anon, authenticated, service_role;
grant select on public.v_route_load  to anon, authenticated, service_role;
