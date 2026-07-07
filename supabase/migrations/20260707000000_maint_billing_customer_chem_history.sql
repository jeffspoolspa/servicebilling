-- Customer's monthly recorded-chem totals (for the review workbench's
-- "why flagged" context panel: self median + mini bar chart; the row count
-- doubles as the data-support indicator).
create or replace function public.maint_billing_customer_chem_history(
  p_customer_id bigint,
  p_through date  -- include months up to and including this month
)
returns table (month date, chem_usd numeric, visits int)
language sql stable security definer
set search_path = maintenance, public
as $$
  with m as (
    select date_trunc('month', v.visit_date)::date as month, v.id
    from maintenance.visits v
    join maintenance.tasks t on t.id = v.task_id
    where t.customer_id = p_customer_id
      and v.visit_date < (p_through + interval '1 month')
  ),
  chem as (
    select m.month,
           sum(round(cu.quantity * coalesce(cc.unit_price_cents, 0))) as cents
    from m
    join maintenance.consumables_usage cu on cu.visit_id = m.id
    left join maintenance.consumables cc on cc.ion_item_id = cu.ion_item_id
    group by 1
  )
  select m.month,
         round(coalesce(chem.cents, 0) / 100.0, 2) as chem_usd,
         count(distinct m.id)::int as visits
  from m
  left join chem on chem.month = m.month
  group by m.month, chem.cents
  order by m.month;
$$;

revoke all on function public.maint_billing_customer_chem_history(bigint, date) from public, anon;
grant execute on function public.maint_billing_customer_chem_history(bigint, date) to authenticated, service_role;
