-- Due-date is a SEND precondition, not a readiness rule (Carter 2026-07-22):
-- the harm is first-sending an invoice QBO would brand past-due, so the rule
-- moves to _lib/delivery.deliver_invoice (refuses a FIRST send with a past
-- due date; resends exempt). invoice_ready drops the clause. The view's
-- due_date_ok column STAYS as a field indicator (informational) —
-- demonstrating the compat story: the rule list changes in one function,
-- view columns and UI untouched.

create or replace function billing.invoice_ready(p_qbo_invoice_id text)
returns boolean
language sql stable
set search_path to 'billing', 'public'
as $$
  select
    i.pre_processed_at is not null
    and coalesce(i.enrichment_ok, false)
    and not exists (
      select 1 from billing.customer_payments cp
      where cp.qbo_customer_id = i.qbo_customer_id
        and cp.unapplied_amt > 0
        and (cp.txn_date is null or cp.txn_date >= (now() - interval '6 months')::date)
        and (cp.memo is null or cp.memo !~* 'maint')
        and not exists (
          select 1 from billing.invoice_credit_decisions d
          where d.qbo_invoice_id = i.qbo_invoice_id
            and d.credit_id = cp.qbo_payment_id
            and d.state in ('applied','rejected')))
    and abs(coalesce(i.subtotal, 0) - coalesce(w.sub_total, 0)) < 0.01
    and i.memo is not null
    and i.qbo_class is not null
    and (
      billing.resolve_preferred_payment_type(i.qbo_customer_id,
        concat_ws(' ', w.work_description, w.technician_instructions, w.corrective_action))
        = 'email'
      or billing.pick_target_payment_method(i.qbo_customer_id,
           billing.resolve_preferred_payment_type(i.qbo_customer_id,
             concat_ws(' ', w.work_description, w.technician_instructions, w.corrective_action)))
         is not null)
  from billing.invoices i
  join public.work_orders w on w.qbo_invoice_id = i.qbo_invoice_id
  where i.qbo_invoice_id = p_qbo_invoice_id
    and w.billable is true and w.skipped_at is null
$$;
