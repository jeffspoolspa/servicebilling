-- maint_billing_periods: the chem-flag hold was a PER-ROW lateral over
-- v_chem_flags (a percentile view) — 547 evaluations per call, >8s under
-- burst load (statement timeout). Evaluate the view ONCE per month and
-- hash-join by customer instead.

-- 3b) periods RPC: same swap for the autopay_charged column
create or replace function public.maint_billing_periods(p_month date)
returns table(
  id uuid, task_id uuid, billing_month date, customer_id bigint,
  customer_name text, qbo_customer_id text, ion_task_id text,
  service_name text, category text, frequency text, days_per_week integer,
  billing_type text, billing_method text, billable_visit_count integer,
  expected_labor_cents integer, expected_consumable_cents integer,
  expected_total_cents integer, unpriced_count integer, ion_amt_cents bigint,
  ion_invoice_numbers text, ion_match text, qbo_invoice_id text,
  qbo_doc_number text, qbo_total numeric, qbo_balance numeric,
  reconcile_status text, labor_ok boolean, consumables_ok boolean,
  locked boolean, on_autopay boolean, autopay_charged boolean,
  invoice_sent boolean, high_flag_hold boolean, processing_status text,
  needs_review_reason text, reviewed_at timestamptz, office text,
  segment text, credits_applied jsonb, reconcile_notes text
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
    (tbp.autopay_customer_id is not null or ac.qbo_customer_id is not null),
    (apt.charged is true),
    (mi.send_status = 'sent' or i.email_status = 'EmailSent'),
    (hold.customer_id is not null),
    tbp.processing_status,
    tbp.needs_review_reason,
    tbp.reviewed_at,
    b.name,
    case when nullif(c.company, '') is not null then 'commercial' else 'residential' end,
    tbp.credits_applied,
    tbp.notes
  from task_billing_periods tbp
  left join public."Customers" c on c.qbo_customer_id = tbp.qbo_customer_id
  left join public.branches b on b.id = c.office_id
  left join maintenance.v_task_class vc on vc.task_id = tbp.task_id
  left join billing.invoices i on i.qbo_invoice_id = tbp.qbo_invoice_id
  left join maintenance_invoices mi on mi.qbo_invoice_id = tbp.qbo_invoice_id
  left join billing.autopay_customers ac
    on ac.qbo_customer_id = tbp.qbo_customer_id and ac.is_active
  left join lateral (
    select true as charged
    from billing.processing_attempts t
    where t.stage = 'maint'
      and t.qbo_invoice_id = tbp.qbo_invoice_id
      and coalesce(t.dry_run, false) = false
      and t.charge_id is not null
      and t.status in ('charge_succeeded', 'email_failed', 'succeeded')
    limit 1
  ) apt on true
  left join (
    select distinct f.customer_id
    from v_chem_flags f
    where f.month = p_month
      and not exists (select 1 from customer_month_audit a
                      where a.customer_id = f.customer_id and a.month = p_month
                        and a.audit_status in ('reviewed', 'resolved'))
  ) hold on hold.customer_id = c.id
  where tbp.billing_month = p_month;
$$;


revoke all on function public.maint_billing_periods(date) from public, anon;
grant execute on function public.maint_billing_periods(date) to authenticated, service_role;

notify pgrst, 'reload schema';
