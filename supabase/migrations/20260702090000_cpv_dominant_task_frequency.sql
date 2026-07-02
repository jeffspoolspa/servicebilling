-- Peer group v4: classify a customer-month by its DOMINANT task (most billable visits that month),
-- not bool_or across every task that happened to have a visit. Found via CARTER, JEFF: his active
-- task is SPA CLEAN weekly (Thu), but a CLOSED one-off spa task (5940937, ended 06-02, ION repeat
-- "Daily"/7-day roster, ONE June visit) dragged him into high_freq_residential. A task's config
-- only speaks for the customer when it is the month's primary service.

create or replace view billing_audit.v_customer_month_cpv as
with per_task as (
  select t.customer_id, date_trunc('month', v.scheduled_date)::date as month, v.task_id,
         max(t.frequency) as frequency,
         max(coalesce(t.days_per_week, 0)) as days_per_week,
         count(distinct v.scheduled_date) filter (where v.is_serviceable) as bvc
  from maintenance.visits v
  join maintenance.tasks t on t.id = v.task_id
  where t.category = 'recurring' and t.customer_id is not null
  group by 1,2,3
),
vis as (
  select customer_id, month, sum(bvc) as visits
  from per_task group by 1,2
),
dominant as (  -- the task that defines the customer's service frequency that month
  select distinct on (customer_id, month) customer_id, month, frequency, days_per_week
  from per_task
  order by customer_id, month, bvc desc, days_per_week desc
),
chem as (
  select t.customer_id, date_trunc('month', v.visit_date)::date as month,
         sum(cu.quantity * cc.unit_price_cents) filter (where cc.category in ('core_chemical','specialty_chemical','spa')) / 100.0 as chem_usd,
         sum(cu.quantity * cc.unit_price_cents) filter (where cc.category = 'core_chemical')      / 100.0 as core_usd,
         sum(cu.quantity * cc.unit_price_cents) filter (where cc.category = 'specialty_chemical') / 100.0 as specialty_usd,
         sum(cu.quantity * cc.unit_price_cents) filter (where cc.category = 'spa')                / 100.0 as spa_usd,
         sum(cu.quantity * cc.unit_price_cents) filter (where cc.category = 'testing')            / 100.0 as testing_usd,
         sum(cu.quantity * cc.unit_price_cents) filter (where cc.category = 'replacement_part')   / 100.0 as parts_usd,
         sum(cu.quantity * cc.unit_price_cents) filter (where cc.category = 'extra_service')      / 100.0 as extra_service_usd,
         sum(cu.quantity * cc.unit_price_cents) filter (where cc.category = 'discount')           / 100.0 as discount_usd
  from maintenance.visits v
  join maintenance.consumables_usage cu on cu.visit_id = v.id
  join maintenance.consumables cc on cc.ion_item_id = cu.ion_item_id
  join maintenance.tasks t on t.id = v.task_id
  where t.category = 'recurring' and t.customer_id is not null
  group by 1,2
)
select
  v.customer_id,
  c.display_name,
  v.month,
  extract(month from v.month)::int as cal_month,
  case when extract(month from v.month) in (11,12,1,2) then 'winter'
       when extract(month from v.month) in (3,4,9,10)  then 'shoulder'
       else 'summer' end as season,
  case when nullif(trim(coalesce(c.company,'')),'') is not null then 'commercial'
       when d.days_per_week > 2 then 'high_freq_residential'
       when d.frequency in ('monthly','biweekly') then 'low_freq'
       else 'weekly_residential' end as peer_group,
  v.visits,
  coalesce(ch.chem_usd, 0)      as chem_usd,
  case when v.visits > 0 then round((coalesce(ch.chem_usd,0) / v.visits)::numeric, 2) end as cpv,
  coalesce(ch.core_usd, 0)          as core_usd,
  coalesce(ch.specialty_usd, 0)     as specialty_usd,
  coalesce(ch.spa_usd, 0)           as spa_usd,
  coalesce(ch.testing_usd, 0)       as testing_usd,
  coalesce(ch.parts_usd, 0)         as parts_usd,
  coalesce(ch.extra_service_usd, 0) as extra_service_usd,
  coalesce(ch.discount_usd, 0)      as discount_usd
from vis v
join dominant d on d.customer_id = v.customer_id and d.month = v.month
join public."Customers" c on c.id = v.customer_id
left join chem ch on ch.customer_id = v.customer_id and ch.month = v.month
where v.visits > 0;
