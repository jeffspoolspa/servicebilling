-- Customer-provided chemicals flag (maintenance.tasks.customer_provides_chems).
--
-- WHY: pools where the CUSTOMER supplies chems (tabs in the garage, "USE CUSTOMER'S CHEMICALS
-- ONLY/FIRST") run artificially LOW consumable bills and stretch the peer distributions the
-- billing-audit review rules depend on. Mostly residential. Two backfill sources:
--   1. BEHAVIOR: techs log the "Customer Tabs (Not to be billed)" reading with a positive value
--      (>= 2 positive readings since 2026-04-01 to skip one-offs).
--   2. NOTES: curated ion_task_id list from ion.recurring_tasks.recurring_notes matches
--      ("customer's chemicals only/first", "keeps chems stocked", ...) -- hand-filtered; the raw
--      regex also matched CYA advice ("easy on tabs") and equipment notes, which are EXCLUDED.
-- Exposed on maintenance.v_task_class and billing_audit.v_customer_month_cpv (provides_chems =
-- bool_or over the month's recurring tasks) so review thresholds can treat these pools separately.
-- Going forward: set manually when a note/reading appears; no automatic trigger (notes are free
-- text; the reading backfill can be re-run before each audit).

alter table maintenance.tasks add column if not exists customer_provides_chems boolean not null default false;

comment on column maintenance.tasks.customer_provides_chems is
  'Customer supplies (some) chemicals -- tabs/chems kept on site, used before selling ours. Sources: "Customer Tabs (Not to be billed)" readings + ION recurring notes. Low consumable bills are EXPECTED on these tasks; peer-group review rules treat them separately.';

-- 1) behavior-based: repeated positive "Customer Tabs (Not to be billed)" readings
update maintenance.tasks t
set customer_provides_chems = true
where t.id in (
  select v.task_id
  from maintenance.visit_readings vr
  join maintenance.visits v on v.id = vr.visit_id
  where vr.name = 'Customer Tabs (Not to be billed)'
    and vr.value ~ '^[0-9.]+$' and vr.value::numeric > 0
    and v.visit_date >= '2026-04-01'
  group by v.task_id
  having count(*) >= 2);

-- 2) notes-based (curated from ion.recurring_tasks.recurring_notes, 2026-07-02)
update maintenance.tasks
set customer_provides_chems = true
where ion_task_id in (
  '1518858','5337099','5302565','5339798','5341323','5815093','5837200','5874953','5893924',
  '4747673','5158665','2990324','4878493','5342047','5234033','4756398','5698302','5029814',
  '4399255','5447513','2276978','4757919','5083358','5234798','4762167','5889469','5598896',
  '5509819','5739166','4318851','5210514','5527798','5342026','5897940','5763176','4760207',
  '5828946','1745112','5846293','5342058','3462476','5407282');

-- expose on the task classification surface
drop view if exists maintenance.v_task_class;
create view maintenance.v_task_class as
select
  t.id as task_id,
  t.ion_task_id,
  t.customer_id,
  (nullif(trim(coalesce(c.company,'')),'') is not null) as is_commercial,
  t.status,
  t.starts_on,
  t.ends_on,
  t.category,
  upper(trim(split_part(coalesce(t.external_data->>'service_type',''),'-',1))) as service_name,
  t.frequency,
  coalesce(t.days_per_week, 0) as days_per_week,
  t.customer_provides_chems,
  t.billing_method,
  t.price_per_visit_cents,
  t.flat_rate_monthly_cents,
  t.external_data->>'billing_type' as billing_type
from maintenance.tasks t
join public."Customers" c on c.id = t.customer_id;

-- expose on the audit CPV surface (customer-month level)
-- (drop+create: provides_chems inserts mid-column-list, which CREATE OR REPLACE cannot do)
drop view if exists billing_audit.v_customer_month_cpv;
create view billing_audit.v_customer_month_cpv as
with per_task as (
  select t.customer_id, date_trunc('month', v.scheduled_date)::date as month, v.task_id,
         max(t.frequency) as frequency,
         max(coalesce(t.days_per_week, 0)) as days_per_week,
         bool_or(t.customer_provides_chems) as provides_chems,
         count(distinct v.scheduled_date) filter (where v.is_serviceable) as bvc
  from maintenance.visits v
  join maintenance.tasks t on t.id = v.task_id
  where t.category = 'recurring' and t.customer_id is not null
  group by 1,2,3
),
vis as (
  select customer_id, month, sum(bvc) as visits, bool_or(provides_chems) as provides_chems
  from per_task group by 1,2
),
dominant as (
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
  v.provides_chems,
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
