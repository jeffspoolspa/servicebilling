-- The service log's two new facts per visit: STATUS (completed /
-- non_serviceable / voided — from is_serviceable and the retracted-log
-- stamp) and THE INVOICE the visit rides on (the month's green doc for
-- green tasks, else the service doc).
DROP FUNCTION IF EXISTS public.maint_billing_review_visits(bigint, date);
CREATE OR REPLACE FUNCTION public.maint_billing_review_visits(p_customer_id bigint, p_month date)
 RETURNS TABLE(visit_id uuid, visit_date date, ion_log_id text, service_name text, body text, tech text, minutes integer, notes text, readings jsonb, chems jsonb, photos jsonb, status text, qbo_invoice_id text, invoice_doc_number text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'maintenance', 'public'
AS $function$
  with v as (
    select v.id, v.visit_date::date as d, v.ion_log_id, v.notes,
           vc.service_name,
           nullif(trim(substring(v.service_type from '\d+\s+(.+)$')), '') as body,
           coalesce(nullif(trim(e.first_name || ' ' || e.last_name), ''), v.ion_submitted_by) as tech,
           case when v.started_at is not null and v.ended_at is not null
                then greatest(1, round(extract(epoch from (v.ended_at - v.started_at)) / 60))::int
           end as minutes,
           case when v.ion_deleted_at is not null then 'voided'
                when v.is_serviceable = false then 'non_serviceable'
                else 'completed' end as status,
           t.category as task_category
    from maintenance.visits v
    join maintenance.tasks t on t.id = v.task_id
    left join maintenance.v_task_class vc on vc.task_id = t.id
    left join public.employees e on e.id = v.actual_tech_id
    where t.customer_id = p_customer_id
      and v.visit_date >= p_month
      and v.visit_date < (p_month + interval '1 month')
  ),
  inv as (
    select mi.qbo_invoice_id, mi.doc_number, mi.kind
    from billing.billing_months bm
    join billing.month_invoices mi on mi.billing_month_id = bm.id
    where bm.customer_id = p_customer_id and bm.month = p_month
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
         coalesce(r.readings, '{}'::jsonb), coalesce(c.chems, '[]'::jsonb), coalesce(p.photos, '[]'::jsonb),
         v.status, mi.qbo_invoice_id, mi.doc_number
  from v
  left join r on r.visit_id = v.id
  left join c on c.visit_id = v.id
  left join p on p.ion_log_id = v.ion_log_id
  left join lateral (
    select i.qbo_invoice_id, i.doc_number from inv i
    order by (i.kind = case when v.task_category = 'green_pool' then 'green' else 'service' end) desc
    limit 1
  ) mi on true
  order by v.d desc, body nulls first;
$function$;
GRANT EXECUTE ON FUNCTION public.maint_billing_review_visits(bigint, date) TO authenticated;
