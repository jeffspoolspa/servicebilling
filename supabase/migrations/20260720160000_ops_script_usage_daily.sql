-- Recurring Windmill usage audit: daily per-script execution/compute rollup.
-- Written by f/ops/audit_script_usage (schedule f/ops/audit_script_usage_daily, 00:20 UTC).
-- See reference_windmill_execution_incident memory + docs/conventions/WORKFLOW_EXECUTION.md.

create schema if not exists ops;

create table if not exists ops.script_usage_daily (
  day         date        not null,
  script_path text        not null,
  runs        int         not null default 0,
  compute_s   numeric     not null default 0,   -- summed duration_ms / 1000
  failed      int         not null default 0,
  kinds       jsonb       not null default '{}'::jsonb,  -- {schedule:n, webhook:n, wake:n, email:n, manual:n, preview:n}
  captured_at timestamptz not null default now(),
  primary key (day, script_path)
);

comment on table ops.script_usage_daily is
  'Daily per-script Windmill usage rollup. runs=execution count (what Windmill bills), compute_s=summed job duration, kinds=trigger-source breakdown.';

-- Last 30 days, ranked, with a rough monthly projection.
create or replace view ops.v_script_usage_30d as
select script_path,
       sum(runs)                            as runs_30d,
       round(sum(runs)::numeric / 30, 1)    as runs_per_day,
       round(sum(compute_s), 1)             as compute_s_30d,
       sum(failed)                          as failed_30d,
       round(sum(runs)::numeric / 30 * 30)  as runs_per_month_est
  from ops.script_usage_daily
 where day >= (current_date - 30)
 group by script_path
 order by runs_30d desc;
