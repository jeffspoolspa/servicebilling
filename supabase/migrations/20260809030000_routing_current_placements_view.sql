-- Applied via MCP 2026-08-08 as routing_current_placements_view.
-- The PUBLISHED READ SURFACE for placements (RULED: UI reads = published
-- surface, never the aggregate's tables). One row per stop of every
-- ACTIVE agreement's current era, from the routing floor — the strangler
-- read that replaces v_task_schedules_with_context for placement reads.
create or replace view routing.v_current_placements as
select
  sa.id            as agreement_id,
  sa.customer_id,
  q.id             as quota_id,
  q.terms_version,
  pv.version       as placement_version,
  pv.from_date,
  pv.cause,
  (s->>'weekday')::int as weekday,
  s->>'techId'         as tech_id,
  s->>'type'           as stop_type,
  i.ion_task_id
from agreements.service_agreements sa
join lateral (
  select tv.version from agreements.terms_versions tv
  where tv.agreement_id = sa.id and tv.from_at <= now()
  order by tv.version desc limit 1
) cur on true
join routing.quotas q on q.agreement_id = sa.id and q.terms_version = cur.version
join lateral (
  select * from routing.placement_versions p
  where p.quota_id = q.id order by p.version desc limit 1
) pv on true
cross join lateral jsonb_array_elements(pv.stops) s
left join lateral (
  select ion_task_id from agreements.ion_incarnations x
  where x.agreement_id = sa.id and x.to_at is null
    and x.covers->>'stopType' = s->>'type'
  order by x.from_at desc limit 1
) i on true
where sa.status = 'active';
grant select on routing.v_current_placements to service_role;
