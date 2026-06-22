-- ADR 007 §9 epic, step 1: a route stop's location is the CUSTOMER's primary confirmed service
-- location (task -> customer -> location), not the task's own service_location_id. This is the
-- reader repoint that de-risks "no address on the task"; the column still exists (reversible).

-- The one confirmed (geocoded-ok, rooftop) active service location per customer: primary first,
-- then most-recently geocoded. Only CONFIRMED rows are candidates (ADR 007 §9 — never match to an
-- unconfirmed address).
create or replace view public.v_customer_primary_location as
select distinct on (sl.account_id)
  sl.account_id          as customer_id,
  sl.id                  as service_location_id,
  sl.street, sl.city, sl.state, sl.zip,
  sl.latitude, sl.longitude, sl.place_id, sl.geocode_status,
  sl.office_id, sl.office_distance_mi
from public.service_locations sl
where sl.is_active and sl.geocode_status = 'ok' and sl.place_id is not null
  and sl.account_id is not null
order by sl.account_id, sl.is_primary desc nulls last, sl.geocoded_at desc nulls last;

grant select on public.v_customer_primary_location to anon, authenticated, service_role;

drop view if exists public.v_route_load;
drop view if exists public.v_route_stops;

create view public.v_route_stops as
with base as (
  select
    ts.id                                                                    as schedule_id,
    ts.tech_employee_id,
    nullif(trim(coalesce(e.first_name,'') || ' ' || coalesce(e.last_name,'')), '') as tech_name,
    split_part(tb.name, ',', 1)        as office,             -- ROUTE office = the TECH's branch
    e.branch_id                        as tech_office_id,
    ts.day_of_week, ts.sequence, ts.frequency, ts.ion_task_id,
    t.id as task_id, t.customer_id, c.display_name as customer_name,
    cpl.service_location_id,                                  -- the CUSTOMER's primary confirmed location
    cpl.street, cpl.city, cpl.state, cpl.zip,
    cpl.latitude, cpl.longitude, cpl.geocode_status, cpl.place_id,
    cpl.office_distance_mi,
    split_part(cb.name, ',', 1)        as customer_office,     -- the CUSTOMER's office (geography/override)
    c.office_id                        as customer_office_id,
    (cpl.service_location_id is not null)                                    as geo_trusted
  from maintenance.task_schedules ts
  join      maintenance.tasks      t   on t.id  = ts.task_id
  left join public."Customers"     c   on c.id  = t.customer_id
  left join public.v_customer_primary_location cpl on cpl.customer_id = t.customer_id
  left join public.employees       e   on e.id  = ts.tech_employee_id
  left join public.branches        tb  on tb.id = e.branch_id
  left join public.branches        cb  on cb.id = c.office_id
  where ts.active
),
office_centers as (
  select customer_office,
    percentile_cont(0.5) within group (order by latitude)  as clat,
    percentile_cont(0.5) within group (order by longitude) as clng
  from base where geo_trusted and customer_office is not null group by customer_office
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
         from office_centers c where c.customer_office = b.customer_office) end as office_center_mi,
    onn.office as nearest_office,
    onn.mi     as nearest_office_mi,
    rc.route_mates,
    case when b.geo_trusted and rc.rlat is not null then
      sqrt(power((b.latitude - rc.rlat) * 69.0, 2) + power((b.longitude - rc.rlng) * 57.9, 2))
    end as route_center_mi,
    nm.nm_mi as nearest_mate_mi
  from base b
  left join lateral (
    select c.customer_office as office, sqrt(power((b.latitude - c.clat) * 69.0, 2) + power((b.longitude - c.clng) * 57.9, 2)) as mi
    from office_centers c where b.geo_trusted order by mi asc limit 1
  ) onn on true
  left join route_centers rc on rc.tech_employee_id = b.tech_employee_id and rc.day_of_week = b.day_of_week
  left join nearest_mate  nm on nm.schedule_id = b.schedule_id
)
select e.*,
  (e.customer_office_id is not null and e.tech_office_id is not null
    and e.customer_office_id <> e.tech_office_id)                            as is_cross_office,
  (e.geo_trusted and coalesce(e.route_mates, 0) >= 3
    and e.route_center_mi is not null and e.route_center_mi > 25)            as far_from_route
from enriched e;

comment on view public.v_route_stops is
  'Route analysis substrate: one row per active task_schedules slot. The stop LOCATION = the customer''s primary confirmed service location (task -> customer -> v_customer_primary_location), ADR 007 §9 -- not tasks.service_location_id. office = the TECH''s branch (route = tech x day). customer_office = the customer''s own office. is_cross_office = customer_office <> route office. far_from_route (>25mi from the route median) = wrong-address signal. geo_trusted = the customer has a confirmed location.';

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
  'Per-route (tech x day) rollup over v_route_stops. office = the tech''s branch.';

grant select on public.v_route_stops to anon, authenticated, service_role;
grant select on public.v_route_load  to anon, authenticated, service_role;
