-- The subtotal gate compared ION's (pre-tax) amount to QBO total_amt — which
-- includes SALES TAX and reflects QBO-side DISCOUNTS. Verified on June: every
-- "mismatch" was tax (HAYES +11.13, WILLIAMS +7.74, Forest Lakes +84.21) or a
-- deliberate invoice discount (SMITH -40.00, TAZI -1,438) while ION ==
-- billing.invoices.subtotal exactly. Compare against SUBTOTAL: subtotal = what
-- was sold (must match ION); total = subtotal - discounts + tax (legitimate
-- QBO-side adjustments that must NOT hold the invoice — the discount workflow
-- depends on it).

create or replace function billing_audit.project_maint_processing_status(
  p_month date,
  p_qbo_customer_id text default null
) returns int
language sql security definer
set search_path = billing_audit, public
as $$
  with target as (
    select tbp.id,
           tbp.processing_status, tbp.needs_review_reason,
           tbp.ion_matched_at, tbp.ion_amt_cents, tbp.expected_total_cents,
           tbp.qbo_invoice_id, tbp.pre_processed_at, tbp.reviewed_at,
           tbp.status as reconcile_status, tbp.qbo_customer_id,
           c.id as cust_id,
           i.balance, i.email_status, i.subtotal
    from task_billing_periods tbp
    left join public."Customers" c on c.qbo_customer_id = tbp.qbo_customer_id
    left join billing.invoices i on i.qbo_invoice_id = tbp.qbo_invoice_id
    where tbp.billing_month = p_month
      and tbp.locked_at is null
      and tbp.processing_status <> 'processed'
      and (p_qbo_customer_id is null or tbp.qbo_customer_id = p_qbo_customer_id)
  ),
  gates as (
    select t.*,
      exists (select 1 from billing.autopay_transactions x
              where x.qbo_customer_id = t.qbo_customer_id
                and x.billing_month = to_char(p_month, 'YYYY-MM')
                and coalesce(x.dry_run, false) = false
                and x.status in ('charge_success','payment_created','completed','verified'))
        as autopay_charged,
      (t.pre_processed_at is not null
        and exists (select 1 from v_billing_review_flags rf
                    where rf.customer_id = t.cust_id and rf.month = p_month)
        and not exists (select 1 from customer_month_audit a
                        where a.customer_id = t.cust_id and a.month = p_month
                          and a.audit_status in ('reviewed', 'resolved')))
        as chem_flag,
      (t.pre_processed_at is not null and t.ion_matched_at is not null
        and abs(coalesce(t.ion_amt_cents, 0) - coalesce(t.expected_total_cents, 0)) > 100)
        as ion_mismatch,
      -- ION (pre-tax) vs QBO SUBTOTAL: sync fidelity on what was sold
      (t.pre_processed_at is not null
        and t.qbo_invoice_id is not null and t.subtotal is not null
        and abs(coalesce(t.ion_amt_cents, 0) - round(t.subtotal * 100)) > 100)
        as subtotal_mismatch,
      (t.pre_processed_at is not null and t.reconcile_status = 'mismatch')
        as reconcile_mismatch,
      (t.needs_review_reason = 'credit_error' and t.processing_status = 'needs_review')
        as credit_error
    from target t
  ),
  verdict as (
    select g.id,
      case
        when g.qbo_invoice_id is not null
             and ((g.balance is not null and g.balance <= 0
                   and g.email_status = 'EmailSent')
                  or g.autopay_charged)
          then 'processed'
        when g.ion_matched_at is null then 'pending'
        when g.chem_flag
             or (g.reviewed_at is null
                 and (g.ion_mismatch or g.subtotal_mismatch
                      or g.reconcile_mismatch or g.credit_error))
          then 'needs_review'
        when g.qbo_invoice_id is not null and g.pre_processed_at is not null
          then 'ready_to_process'
        else 'ion_matched'
      end as st,
      case
        when g.chem_flag then 'chem_flag'
        when g.reviewed_at is null and g.credit_error then 'credit_error'
        when g.reviewed_at is null and g.ion_mismatch then 'ion_amount_mismatch'
        when g.reviewed_at is null and g.subtotal_mismatch then 'subtotal_mismatch'
        when g.reviewed_at is null and g.reconcile_mismatch then 'reconcile_mismatch'
      end as reason
    from gates g
  ),
  applied as (
    update task_billing_periods tbp
    set processing_status = v.st,
        needs_review_reason = case when v.st = 'needs_review' then v.reason end,
        processed_at = case when v.st = 'processed'
                            then coalesce(tbp.processed_at, now()) end,
        updated_at = now()
    from verdict v
    where tbp.id = v.id
      and (tbp.processing_status is distinct from v.st
           or tbp.needs_review_reason is distinct from
              case when v.st = 'needs_review' then v.reason end)
    returning 1
  )
  select count(*)::int from applied;
$$;

select billing_audit.project_maint_processing_status('2026-06-01');
select billing_audit.project_maint_processing_status('2026-07-01');
