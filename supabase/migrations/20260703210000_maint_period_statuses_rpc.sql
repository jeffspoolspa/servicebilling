-- Tiny poll surface for the processing progress modal (fire-and-forget runs
-- track DB rows, not the HTTP response): current processing_status + invoice
-- balance for an explicit set of periods.

create or replace function public.maint_billing_period_statuses(p_ids uuid[])
returns table (id uuid, processing_status text, qbo_balance numeric)
language sql stable security definer
set search_path = billing_audit, public
as $$
  select tbp.id, tbp.processing_status, i.balance
  from task_billing_periods tbp
  left join billing.invoices i on i.qbo_invoice_id = tbp.qbo_invoice_id
  where tbp.id = any(p_ids);
$$;

revoke all on function public.maint_billing_period_statuses(uuid[]) from public, anon;
grant execute on function public.maint_billing_period_statuses(uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';
