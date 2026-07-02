-- Visits-based billing audit source (refactor of the billing-audit skill's QBO-invoice source).
--
-- WHY: the CPV z-score audit previously loaded POSTED QBO invoices (f/billing_audit/load_month ->
-- billing_audit.maintenance_invoices) -- too late to fix misbillings before the QBO sync. Visits +
-- consumables now carry everything upstream (18 months of history, Jan 2025+), so the audit runs
-- pre-QBO: fix in ION -> rebuild -> re-pull -> sync clean. maintenance_invoices stays for
-- cross-checking history but is no longer the audit source.
--
-- v_customer_month_cpv = customer-month rollup from visits:
--   visits    = SUM over recurring tasks of DISTINCT serviceable days (same collapse as billing)
--   chem_usd  = core_chemical + specialty_chemical + spa ONLY (CPV signal is pure chemistry;
--               testing/parts/extra services/discounts exposed separately for drill-down)
--   peer_group (skill's 3-group model, now from real fields): commercial = company filled (QBO rule)
--               or multi_week residential; low_freq = all tasks monthly/biweekly; else weekly_residential
--   season    = winter (11,12,1,2) | shoulder (3,4,9,10) | summer (5,6,7,8)
-- Only recurring tasks: QC / green pool / one-time are excluded from CPV (audited separately).
--
-- customer_month_audit = flagged customer-months (pre-QBO flag store; replaces flagging
-- maintenance_invoices). Re-running an audit month deletes + reinserts its un-reviewed rows.

create or replace view billing_audit.v_customer_month_cpv as
with per_task as (
  select t.customer_id, date_trunc('month', v.scheduled_date)::date as month, v.task_id,
         max(t.frequency) as frequency,
         count(distinct v.scheduled_date) filter (where v.is_serviceable) as bvc
  from maintenance.visits v
  join maintenance.tasks t on t.id = v.task_id
  where t.category = 'recurring' and t.customer_id is not null
  group by 1,2,3
),
vis as (
  select customer_id, month, sum(bvc) as visits,
         bool_or(frequency = 'multi_week') as any_multi,
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
  case when nullif(trim(coalesce(c.company,'')),'') is not null or v.any_multi then 'commercial'
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

comment on view billing_audit.v_customer_month_cpv is
  'Visits-based customer-month CPV for the billing audit (pre-QBO). chem_usd/cpv = core+specialty+spa only; other consumable categories exposed for drill-down. Peer groups per the billing-audit skill 3-group model from tasks.frequency + the Customers.company commercial rule.';

create table if not exists billing_audit.customer_month_audit (
  customer_id   bigint not null,
  month         date   not null,
  visits        numeric,
  chem_usd      numeric,
  cpv           numeric,
  peer_group    text,
  season        text,
  fleet_z       numeric,
  self_z        numeric,
  pct_vs_self   numeric,
  peer_median   numeric,
  self_mean     numeric,
  flag_level    text not null,             -- HIGH | WATCH | SELF_SPIKE | PCT_SPIKE
  audit_status  text not null default 'flagged',  -- flagged | reviewed | resolved
  audit_notes   text,
  computed_at   timestamptz not null default now(),
  primary key (customer_id, month)
);

comment on table billing_audit.customer_month_audit is
  'Flagged customer-months from the visits-based CPV audit (billing-audit skill). Pre-QBO: review + fix in ION before the sync. Re-runs replace un-reviewed rows for the month.';
