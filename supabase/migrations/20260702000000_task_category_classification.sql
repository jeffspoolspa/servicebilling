-- Task category classification (maintenance analytics).
--
-- WHY: churn/frequency analysis needs every task tagged: recurring service contracts (by
-- frequency), quality control (non-billable labor; consumables analyzed separately), green pool
-- (remediation; spend tracked), billable extra cleans, and admin junk. The ION task DESCRIPTION
-- (external_data->>'service_type') is the authoritative categorical -- serviceProfile is 58% empty
-- and describes pool chemistry, not service kind (verified 2026-07-02).
--
-- RULE = maintenance.task_category(text): one place, used by the view and any future ingester.
-- Sanity-checked against visits/task: recurring avg 19-146 visits, QC 1.3-4.3, green pool 6,
-- one-time 1.1.
--
-- maintenance.v_task_class = the analysis surface: category + frequency (from task_schedules,
-- falling back to the ION recurrence text) + commercial flag (Customers.company filled = commercial;
-- company is a QBO-sourced cache, cleaned 2026-07-01).

create or replace function maintenance.task_category(service_type text)
returns text
language sql immutable
as $$
  select case
    when nullif(trim(coalesce(service_type,'')),'') is null then 'unknown'
    when service_type ~* '^\s*(QUALITY CONTROL|NO CHARGE)' then 'quality_control'
    when service_type ~* '^\s*GREEN POOL' then 'green_pool'
    when service_type ~* '^\s*(ONE TIME CLEAN|PLASTER START UP)' then 'extra_clean'
    when service_type ~* '^\s*(POOL MAINTENANCE|FLAT RATE|SPA CLEAN|FOUNTAIN CLEAN|CHEMICAL TESTING)' then 'recurring'
    else 'other'
  end
$$;

comment on function maintenance.task_category(text) is
  'Category rule for a task''s ION service description: recurring | quality_control | green_pool | extra_clean | other | unknown. Single source of truth -- change the rule here only.';

create or replace view maintenance.v_task_class as
with sched as (
  select task_id,
         count(distinct day_of_week) as days_per_week,
         bool_or(frequency like 'biweekly%') as any_biweekly,
         bool_or(frequency = 'weekly')       as any_weekly,
         bool_or(frequency = 'monthly')      as any_monthly
  from maintenance.task_schedules
  group by task_id
)
select
  t.id as task_id,
  t.ion_task_id,
  t.customer_id,
  (nullif(trim(coalesce(c.company,'')),'') is not null) as is_commercial,
  t.status,
  t.starts_on,
  t.ends_on,
  maintenance.task_category(t.external_data->>'service_type') as category,
  upper(trim(split_part(coalesce(t.external_data->>'service_type',''),'-',1))) as service_name,
  case
    when s.any_biweekly then 'biweekly'
    when s.any_weekly and s.days_per_week > 1 then 'multi_week'
    when s.any_weekly then 'weekly'
    when s.any_monthly then 'monthly'
    when t.external_data->>'recurrence' ilike 'daily'     then 'multi_week'
    when t.external_data->>'recurrence' ilike 'weekly'    then 'weekly'
    when t.external_data->>'recurrence' ilike 'bi-weekly' then 'biweekly'
    when t.external_data->>'recurrence' ilike 'monthly'   then 'monthly'
    else null
  end as frequency,
  coalesce(s.days_per_week, 0) as days_per_week,
  t.billing_method,
  t.price_per_visit_cents,
  t.flat_rate_monthly_cents,
  t.external_data->>'billing_type' as billing_type
from maintenance.tasks t
join public."Customers" c on c.id = t.customer_id
left join sched s on s.task_id = t.id;

comment on view maintenance.v_task_class is
  'Every task classified for analytics: category (maintenance.task_category on the ION description), frequency (task_schedules rollup, ION recurrence fallback), commercial flag. Churn = compare active recurring tasks month over month.';
