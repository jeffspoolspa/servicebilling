-- Financial terms belong on the TASK (one ION contract = one rate), not the per-day schedule slot.
-- The schedule rows are routing only (day_of_week, tech_employee_id, frequency, sequence). This adds
-- the authoritative billing terms to maintenance.tasks and backfills them from the slots, mirroring
-- the billing builder's own aggregation (flat wins; max rate across a task's slots) so the task value
-- matches what billing computes today. Readers (billing / views / UI) migrate off task_schedules in
-- a follow-up, after which the schedule columns are dropped. See docs/operations/task-record-linkage.md.
alter table maintenance.tasks
  add column if not exists billing_method text,
  add column if not exists price_per_visit_cents integer,
  add column if not exists flat_rate_monthly_cents integer;

with terms as (
  select task_id,
         bool_or(billing_method = 'flat_rate_monthly') as any_flat,
         max(price_per_visit_cents)   as ppv,
         max(flat_rate_monthly_cents) as flat,
         count(*) filter (where billing_method is not null) as n_terms
  from maintenance.task_schedules
  group by task_id
)
update maintenance.tasks t
set billing_method = case when te.any_flat then 'flat_rate_monthly' else 'per_visit' end,
    price_per_visit_cents   = te.ppv,
    flat_rate_monthly_cents = te.flat
from terms te
where te.task_id = t.id
  and te.n_terms > 0
  and t.billing_method is null;

comment on column maintenance.tasks.billing_method is
  'Billing terms live on the TASK (one ION contract = one rate); task_schedules are routing only. Source of truth for billing once readers migrate off task_schedules. Maintained by f/ION/_lib/upsert_tasks.';
