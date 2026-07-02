-- Peer groups v3: high-frequency residential is its OWN peer group, not folded into commercial.
--   commercial          = Customers.company filled (the QBO rule) -- nothing else
--   high_freq_residential = no company, any recurring task with days_per_week > 2
--   low_freq            = all tasks monthly/biweekly
--   weekly_residential  = rest (includes 2x-weekly)
-- Note: high_freq_residential is a small group; fleet z-scores require peer N >= 5 per calendar
-- month, so its members may score on self z only. Also fixed upstream 2026-07-02: the schedule sync
-- left stale day rows when ION dropped days (ALTMAN Mon/Thu, WINDING RIVER, ZEH) -- rosters
-- reconciled against ION's live day1-7; syncs should prune days not in the live roster.

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
  select customer_id, month, sum(bvc) as visits,
         bool_or(days_per_week > 2) as high_freq,
         bool_and(frequency in ('monthly','biweekly')) as all_lowfreq
  from per_task group by 1,2
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
       when v.high_freq then 'high_freq_residential'
       when v.all_lowfreq then 'low_freq'
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
join public."Customers" c on c.id = v.customer_id
left join chem ch on ch.customer_id = v.customer_id and ch.month = v.month
where v.visits > 0;
