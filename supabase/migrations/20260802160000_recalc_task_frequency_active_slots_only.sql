-- recalc_task_frequency counted day_of_week across ALL schedule slots,
-- including INACTIVE ones. A task that moves day (reroute, ION schedule
-- change) keeps its retired slot's weekday in the count, so days_per_week
-- inflates and frequency flips to 'multi_week' while only one slot is live.
--
-- Measured 2026-08-02: 74 active tasks carried an inflated cadence; 74/74 were
-- explained exactly by counting inactive slots, and all 74 had self-consistent
-- ACTIVE slots. Observed reality over 8 weeks of visits: 1.00 service days per
-- week for essentially all of them. The slots were right; the derived cadence
-- was wrong — which matters because routing/quota and the billing peer groups
-- read days_per_week to size demand.
CREATE OR REPLACE FUNCTION maintenance.recalc_task_frequency(p_task_id uuid)
 RETURNS void
 LANGUAGE sql
AS $function$
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
      from maintenance.task_schedules
      where task_id = p_task_id
        and active            -- THE FIX: retired slots do not define the cadence
    ) s
  )
  where t.id = p_task_id
$function$;

COMMENT ON FUNCTION maintenance.recalc_task_frequency(uuid) IS
  'Derives tasks.frequency/days_per_week from ACTIVE schedule slots only. Inactive slots are history, not cadence (fixed 2026-08-02 after 74 tasks carried inflated cadences).';

-- Backfill every task through the corrected derivation.
SELECT maintenance.recalc_task_frequency(id) FROM maintenance.tasks;
