-- The months dashboard's revenue chart: value delivered per service day,
-- split labor / consumables — a published read surface over the ledger.
create or replace view billing.v_month_revenue_by_day as
select
  bm.month::date as month,
  bi.service_date::date as service_date,
  coalesce(sum(bi.amount_cents) filter (where bi.kind = 'labor'), 0)::bigint as labor_cents,
  coalesce(sum(bi.amount_cents) filter (where bi.kind = 'consumable'), 0)::bigint as chem_cents
from billing.billable_items bi
join billing.billing_months bm on bm.id = bi.billing_month_id
group by 1, 2;

grant usage on schema billing to authenticated;
grant select on billing.v_month_revenue_by_day to authenticated, service_role;
