-- Task category as a first-class column + trigger-maintained frequency (analytics + routing).
--
-- Follow-up to 20260702000000: (1) ONE TIME CLEAN and PLASTER START UP become their own categories
-- (were both 'extra_clean'); (2) category becomes a GENERATED column on maintenance.tasks so every
-- ingestion path (recurring sync, orphan recovery, config refresh) tags tasks automatically -- the
-- routing tool filters tasks.category='recurring' directly; (3) frequency + days_per_week live on
-- the task, maintained by a trigger on task_schedules (writes are rare -- the daily sync; reads are
-- hot -- frequency breakouts), with the ION recurrence text as fallback for schedule-less tasks.
-- Visit counts intentionally NOT counter-cached (visits insert constantly; count in queries/views).

-- 1) category rule v2: split extra_clean
create or replace function maintenance.task_category(service_type text)
returns text
language sql immutable
as $$
  select case
    when nullif(trim(coalesce(service_type,'')),'') is null then 'unknown'
    when service_type ~* '^\s*(QUALITY CONTROL|NO CHARGE)' then 'quality_control'
    when service_type ~* '^\s*GREEN POOL' then 'green_pool'
    when service_type ~* '^\s*ONE TIME CLEAN' then 'one_time_clean'
    when service_type ~* '^\s*PLASTER START UP' then 'plaster_start_up'
    when service_type ~* '^\s*(POOL MAINTENANCE|FLAT RATE|SPA CLEAN|FOUNTAIN CLEAN|CHEMICAL TESTING)' then 'recurring'
    else 'other'
  end
$$;

comment on function maintenance.task_category(text) is
  'Category rule for a task''s ION service description: recurring | quality_control | green_pool | one_time_clean | plaster_start_up | other | unknown. Single source of truth; tasks.category is generated from it.';

-- 2) category as a generated column (auto-computed on every insert/update; no ingester changes)
alter table maintenance.tasks
  add column if not exists category text
  generated always as (maintenance.task_category(external_data->>'service_type')) stored;

create index if not exists tasks_category_status_idx on maintenance.tasks (category, status);

-- 3) frequency columns on the task, trigger-maintained from task_schedules
alter table maintenance.tasks add column if not exists frequency text;
alter table maintenance.tasks add column if not exists days_per_week smallint;

create or replace function maintenance.recalc_task_frequency(p_task_id uuid)
returns void
language sql
as $$
  update maintenance.tasks t
  set (frequency, days_per_week) = (
    select
      case
        when s.any_biweekly then 'biweekly'
        when s.any_weekly and s.days > 1 then 'multi_week'
        when s.any_weekly then 'weekly'
        when s.any_monthly then 'monthly'
        when t.external_data->>'recurrence' ilike 'daily'     then 'multi_week'
        when t.external_data->>'recurrence' ilike 'weekly'    then 'weekly'
        when t.external_data->>'recurrence' ilike 'bi-weekly' then 'biweekly'
        when t.external_data->>'recurrence' ilike 'monthly'   then 'monthly'
        else null
      end,
      coalesce(nullif(s.days, 0), null)
    from (
      select count(distinct day_of_week) as days,
             bool_or(frequency like 'biweekly%') as any_biweekly,
             bool_or(frequency = 'weekly')       as any_weekly,
             bool_or(frequency = 'monthly')      as any_monthly
      from maintenance.task_schedules where task_id = p_task_id
    ) s
  )
  where t.id = p_task_id
$$;

create or replace function maintenance.task_schedules_freq_trigger()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT','UPDATE') and new.task_id is not null then
    perform maintenance.recalc_task_frequency(new.task_id);
  end if;
  if tg_op in ('DELETE','UPDATE') and old.task_id is not null
     and (tg_op = 'DELETE' or old.task_id is distinct from new.task_id) then
    perform maintenance.recalc_task_frequency(old.task_id);
  end if;
  return null;
end
$$;

drop trigger if exists task_schedules_freq on maintenance.task_schedules;
create trigger task_schedules_freq
  after insert or update or delete on maintenance.task_schedules
  for each row execute function maintenance.task_schedules_freq_trigger();

-- 4) backfill frequency for all existing tasks
with sched as (
  select task_id,
         count(distinct day_of_week) as days,
         bool_or(frequency like 'biweekly%') as any_biweekly,
         bool_or(frequency = 'weekly')       as any_weekly,
         bool_or(frequency = 'monthly')      as any_monthly
  from maintenance.task_schedules group by task_id
)
update maintenance.tasks t
set frequency = case
      when s.any_biweekly then 'biweekly'
      when s.any_weekly and s.days > 1 then 'multi_week'
      when s.any_weekly then 'weekly'
      when s.any_monthly then 'monthly'
      when t.external_data->>'recurrence' ilike 'daily'     then 'multi_week'
      when t.external_data->>'recurrence' ilike 'weekly'    then 'weekly'
      when t.external_data->>'recurrence' ilike 'bi-weekly' then 'biweekly'
      when t.external_data->>'recurrence' ilike 'monthly'   then 'monthly'
      else null end,
    days_per_week = nullif(coalesce(s.days,0),0)
from sched s where s.task_id = t.id;

-- fallback-only pass for tasks with no schedule rows at all
update maintenance.tasks t
set frequency = case
      when t.external_data->>'recurrence' ilike 'daily'     then 'multi_week'
      when t.external_data->>'recurrence' ilike 'weekly'    then 'weekly'
      when t.external_data->>'recurrence' ilike 'bi-weekly' then 'biweekly'
      when t.external_data->>'recurrence' ilike 'monthly'   then 'monthly'
      else null end
where t.frequency is null
  and not exists (select 1 from maintenance.task_schedules s where s.task_id = t.id);

-- 5) v_task_class now just exposes the columns (still the analysis surface)
-- (drop+create: days_per_week changes type bigint->int, which CREATE OR REPLACE cannot do)
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
  t.billing_method,
  t.price_per_visit_cents,
  t.flat_rate_monthly_cents,
  t.external_data->>'billing_type' as billing_type
from maintenance.tasks t
join public."Customers" c on c.id = t.customer_id;

comment on view maintenance.v_task_class is
  'Analysis surface over the first-class columns: tasks.category (generated from maintenance.task_category), tasks.frequency/days_per_week (trigger-maintained from task_schedules), commercial flag from the QBO-sourced company cache.';
