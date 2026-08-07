-- MonthServiceEnded (RULED 2026-08-07): the billing period follows the
-- SERVICE — a cancellation ends it early, making the month billable now.
-- The calendar month-end is just the default close.
alter table billing.billing_months add column if not exists service_ended_at timestamptz;
comment on column billing.billing_months.service_ended_at is
  'Service ended early (cancellation) — the period closes here instead of month-end; issuance may proceed, reconcile freshness rules unchanged.';
