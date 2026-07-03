-- Mis-assigned invoices (ION task pointed at the wrong customer -> synced
-- into the wrong QBO account) get FIXED by changing the invoice's customer
-- in QBO. The CDC then updates the cache row's qbo_customer_id — which must
-- re-attempt the link, or the correction never propagates to the period.

drop trigger if exists trg_link_invoice_to_maint_period on billing.invoices;
create trigger trg_link_invoice_to_maint_period
  after insert or update of doc_number, qbo_customer_id on billing.invoices
  for each row
  when (NEW.doc_number is not null and NEW.qbo_customer_id is not null)
  execute function billing.fn_link_invoice_to_maint_period();
