-- The visit's WHOLE total: labor joins the chems. Labor is FROZEN from
-- billable_items once the month is invoiced (the ledger is the truth of
-- what was billed), and LIVE from the task's current per-visit terms while
-- uninvoiced — a task rate change shows immediately on unbilled visits.
-- Non-completed visits derive $0 live (they do not bill).
DROP FUNCTION IF EXISTS public.maint_billing_review_visits(bigint, date);
CREATE OR REPLACE FUNCTION public.maint_billing_review_visits(p_customer_id bigint, p_month date)
 RETURNS TABLE(visit_id uuid, visit_date date, ion_log_id text, service_name text, body text, tech text, minutes integer, notes text, readings jsonb, chems jsonb, photos jsonb, status text, qbo_invoice_id text, invoice_doc_number text, labor_cents bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'maintenance', 'public'
AS $function$
  with v as (
    select v.id, v.visit_date::date as d, v.ion_log_id, v.notes, v.task_id,
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
  month_state as (
    select bm.id, bm.invoiced_at is not null as invoiced
    from billing.billing_months bm
    where bm.customer_id = p_customer_id and bm.month = p_month
  ),
  inv as (
    select mi.qbo_invoice_id, mi.doc_number, mi.kind
    from month_state ms
    join billing.month_invoices mi on mi.billing_month_id = ms.id
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
         v.status, mi.qbo_invoice_id, mi.doc_number,
         coalesce(lab.cents, 0)::bigint
  from v
  left join r on r.visit_id = v.id
  left join c on c.visit_id = v.id
  left join p on p.ion_log_id = v.ion_log_id
  left join lateral (
    select i.qbo_invoice_id, i.doc_number from inv i
    order by (i.kind = case when v.task_category = 'green_pool' then 'green' else 'service' end) desc
    limit 1
  ) mi on true
  left join lateral (
    select case
      when exists (select 1 from month_state ms where ms.invoiced) then
        (select sum(bi.amount_cents) from billing.billable_items bi
          join month_state ms on ms.id = bi.billing_month_id
          where bi.task_id = v.task_id and bi.service_date = v.d and bi.kind = 'labor')
      when v.status <> 'completed' then 0
      else
        (select tt.price_per_visit_cents from maintenance.task_terms tt
          where tt.task_id = v.task_id and tt.billing_method = 'per_visit'
            and tt.valid_from <= v.d and (tt.valid_to is null or tt.valid_to >= v.d)
          order by tt.valid_from desc limit 1)
      end as cents
  ) lab on true
  order by v.d desc, body nulls first;
$function$;
GRANT EXECUTE ON FUNCTION public.maint_billing_review_visits(bigint, date) TO authenticated;
