-- ADR 007 §9: a route is tech x day, so a route's office is the TECH's office
-- (employees.branch_id), independent of which office each customer belongs to. Repoint the
-- routing views off the pool's geographic office (service_locations.office_id) and onto the
-- tech's branch. Expose the CUSTOMER's office per stop too, so a stop where the customer's
-- office != the tech's office is the (now clean) cross-office signal -- distinct from §7's
-- distance-based far_from_route wrong-address signal. Nothing is denormalized: office is read
-- from employees.branch_id (route) and Customers.office_id (customer), joined here.

-- Route summary: office = the tech's branch. Every (tech, day) now has exactly ONE office
-- (the tech's), so the routes page's "pick the tech's dominant office" merge becomes a no-op.
create or replace view maintenance.v_routes_summary as
 select split_part(tb.name, ',', 1)                 as office,           -- TECH's branch
    ts.tech_employee_id,
    (emp.first_name || ' '::text) || emp.last_name   as tech_name,
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
     left join public.employees emp     on emp.id = ts.tech_employee_id
     left join public.branches tb       on tb.id = emp.branch_id
  where ts.active and ts.tech_employee_id is not null and ts.day_of_week is not null
  group by split_part(tb.name, ',', 1), ts.tech_employee_id, emp.first_name, emp.last_name, ts.day_of_week;

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
    t.service_location_id,
    sl.street, sl.city, sl.state, sl.zip,
    sl.latitude, sl.longitude, sl.geocode_status, sl.place_id,
    sl.office_distance_mi,
    split_part(cb.name, ',', 1)        as customer_office,     -- the CUSTOMER's office (geography/override)
    c.office_id                        as customer_office_id,
    (sl.geocode_status = 'ok' and sl.place_id is not null)                   as geo_trusted
  from maintenance.task_schedules ts
  join      maintenance.tasks      t  on t.id  = ts.task_id
  left join public.service_locations sl on sl.id = t.service_location_id
  left join public."Customers"     c  on c.id  = t.customer_id
  left join public.employees       e  on e.id  = ts.tech_employee_id
  left join public.branches        tb on tb.id = e.branch_id
  left join public.branches        cb on cb.id = c.office_id
  where ts.active
),
office_centers as (   -- geographic median per CUSTOMER office (the real geography, for nearest_office)
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
  -- cross-office = the customer's geographic office differs from the route/tech's office.
  (e.customer_office_id is not null and e.tech_office_id is not null
    and e.customer_office_id <> e.tech_office_id)                            as is_cross_office,
  (e.geo_trusted and coalesce(e.route_mates, 0) >= 3
    and e.route_center_mi is not null and e.route_center_mi > 25)            as far_from_route
from enriched e;

comment on view public.v_route_stops is
  'Route analysis substrate: one row per active task_schedules slot. office = the ROUTE office = the TECH''s branch (employees.branch_id), ADR 007 §9 -- a route is tech x day. customer_office = the customer''s own office (Customers.office_id, geography/override). is_cross_office = customer_office <> route office (a misassignment). far_from_route (>25mi from the median center of the stop''s own tech x day route) is the distance-based wrong-address signal. geo_trusted = rooftop-confirmed coordinate; untrusted coords never used for geography.';

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
  'Per-route (tech x day) rollup over v_route_stops: stop count, ungeocoded, far_stops, dispersion (avg/max miles from route centroid) over TRUSTED coords only. office = the tech''s branch.';

grant select on public.v_route_stops to anon, authenticated, service_role;
grant select on public.v_route_load  to anon, authenticated, service_role;