-- Flags are computed AT PREPROCESSING, by the simple 2x rule (Carter,
-- 2026-07-02): ION-side misbillings are assumed fixed by the time invoices
-- link (the pre-billing CPV audit workflow catches them earlier), so nothing
-- holds a period before preprocessing. At preprocess time the projection
-- evaluates:
--   chem_flag           month's net consumable bill trips
--                       billing_audit.v_billing_review_flags (> 2x the peer
--                       group's clean median AND >= $150), unreviewed.
--                       Remediation = apply a discount on the QBO invoice;
--                       ION's record of what was sold stays intact.
--   ion_amount_mismatch / subtotal_mismatch / reconcile_mismatch / credit_error
--                       as before, but only once preprocessed.
-- The CPV z-score audit (customer_month_audit HIGH) is no longer a pipeline
-- gate — it remains the pre-billing analysis tool. Review release is
-- unchanged: maint_billing_flag_review upserts review state on
-- customer_month_audit and re-projects; reviewed/resolved releases chem_flag.
-- needs_review therefore ONLY exists post-preprocess; earlier stages read
-- pending / ion_matched. paid+sent -> processed still applies at ANY stage.

-- 1) reason enum: high_flag -> chem_flag
alter table billing_audit.task_billing_periods
  drop constraint if exists task_billing_periods_needs_review_reason_check;
update billing_audit.task_billing_periods
  set needs_review_reason = 'chem_flag' where needs_review_reason = 'high_flag';
alter table billing_audit.task_billing_periods
  add constraint task_billing_periods_needs_review_reason_check
  check (needs_review_reason is null or needs_review_reason in
    ('ion_amount_mismatch', 'subtotal_mismatch', 'chem_flag',
     'reconcile_mismatch', 'credit_error'));

-- 2) projection v2
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
           i.balance, i.email_status, i.total_amt
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
      -- the simple rule, evaluated at preprocess: chem bill > 2x clean median
      -- and >= $150, not yet reviewed (review state lives on customer_month_audit)
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
      (t.pre_processed_at is not null
        and t.qbo_invoice_id is not null and t.total_amt is not null
        and abs(coalesce(t.ion_amt_cents, 0) - round(t.total_amt * 100)) > 100)
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

-- 3) the RPC's hold indicator now reflects the pipeline's flag: an unreviewed
--    2x chem flag (column keeps its name for API compatibility)
create or replace function public.maint_billing_periods(p_month date)
returns table (
  id                        uuid,
  task_id                   uuid,
  billing_month             date,
  customer_id               bigint,
  customer_name             text,
  qbo_customer_id           text,
  ion_task_id               text,
  service_name              text,
  category                  text,
  frequency                 text,
  days_per_week             int,
  billing_type              text,
  billing_method            text,
  billable_visit_count      int,
  expected_labor_cents      int,
  expected_consumable_cents int,
  expected_total_cents      int,
  unpriced_count            int,
  ion_amt_cents             bigint,
  ion_invoice_numbers       text,
  ion_match                 text,
  qbo_invoice_id            text,
  qbo_doc_number            text,
  qbo_total                 numeric,
  qbo_balance               numeric,
  reconcile_status          text,
  labor_ok                  boolean,
  consumables_ok            boolean,
  locked                    boolean,
  on_autopay                boolean,
  autopay_charged           boolean,
  invoice_sent              boolean,
  high_flag_hold            boolean,
  processing_status         text,
  needs_review_reason       text,
  reviewed_at               timestamptz,
  office                    text,
  segment                   text
)
language sql stable security definer
set search_path = billing_audit, public
as $$
  select
    tbp.id, tbp.task_id, tbp.billing_month,
    c.id, c.display_name, tbp.qbo_customer_id,
    vc.ion_task_id, vc.service_name, vc.category, vc.frequency,
    vc.days_per_week::int, vc.billing_type,
    tbp.billing_method, tbp.billable_visit_count,
    tbp.expected_labor_cents, tbp.expected_consumable_cents, tbp.expected_total_cents,
    (select count(*) from jsonb_object_keys(coalesce(tbp.unpriced_consumables, '{}'::jsonb)))::int,
    tbp.ion_amt_cents, tbp.ion_invoice_number,
    case when tbp.ion_matched_at is null then 'missing'
         when abs(coalesce(tbp.ion_amt_cents, 0) - coalesce(tbp.expected_total_cents, 0)) <= 100
           then 'match'
         else 'mismatch' end,
    tbp.qbo_invoice_id, i.doc_number, i.total_amt, i.balance,
    tbp.status, tbp.labor_ok, tbp.consumables_ok,
    (tbp.locked_at is not null),
    (ac.qbo_customer_id is not null),
    (apt.charged is true),
    (mi.send_status = 'sent' or i.email_status = 'EmailSent'),
    (hold.held is true),
    tbp.processing_status,
    tbp.needs_review_reason,
    tbp.reviewed_at,
    b.name,
    case when nullif(c.company, '') is not null then 'commercial' else 'residential' end
  from task_billing_periods tbp
  left join public."Customers" c on c.qbo_customer_id = tbp.qbo_customer_id
  left join public.branches b on b.id = c.office_id
  left join maintenance.v_task_class vc on vc.task_id = tbp.task_id
  left join billing.invoices i on i.qbo_invoice_id = tbp.qbo_invoice_id
  left join maintenance_invoices mi on mi.qbo_invoice_id = tbp.qbo_invoice_id
  left join billing.autopay_customers ac on ac.qbo_customer_id = tbp.qbo_customer_id
  left join lateral (
    select true as charged
    from billing.autopay_transactions t
    where t.qbo_customer_id = tbp.qbo_customer_id
      and t.billing_month = to_char(p_month, 'YYYY-MM')
      and coalesce(t.dry_run, false) = false
      and t.status in ('charge_success', 'payment_created', 'completed', 'verified')
    limit 1
  ) apt on true
  left join lateral (
    -- unreviewed 2x chem flag (the pipeline's hold; CPV z-audit no longer gates)
    select true as held
    from v_billing_review_flags rf
    where rf.customer_id = c.id and rf.month = p_month
      and not exists (select 1 from customer_month_audit a
                      where a.customer_id = c.id and a.month = p_month
                        and a.audit_status in ('reviewed', 'resolved'))
    limit 1
  ) hold on true
  where tbp.billing_month = p_month;
$$;

revoke all on function public.maint_billing_periods(date) from public, anon;
grant execute on function public.maint_billing_periods(date) to authenticated, service_role;

-- 4) re-project the open months under the new rules
select billing_audit.project_maint_processing_status('2026-06-01');
select billing_audit.project_maint_processing_status('2026-07-01');

notify pgrst, 'reload schema';
