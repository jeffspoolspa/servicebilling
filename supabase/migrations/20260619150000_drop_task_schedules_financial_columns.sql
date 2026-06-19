-- Financial terms now live authoritatively on maintenance.tasks; all readers (the 3 maintenance
-- views, the billing builder f/billing_audit/build_task_billing_periods, and the legacy ION matchers
-- f/ION/_lib/upsert.py + relink_visits.py) read from the task. task_schedules is now routing-only
-- (day_of_week, tech_employee_id, frequency, sequence, active, starts_on/ends_on, ion_task_id).
-- Drop the vestigial slot terms. (Companion writer change: f/ION/_lib/upsert_tasks no longer writes them.)
alter table maintenance.task_schedules
  drop column if exists billing_method,
  drop column if exists price_per_visit_cents,
  drop column if exists flat_rate_monthly_cents;
