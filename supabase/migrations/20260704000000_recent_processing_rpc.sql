-- Poll surface for the DB-driven processing chip: the latest maintenance
-- attempt per invoice from the active window (anything unresolved from the
-- last 2 hours, plus everything from the last 10 minutes so finishes linger
-- briefly), joined to the period + cached invoice for resolution state.

create or replace function public.maint_billing_recent_processing()
returns table (
  period_id         uuid,
  customer_name     text,
  doc_number        text,
  attempt_status    text,
  charge_amount     numeric,
  qbo_payment_id    text,
  error_message     text,
  attempted_at      timestamptz,
  processing_status text,
  qbo_balance       numeric
)
language sql stable security definer
set search_path = billing, public
as $$
  select distinct on (a.qbo_invoice_id)
         tbp.id, c.display_name, a.invoice_number,
         a.status, a.charge_amount, a.qbo_payment_id,
         a.error_message, a.attempted_at,
         tbp.processing_status, i.balance
  from billing.processing_attempts a
  join billing_audit.task_billing_periods tbp on tbp.qbo_invoice_id = a.qbo_invoice_id
  left join public."Customers" c on c.qbo_customer_id = tbp.qbo_customer_id
  left join billing.invoices i on i.qbo_invoice_id = a.qbo_invoice_id
  where a.stage = 'maint'
    and coalesce(a.dry_run, false) = false
    and a.attempted_at > now() - interval '2 hours'
    and (a.attempted_at > now() - interval '10 minutes'
         or a.status in ('pending', 'charge_succeeded', 'charge_uncertain'))
  order by a.qbo_invoice_id, a.attempted_at desc;
$$;

revoke all on function public.maint_billing_recent_processing() from public, anon;
grant execute on function public.maint_billing_recent_processing() to authenticated, service_role;

notify pgrst, 'reload schema';
