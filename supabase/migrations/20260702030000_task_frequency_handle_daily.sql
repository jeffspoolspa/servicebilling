-- Frequency rollup gap: task_schedules.frequency can be 'daily' (ION ServiceRepeat "Daily", mapped by
-- the ingesters) but recalc_task_frequency only tested weekly/biweekly/monthly -- daily tasks fell
-- through to the recurrence-text fallback (or null without it; how ROWAN/CARTER surfaced 2026-07-02).
-- Daily service = multi_week (its days_per_week carries the actual day count).

create or replace function maintenance.recalc_task_frequency(p_task_id uuid)
returns void
language sql
as $$
  update maintenance.tasks t
  set (frequency, days_per_week) = (
    select
      case
        when s.any_biweekly then 'biweekly'
        when s.any_daily then 'multi_week'
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
             bool_or(frequency = 'daily')        as any_daily,
             bool_or(frequency = 'weekly')       as any_weekly,
             bool_or(frequency = 'monthly')      as any_monthly
      from maintenance.task_schedules where task_id = p_task_id
    ) s
  )
  where t.id = p_task_id
$$;
