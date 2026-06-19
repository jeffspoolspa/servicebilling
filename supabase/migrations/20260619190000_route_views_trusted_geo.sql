-- Trustworthy route geography. The route views previously trusted ANY non-null lat/lng,
-- but ~346 active service_locations carry stale coordinates despite never confidently
-- geocoding (geocode_status != 'ok', no place_id) -- e.g. a Sea Island address stuck at a
-- bogus point 62mi north. Those produced phantom cross-office "outliers" (a Sea Island
-- stop "belongs to Richmond Hill"). Two fixes, both in the read path:
--   1. Trust a coordinate ONLY when geocode_status='ok' AND place_id is set (geo_trusted) --
--      the ADR-005 rooftop-only invariant. Untrusted coords are never used for geography.
--   2. Redefine a cross-office stop as one whose NEAREST office (by a robust MEDIAN center
--      over trusted coords) is clearly (>8mi) closer than its ASSIGNED office -- not "far
--      from a mean centroid" (which bad points and legitimate far assignments both skewed).

drop view if exists public.v_route_load;
drop view if exists public.v_route_stops;

create view public.v_route_stops as
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
    sl.latitude, sl.longitude, sl.geocode_status, sl.place_id,
    (sl.geocode_status = 'ok' and sl.place_id is not null)                   as geo_trusted
  from maintenance.task_schedules ts
  join      maintenance.tasks      t  on t.id  = ts.task_id
  left join public.service_locations sl on sl.id = t.service_location_id
  left join public.employees       e  on e.id  = ts.tech_employee_id
  left join public."Customers"     c  on c.id  = t.customer_id
  where ts.active
),
centers as (
  -- robust office center: median of TRUSTED coords (immune to bad points + far assignments)
  select office,
    percentile_cont(0.5) within group (order by latitude)  as clat,
    percentile_cont(0.5) within group (order by longitude) as clng
  from base
  where geo_trusted and office is not null
  group by office
),
enriched as (
  select b.*,
    case when b.geo_trusted then
      (select sqrt(power((b.latitude - c.clat) * 69.0, 2) + power((b.longitude - c.clng) * 57.9, 2))
         from centers c where c.office = b.office)
    end as office_center_mi,
    nn.office as nearest_office,
    nn.mi     as nearest_office_mi
  from base b
  left join lateral (
    select c.office, sqrt(power((b.latitude - c.clat) * 69.0, 2) + power((b.longitude - c.clng) * 57.9, 2)) as mi
    from centers c
    where b.geo_trusted
    order by mi asc
    limit 1
  ) nn on true
)
select e.*,
  (e.geo_trusted
    and e.office is not null
    and e.nearest_office is not null
    and e.nearest_office <> e.office
    and e.office_center_mi is not null
    and (e.office_center_mi - e.nearest_office_mi) > 8) as is_cross_office
from enriched e;

comment on view public.v_route_stops is
  'Route analysis substrate: one row per active task_schedules slot + pinned service_location geocode + tech + customer. geo_trusted = coordinate is rooftop-confirmed (geocode_status=ok AND place_id). nearest_office = closest office by robust median center over trusted coords. is_cross_office = a trusted, office-assigned stop whose nearest office is >8mi closer than its assigned office (a clear cross-office misassignment; boundary stops are not flagged). Untrusted coords are never used for geography.';

create view public.v_route_load as
with centroid as (
  select tech_employee_id, day_of_week, avg(latitude) as clat, avg(longitude) as clng
  from public.v_route_stops
  where geo_trusted and day_of_week is not null
  group by 1, 2
)
select
  s.tech_employee_id,
  max(s.tech_name)                                  as tech_name,
  s.day_of_week,
  mode() within group (order by s.office)           as office,
  count(*)                                          as stops,
  count(*) filter (where not s.geo_trusted)         as ungeocoded,
  round(avg(sqrt(power((s.latitude - c.clat) * 69.0, 2) + power((s.longitude - c.clng) * 57.9, 2)))
        filter (where s.geo_trusted)::numeric, 1)   as avg_radius_mi,
  round(max(sqrt(power((s.latitude - c.clat) * 69.0, 2) + power((s.longitude - c.clng) * 57.9, 2)))
        filter (where s.geo_trusted)::numeric, 1)   as max_radius_mi
from public.v_route_stops s
left join centroid c
  on c.tech_employee_id = s.tech_employee_id and c.day_of_week = s.day_of_week
where s.day_of_week is not null
group by s.tech_employee_id, s.day_of_week;

comment on view public.v_route_load is
  'Per-route (tech x day_of_week) rollup over v_route_stops: stop count, ungeocoded (untrusted-coord) count, and geographic dispersion (avg/max miles from route centroid) over TRUSTED coords only.';

grant select on public.v_route_stops to anon, authenticated, service_role;
grant select on public.v_route_load  to anon, authenticated, service_role;
