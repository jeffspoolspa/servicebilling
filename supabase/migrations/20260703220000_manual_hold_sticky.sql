-- Manual holds that SURVIVE re-projection. Flipping a clean period to
-- needs_review previously bounced straight back to ready_to_process (no gate
-- fails, so the RPC's own re-projection undid it). Now:
--   - set_processing_status(needs_review) stamps needs_review_reason
--     'manual_hold' (and clears it when marking ready)
--   - the projection treats manual_hold as a sticky gate, same idea as
--     credit_error/enrichment_error: held until someone marks it ready.

-- 1) projection: manual_hold is a sticky gate
create or replace function billing_audit.project_maint_processing_status(
  p_month date, p_qbo_customer_id text default null
)
returns integer
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
      exists (select 1 from billing.processing_attempts x
              where x.stage = 'maint'
                and x.qbo_invoice_id = t.qbo_invoice_id
                and coalesce(x.dry_run, false) = false
                and x.charge_id is not null
                and x.status in ('charge_succeeded', 'email_failed', 'succeeded'))
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
        as op_error,
      (t.needs_review_reason = 'manual_hold'
        and t.processing_status = 'needs_review')
        as manual_hold
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
             or g.manual_hold
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
        when g.manual_hold then 'manual_hold'
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

-- 2) set RPC: manual needs_review stamps the sticky reason; marking ready
--    clears it (reviewed_at already covers the data-mismatch gates)
create or replace function public.maint_billing_set_processing_status(
  p_ids uuid[],
  p_status text
)
returns int
language plpgsql security definer
set search_path = billing_audit, public
as $$
declare v_n int;
begin
  if p_status not in ('needs_review', 'ready_to_process', 'processed') then
    raise exception 'invalid processing_status: %', p_status;
  end if;
  update task_billing_periods tbp
  set processing_status = p_status,
      needs_review_reason = case
        when p_status = 'needs_review' then coalesce(needs_review_reason, 'manual_hold')
        when p_status = 'ready_to_process' then null
        else needs_review_reason end,
      reviewed_at = case when p_status = 'ready_to_process'
                         then coalesce(reviewed_at, now()) else reviewed_at end,
      processed_at = case when p_status = 'processed'
                          then coalesce(processed_at, now()) else processed_at end,
      updated_at = now()
  where tbp.id = any(p_ids)
    and tbp.locked_at is null
    and tbp.processing_status <> 'processed';
  get diagnostics v_n = row_count;

  -- re-project: releases what should release, and manual_hold now sticks
  perform billing_audit.project_maint_processing_status(t.billing_month, t.qbo_customer_id)
  from (select distinct billing_month, qbo_customer_id
        from task_billing_periods where id = any(p_ids)) t;
  return v_n;
end;
$$;

notify pgrst, 'reload schema';

-- 3) the reason CHECK must admit the new value
alter table billing_audit.task_billing_periods
  drop constraint task_billing_periods_needs_review_reason_check;
alter table billing_audit.task_billing_periods
  add constraint task_billing_periods_needs_review_reason_check
  check (needs_review_reason is null or needs_review_reason in
         ('ion_amount_mismatch', 'subtotal_mismatch', 'chem_flag',
          'reconcile_mismatch', 'credit_error', 'enrichment_error',
          'manual_hold'));
