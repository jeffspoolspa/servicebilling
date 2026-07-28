-- Carter's rule, specified earlier and never implemented: if a credit covers
-- the invoice, the customer's OTHER open credits stop being this invoice's
-- problem. They plainly belong somewhere else.
--
-- Without this, rule 2 demands a terminal decision on every open credit of
-- the customer, so a paid-in-full invoice sits in needs_review waiting for a
-- human to reject a credit that was always meant for a different job.
--
-- Luke Latimer is the worked example: two credits ($150 ref 5094004, $850 ref
-- 5096528) against two invoices. The $150 clears invoice 7963304 completely,
-- and the $850 is visibly earmarked for the other work order.
--
-- Depends on the cached balance being true after enrichment applies credits —
-- pre_process_invoice re-reads the invoice (read = echo) whenever it moved
-- money, because apply_credits fresh-reads BEFORE applying and would
-- otherwise leave billing.invoices.balance stale-high.

create or replace function billing.invoice_ready(p_qbo_invoice_id text)
returns boolean
language sql stable
set search_path to 'billing', 'public'
as $$
  select
    -- 1. completed, non-failed pre-process effects
    i.pre_processed_at is not null
    and coalesce(i.enrichment_ok, false)
    -- 2. credits settled: nothing left to cover, OR every live open credit
    --    has a terminal decision on this invoice
    and (
      coalesce(i.balance, 0) < 0.01
      or not exists (
        select 1 from billing.customer_payments cp
        where cp.qbo_customer_id = i.qbo_customer_id
          and cp.unapplied_amt > 0
          and (cp.txn_date is null or cp.txn_date >= (now() - interval '6 months')::date)
          and (cp.memo is null or cp.memo !~* 'maint')
          and not exists (
            select 1 from billing.invoice_credit_decisions d
            where d.qbo_invoice_id = i.qbo_invoice_id
              and d.credit_id = cp.qbo_payment_id
              and d.state in ('applied','rejected'))))
    -- 3. subtotal drift check between the two external systems
    and abs(coalesce(i.subtotal, 0) - coalesce(w.sub_total, 0)) < 0.01
    -- 4. enrichment fields present and the invoice is current
    and i.memo is not null
    and i.qbo_class is not null
    and i.preferred_payment_type in ('email','ach','credit_card')
    -- 5. payment route determined
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
