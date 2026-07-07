-- Per-VISIT detail for the bill-review workbench (design 2a): one row per
-- visit with tech, notes, duration, readings, consumables (with cents), and
-- the log's photos (public S3 thumb + s3_key for signed full-size).
-- Differs from maint_billing_customer_visits (per-DAY aggregates for chips):
-- the workbench needs the raw visit grain + photos + notes.
create or replace function public.maint_billing_review_visits(
  p_customer_id bigint,
  p_month date
)
returns table (
  visit_id      uuid,
  visit_date    date,
  ion_log_id    text,
  service_name  text,
  body          text,   -- ION ServiceProfile: the body of water
  tech          text,
  minutes       int,
  notes         text,
  readings      jsonb,  -- {name: value-text}
  chems         jsonb,  -- [{item, qty, cents, category}] by cents desc
  photos        jsonb   -- [{guid, thumb_url, s3_key, uploaded_by}]
)
language sql stable security definer
set search_path = maintenance, public
as $$
  with v as (
    select v.id, v.visit_date::date as d, v.ion_log_id, v.notes,
           vc.service_name,
           nullif(trim(v.service_profile), '') as body,
           coalesce(nullif(trim(e.first_name || ' ' || e.last_name), ''), v.ion_submitted_by) as tech,
           case when v.started_at is not null and v.ended_at is not null
                then greatest(1, round(extract(epoch from (v.ended_at - v.started_at)) / 60))::int
           end as minutes
    from maintenance.visits v
    join maintenance.tasks t on t.id = v.task_id
    left join maintenance.v_task_class vc on vc.task_id = t.id
    left join public.employees e on e.id = v.actual_tech_id
    where t.customer_id = p_customer_id
      and date_trunc('month', v.visit_date)::date = p_month
  ),
  r as (
    select vr.visit_id, jsonb_object_agg(vr.name, vr.value) as readings
    from maintenance.visit_readings vr join v on v.id = vr.visit_id
    where vr.value is not null and vr.value <> ''
    group by vr.visit_id
  ),
  c as (
    select cu.visit_id,
           jsonb_agg(jsonb_build_object(
             'item', cu.item_name, 'qty', cu.quantity,
             'cents', (round(cu.quantity * coalesce(cc.unit_price_cents, 0)))::bigint,
             'category', cc.category)
             order by cu.quantity * coalesce(cc.unit_price_cents, 0) desc) as chems
    from maintenance.consumables_usage cu
    left join maintenance.consumables cc on cc.ion_item_id = cu.ion_item_id
    join v on v.id = cu.visit_id
    where cu.item_name is not null
    group by cu.visit_id
  ),
  p as (
    select vp.ion_log_id,
           jsonb_agg(jsonb_build_object(
             'guid', vp.guid, 'thumb_url', vp.thumb_url,
             's3_key', vp.s3_key, 'uploaded_by', vp.uploaded_by)
             order by vp.guid) as photos
    from maintenance.visit_photos vp
    group by vp.ion_log_id
  )
  select v.id, v.d, v.ion_log_id, v.service_name, v.body, v.tech, v.minutes, v.notes,
         coalesce(r.readings, '{}'::jsonb),
         coalesce(c.chems, '[]'::jsonb),
         coalesce(p.photos, '[]'::jsonb)
  from v
  left join r on r.visit_id = v.id
  left join c on c.visit_id = v.id
  left join p on p.ion_log_id = v.ion_log_id
  order by v.d desc;
$$;

revoke all on function public.maint_billing_review_visits(bigint, date) from public, anon;
grant execute on function public.maint_billing_review_visits(bigint, date) to authenticated, service_role;
