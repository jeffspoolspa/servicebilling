-- Carter 2026-07-24: pre-processing's output IS the payment method id on the
-- invoice row. So the readiness gate reads that row — it does not re-derive
-- the route from the customer behind pre-processing's back.
--
-- This closes D-4 (the same decision both pinned and live-re-derived). The
-- pinned columns stay fresh via trg_pm_auto_resolve_on_cpm_change, which
-- re-picks them whenever a payment method changes and respects a per-invoice
-- override.
--
-- Verified before applying: across every billable, non-processed invoice, the
-- stored form and the derived form agree on all enriched rows. The 109 rows
-- where they differ are all billing_status='processed' — the PM trigger
-- deliberately stops maintaining those, and the gate never judges them.

create or replace function billing.invoice_ready(p_qbo_invoice_id text)
returns boolean
language sql stable
set search_path to 'billing', 'public'
as $function$
  select
    -- 1. completed, non-failed pre-process effects
    i.pre_processed_at is not null
    and coalesce(i.enrichment_ok, false)
    -- 2. credits settled: every live open credit has a terminal decision
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
    -- 3. subtotal drift check between the two external systems
    and abs(coalesce(i.subtotal, 0) - coalesce(w.sub_total, 0)) < 0.01
    -- 4. enrichment fields present
    and i.memo is not null
    and i.qbo_class is not null
    -- 5. the route landed on the row: a known channel, and a method to
    --    charge whenever the channel isn't email
    and i.preferred_payment_type in ('email','ach','credit_card')
    and (i.preferred_payment_type = 'email'
         or i.target_payment_method_id is not null)
  from billing.invoices i
  join public.work_orders w on w.qbo_invoice_id = i.qbo_invoice_id
  where i.qbo_invoice_id = p_qbo_invoice_id
    and w.billable is true and w.skipped_at is null
$function$;
