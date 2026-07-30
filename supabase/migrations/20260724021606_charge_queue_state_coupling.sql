-- Two engine-policy leaks moved to their architectural tier (Carter 2026-07-23):
-- 1. STATE CHANGE => DEQUEUE: leaving ready_to_process deletes the WAITING
--    charge-queue row (in-flight rows finish; claim gate still guards).
-- 2. THE ROUTE IS A GATE: invoice_ready also requires the STORED route
--    columns to be usable (what the engine's _route() reads).
-- Applied 2026-07-24 via MCP apply_migration (recorded 20260724021606).
-- Full definitions: see the applied migration of the same name.

create or replace function billing.dequeue_service_charge()
returns trigger language plpgsql security definer set search_path to 'billing'
as $$
begin
  delete from billing.service_charge_queue
   where qbo_invoice_id = new.qbo_invoice_id
     and finished_at is null and started_at is null;
  return new;
end $$;

drop trigger if exists trg_dequeue_service_charge on billing.invoices;
create trigger trg_dequeue_service_charge
  after update of billing_status on billing.invoices
  for each row
  when (old.billing_status = 'ready_to_process'
        and new.billing_status is distinct from 'ready_to_process')
  execute function billing.dequeue_service_charge();

create or replace function billing.invoice_ready(p_qbo_invoice_id text)
 returns boolean
 language sql
 stable
 set search_path to 'billing', 'public'
as $function$
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
    and (i.preferred_payment_type in ('email','ach','credit_card')
         or i.payment_method in ('invoice','on_file'))
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
$function$;
