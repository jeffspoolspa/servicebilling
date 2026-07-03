-- Maintenance pipeline stage 4: cache-reflection triggers. Both are thin
-- callers of billing_audit.project_maint_processing_status — the single owner
-- of every status transition.
--
-- 1) Auto-promote on the invoice cache: when a linked invoice reads paid
--    (balance <= 0) AND sent (EmailSent), the period moves to 'processed' —
--    whether we charged it, or someone processed it by hand in QBO (the cache
--    self-updates via webhook/CDC, so manual processing can't be
--    double-processed). DISTINCT-guarded: the CDC reconciler rewrites rows on
--    every 15-min tick; without the guard this would fire hundreds of no-ops.
--
-- 2) Re-projection on reconcile-verdict changes: the hourly reconcile
--    rewrites status/labor_ok/consumables_ok; a verdict flip re-projects the
--    customer-month (e.g. mismatch -> needs_review, or a fixed mismatch back
--    to ready). Recursion-safe: the projection's UPDATE touches none of the
--    OF-listed columns.

create or replace function billing.fn_promote_maint_period_on_invoice_paid()
returns trigger
language plpgsql security definer
set search_path = billing_audit, billing, public
as $$
declare r record;
begin
  for r in
    select distinct tbp.billing_month, tbp.qbo_customer_id
    from billing_audit.task_billing_periods tbp
    where tbp.qbo_invoice_id = NEW.qbo_invoice_id
      and tbp.locked_at is null
      and tbp.processing_status <> 'processed'
  loop
    perform billing_audit.project_maint_processing_status(r.billing_month, r.qbo_customer_id);
  end loop;
  return NEW;
end;
$$;

drop trigger if exists trg_promote_maint_period_on_invoice_paid on billing.invoices;
create trigger trg_promote_maint_period_on_invoice_paid
  after update on billing.invoices
  for each row
  when ((OLD.balance is distinct from NEW.balance
         or OLD.email_status is distinct from NEW.email_status)
        and NEW.balance <= 0 and NEW.email_status = 'EmailSent')
  execute function billing.fn_promote_maint_period_on_invoice_paid();

create or replace function billing_audit.fn_reproject_on_gate_change()
returns trigger
language plpgsql security definer
set search_path = billing_audit, public
as $$
begin
  perform billing_audit.project_maint_processing_status(NEW.billing_month, NEW.qbo_customer_id);
  return NEW;
end;
$$;

drop trigger if exists trg_reproject_on_gate_change on billing_audit.task_billing_periods;
create trigger trg_reproject_on_gate_change
  after update of status, labor_ok, consumables_ok, qbo_invoice_id
  on billing_audit.task_billing_periods
  for each row
  when (OLD.status is distinct from NEW.status
        or OLD.labor_ok is distinct from NEW.labor_ok
        or OLD.consumables_ok is distinct from NEW.consumables_ok
        or OLD.qbo_invoice_id is distinct from NEW.qbo_invoice_id)
  execute function billing_audit.fn_reproject_on_gate_change();
