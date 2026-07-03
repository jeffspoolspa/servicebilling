-- Drop the 'queued' display overlay from maint_billing_periods: the UI shows
-- a diff column instead of per-stage ION detail, and a linked-but-not-yet-
-- preprocessed period simply reads 'ion_matched' (the queue is internal
-- plumbing, not a user-facing stage). Same return shape as 20260702190000 —
-- only the processing_status expression changes.

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
    select true as held
    from customer_month_audit a
    where a.customer_id = c.id and a.month = p_month
      and a.flag_level = 'HIGH' and a.audit_status = 'flagged'
    limit 1
  ) hold on true
  where tbp.billing_month = p_month;
$$;
