-- Maintenance pipeline stage 2: link QBO invoices to billing periods as they
-- hit the cache (mirrors the work-order pattern: billing.invoices is fed by
-- webhook + CDC poll; a new row searches for its owner by invoice number).
--
-- The ION transaction number becomes the QBO DocNumber at sync, so
-- NEW.doc_number = tbp.ion_invoice_number identifies the period. The customer
-- must ALSO match: WO invoices and task invoices share ION's invoice-number
-- space, so a bare number match could mislink — the customer guard makes a
-- mislink impossible. Setting the FK enqueues the customer-month for
-- preprocessing (drained serially by f/billing/drain_maint_preprocess_queue).

create or replace function billing.fn_link_invoice_to_maint_period()
returns trigger
language plpgsql security definer
set search_path = billing_audit, billing, public
as $$
begin
  with linked as (
    update billing_audit.task_billing_periods tbp
       set qbo_invoice_id = NEW.qbo_invoice_id,
           updated_at     = now()
     where tbp.ion_invoice_number = NEW.doc_number
       and tbp.qbo_customer_id    = NEW.qbo_customer_id
       and tbp.qbo_invoice_id is null
       and tbp.locked_at is null
    returning tbp.qbo_customer_id, tbp.billing_month
  )
  insert into billing_audit.maint_preprocess_queue (qbo_customer_id, billing_month)
  select distinct l.qbo_customer_id, l.billing_month from linked l
  on conflict (qbo_customer_id, billing_month) where finished_at is null
  do nothing;
  return NEW;
end;
$$;

drop trigger if exists trg_link_invoice_to_maint_period on billing.invoices;
create trigger trg_link_invoice_to_maint_period
  after insert or update of doc_number on billing.invoices
  for each row
  when (NEW.doc_number is not null and NEW.qbo_customer_id is not null)
  execute function billing.fn_link_invoice_to_maint_period();

-- One-time catch-up: link + enqueue anything already cached (the trigger only
-- sees future inserts). Same predicate as the trigger.
with linked as (
  update billing_audit.task_billing_periods tbp
     set qbo_invoice_id = i.qbo_invoice_id,
         updated_at     = now()
    from billing.invoices i
   where i.doc_number        = tbp.ion_invoice_number
     and i.qbo_customer_id   = tbp.qbo_customer_id
     and tbp.qbo_invoice_id is null
     and tbp.locked_at is null
  returning tbp.qbo_customer_id, tbp.billing_month
)
insert into billing_audit.maint_preprocess_queue (qbo_customer_id, billing_month)
select distinct l.qbo_customer_id, l.billing_month from linked l
on conflict (qbo_customer_id, billing_month) where finished_at is null
do nothing;
