-- Add per-chem unit price + category to the Bills visit-calendar RPC so the UI
-- can show the unit price (in parens) and a core/specialty/part tag per
-- consumable line. Additive to the chems jsonb only — return signature is
-- unchanged, so this CREATE OR REPLACE is backward-compatible.

create or replace function public.maint_billing_customer_visits(
  p_customer_id bigint,
  p_month date
)
returns table (
  visit_date       date,
  service_names    text,
  readings         jsonb,   -- {reading name: avg numeric value}
  chems            jsonb,   -- [{item, qty, cents, unit_cents, category}] by cents desc
  chem_total_cents bigint
)
language sql stable security definer
set search_path = billing_audit, public
as $$
  with v as (
    select v.id, v.visit_date::date as d, vc.service_name
    from maintenance.visits v
    join maintenance.tasks t on t.id = v.task_id
    left join maintenance.v_task_class vc on vc.task_id = t.id
    where t.customer_id = p_customer_id
      and date_trunc('month', v.visit_date)::date = p_month
  ),
  days as (
    select d, string_agg(distinct service_name, ' + ') as service_names
    from v group by d
  ),
  r as (
    -- readings are text in visit_readings; average numeric values per day
    -- (multi-pool days collapse), skip non-numeric entries
    select v.d, vr.name, avg(x.val) as val
    from maintenance.visit_readings vr
    join v on v.id = vr.visit_id
    cross join lateral (
      select case when vr.value ~ '^[0-9]+\.?[0-9]*$' then vr.value::numeric end as val
    ) x
    where vr.name in ('Free Chlorine', 'pH', 'Cyanuric Acid',
                      'Total Alkalinity', 'Total Chlorine', 'Salinity')
      and x.val is not null
    group by v.d, vr.name
  ),
  rj as (
    select d, jsonb_object_agg(name, round(val, 2)) as readings from r group by d
  ),
  c as (
    select v.d, cu.item_name, sum(cu.quantity) as qty,
           (round(sum(cu.quantity) * max(cc.unit_price_cents)))::bigint as cents,
           max(cc.unit_price_cents) as unit_cents,
           max(cc.category)         as category
    from maintenance.consumables_usage cu
    join v on v.id = cu.visit_id
    left join maintenance.consumables cc on cc.ion_item_id = cu.ion_item_id
    where cu.item_name is not null
    group by v.d, cu.item_name
  ),
  cj as (
    select d,
           jsonb_agg(jsonb_build_object('item', item_name, 'qty', qty, 'cents', cents,
                                        'unit_cents', unit_cents, 'category', category)
                     order by cents desc nulls last) as chems,
           coalesce(sum(cents), 0)::bigint as chem_total_cents
    from c group by d
  )
  select days.d, days.service_names, rj.readings, cj.chems,
         coalesce(cj.chem_total_cents, 0)
  from days
  left join rj on rj.d = days.d
  left join cj on cj.d = days.d
  order by days.d;
$$;
