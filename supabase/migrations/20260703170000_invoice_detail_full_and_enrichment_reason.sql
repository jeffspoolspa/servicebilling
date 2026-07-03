-- 1) Invoice detail RPC: full header (memo, statement memo, due date, class,
--    customer) for the period detail page. Return shape changes -> DROP+CREATE.
-- 2) needs_review_reason gains 'enrichment_error' (preprocess now enriches the
--    QBO invoice: memo "[Month] Pool Maintenance", class maintenance, due date
--    the 15th of the month after the invoice date). Projection treats it as
--    sticky like credit_error: only a clean preprocess re-run clears it.

drop function if exists public.maint_billing_invoice_detail(text);

create function public.maint_billing_invoice_detail(p_qbo_invoice_id text)
returns table (
  qbo_invoice_id text,
  doc_number     text,
  customer_name  text,
  txn_date       date,
  due_date       date,
  memo           text,
  statement_memo text,
  qbo_class      text,
  subtotal       numeric,
  total_amt      numeric,
  balance        numeric,
  email_status   text,
  line_items     jsonb
)
language sql stable security definer
set search_path = billing, public
as $$
  select i.qbo_invoice_id, i.doc_number, i.customer_name,
         i.txn_date::date, i.due_date::date,
         i.memo, i.statement_memo, i.qbo_class,
         i.subtotal, i.total_amt, i.balance, i.email_status, i.line_items
  from billing.invoices i
  where i.qbo_invoice_id = p_qbo_invoice_id;
$$;

revoke all on function public.maint_billing_invoice_detail(text) from public, anon;
grant execute on function public.maint_billing_invoice_detail(text) to authenticated, service_role;

alter table billing_audit.task_billing_periods
  drop constraint if exists task_billing_periods_needs_review_reason_check;
alter table billing_audit.task_billing_periods
  add constraint task_billing_periods_needs_review_reason_check
  check (needs_review_reason is null or needs_review_reason in
    ('ion_amount_mismatch', 'subtotal_mismatch', 'chem_flag',
     'reconcile_mismatch', 'credit_error', 'enrichment_error'));

-- projection: generalize the sticky-operational gate to both error reasons
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
  flags as (
    select f.customer_id from v_chem_flags f where f.month = p_month
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
        and exists (select 1 from flags f where f.customer_id = t.cust_id)
        and not exists (select 1 from customer_month_audit a
                        where a.customer_id = t.cust_id and a.month = p_month
                          and a.audit_status in ('reviewed', 'resolved')))
        as chem_flag,
      (t.pre_processed_at is not null and t.ion_matched_at is not null
        and abs(coalesce(t.ion_amt_cents, 0) - coalesce(t.expected_total_cents, 0)) > 100)
        as ion_mismatch,
      (t.pre_processed_at is not null
        and t.qbo_invoice_id is not null and t.subtotal is not null
        and abs(coalesce(t.ion_amt_cents, 0) - round(t.subtotal * 100)) > 100)
        as subtotal_mismatch,
      (t.pre_processed_at is not null and t.reconcile_status = 'mismatch')
        as reconcile_mismatch,
      (t.needs_review_reason in ('credit_error', 'enrichment_error')
        and t.processing_status = 'needs_review')
        as op_error
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
                      or g.reconcile_mismatch or g.op_error))
          then 'needs_review'
        when g.qbo_invoice_id is not null and g.pre_processed_at is not null
          then 'ready_to_process'
        else 'ion_matched'
      end as st,
      case
        when g.chem_flag then 'chem_flag'
        when g.reviewed_at is null and g.op_error then g.needs_review_reason
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

notify pgrst, 'reload schema';
