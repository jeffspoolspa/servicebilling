-- maint_billing_review_visits was timing out (8s statement timeout) on the
-- bill-review page. Two causes:
--   1. the photos CTE aggregated the ENTIRE maintenance.visit_photos table
--      into jsonb on every call (no join to the customer's visits), so the
--      RPC got slower with every photo-ingest run;
--   2. date_trunc('month', visit_date) = p_month is not sargable, and
--      maintenance.visits had no index on task_id for the tasks join.
-- Fix: scope photos to the selected visits, filter by a sargable date range,
-- and index visits(task_id).

create index if not exists idx_visits_task on maintenance.visits (task_id);

create or replace function public.maint_billing_review_visits(p_customer_id bigint, p_month date)
returns table(
  visit_id uuid, visit_date date, ion_log_id text, service_name text,
  body text, tech text, minutes integer, notes text,
  readings jsonb, chems jsonb, photos jsonb
)
language sql stable security definer
set search_path to 'maintenance', 'public'
as $function$
  with v as (
    select v.id, v.visit_date::date as d, v.ion_log_id, v.notes,
           vc.service_name,
           -- body of water = the trailing descriptor on service_type after the
           -- "<service> <price>" base (POOL MAINTENANCE 60 SPA -> SPA); null when
           -- single-body (no suffix)
           nullif(trim(substring(v.service_type from '\d+\s+(.+)$')), '') as body,
           coalesce(nullif(trim(e.first_name || ' ' || e.last_name), ''), v.ion_submitted_by) as tech,
           case when v.started_at is not null and v.ended_at is not null
                then greatest(1, round(extract(epoch from (v.ended_at - v.started_at)) / 60))::int
           end as minutes
    from maintenance.visits v
    join maintenance.tasks t on t.id = v.task_id
    left join maintenance.v_task_class vc on vc.task_id = t.id
    left join public.employees e on e.id = v.actual_tech_id
    where t.customer_id = p_customer_id
      and v.visit_date >= p_month
      and v.visit_date < (p_month + interval '1 month')
  ),
  r as (
    select vr.visit_id, jsonb_object_agg(vr.name, vr.value) as readings
    from maintenance.visit_readings vr join v on v.id = vr.visit_id
    where vr.value is not null and vr.value <> '' group by vr.visit_id
  ),
  c as (
    select cu.visit_id,
           jsonb_agg(jsonb_build_object('item', cu.item_name, 'qty', cu.quantity,
             'cents', (round(cu.quantity * coalesce(cc.unit_price_cents, 0)))::bigint,
             'category', cc.category)
             order by cu.quantity * coalesce(cc.unit_price_cents, 0) desc) as chems
    from maintenance.consumables_usage cu
    left join maintenance.consumables cc on cc.ion_item_id = cu.ion_item_id
    join v on v.id = cu.visit_id
    where cu.item_name is not null group by cu.visit_id
  ),
  p as (
    select vp.ion_log_id,
           jsonb_agg(jsonb_build_object('guid', vp.guid, 'thumb_url', vp.thumb_url,
             's3_key', vp.s3_key, 'uploaded_by', vp.uploaded_by) order by vp.guid) as photos
    from maintenance.visit_photos vp
    join v on v.ion_log_id = vp.ion_log_id
    group by vp.ion_log_id
  )
  select v.id, v.d, v.ion_log_id, v.service_name, v.body, v.tech, v.minutes, v.notes,
         coalesce(r.readings, '{}'::jsonb), coalesce(c.chems, '[]'::jsonb), coalesce(p.photos, '[]'::jsonb)
  from v
  left join r on r.visit_id = v.id
  left join c on c.visit_id = v.id
  left join p on p.ion_log_id = v.ion_log_id
  order by v.d desc, body nulls first;
$function$;
