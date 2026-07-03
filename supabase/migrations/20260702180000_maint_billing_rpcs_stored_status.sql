-- /maintenance/billing RPCs on the STORED pipeline status (replaces the
-- read-time derivation from 20260702130000).
--
-- 1) maint_billing_periods: processing_status now comes from
--    task_billing_periods.processing_status; 'queued' is a DISPLAY overlay
--    (linked but not yet preprocessed). ION columns come from the stored
--    stamps (ion_invoice_number / ion_amt_cents), not a live re-aggregation.
--    Return shape changes (drop ion_txn_count; add needs_review_reason,
--    reviewed_at) -> DROP + CREATE.
-- 2) maint_billing_flag_review: after the review upsert, re-project the
--    customer-month — releasing a HIGH flag moves its periods out of
--    needs_review without waiting for any other event.
-- 3) maint_billing_set_processing_status: guarded manual transitions
--    (needs_review <-> ready_to_process, -> processed). Marking ready from a
--    data-mismatch hold stamps reviewed_at so re-projection doesn't re-hold.

drop function if exists public.maint_billing_periods(date);

create function public.maint_billing_periods(p_month date)
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
  ion_match                 text,     -- match | mismatch | missing
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
  processing_status         text,     -- pending | ion_matched | queued | needs_review | ready_to_process | processed
  needs_review_reason       text,
  reviewed_at               timestamptz
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
    case when tbp.qbo_invoice_id is not null and tbp.pre_processed_at is null
              and tbp.processing_status in ('pending', 'ion_matched')
         then 'queued' else tbp.processing_status end,
    tbp.needs_review_reason,
    tbp.reviewed_at
  from task_billing_periods tbp
  left join public."Customers" c on c.qbo_customer_id = tbp.qbo_customer_id
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

-- Flag review now re-projects: releasing (or re-flagging) a HIGH immediately
-- moves the customer's periods between needs_review and ready_to_process.
create or replace function public.maint_billing_flag_review(
  p_customer_id bigint,
  p_month date,
  p_status text,
  p_note text default null
)
returns boolean
language plpgsql security definer
set search_path = billing_audit, public
as $$
declare v_qbo text;
begin
  if p_status not in ('flagged', 'reviewed', 'resolved') then
    raise exception 'invalid audit_status: %', p_status;
  end if;
  insert into customer_month_audit (customer_id, month, flag_level, audit_status, audit_notes)
  values (p_customer_id, p_month, 'REVIEW_2X', p_status, p_note)
  on conflict (customer_id, month) do update
    set audit_status = excluded.audit_status,
        audit_notes  = coalesce(excluded.audit_notes, customer_month_audit.audit_notes);

  select qbo_customer_id into v_qbo from public."Customers" where id = p_customer_id;
  if v_qbo is not null then
    perform billing_audit.project_maint_processing_status(p_month, v_qbo);
  end if;
  return true;
end;
$$;

-- Guarded manual transitions. Marking ready stamps reviewed_at (passes the
-- data-mismatch gates on future re-projections; the HIGH-flag hold is NOT
-- bypassed — the projection re-holds if one is still unreviewed).
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
      reviewed_at = case when p_status = 'ready_to_process'
                         then coalesce(reviewed_at, now()) else reviewed_at end,
      processed_at = case when p_status = 'processed'
                          then coalesce(processed_at, now()) else processed_at end,
      updated_at = now()
  where tbp.id = any(p_ids)
    and tbp.locked_at is null
    and tbp.processing_status <> 'processed';
  get diagnostics v_n = row_count;

  -- re-project so a still-unreviewed HIGH flag immediately re-holds
  perform billing_audit.project_maint_processing_status(t.billing_month, t.qbo_customer_id)
  from (select distinct billing_month, qbo_customer_id
        from task_billing_periods where id = any(p_ids)) t;
  return v_n;
end;
$$;

revoke all on function public.maint_billing_periods(date) from public, anon;
revoke all on function public.maint_billing_set_processing_status(uuid[], text) from public, anon;
grant execute on function public.maint_billing_periods(date) to authenticated, service_role;
grant execute on function public.maint_billing_flag_review(bigint, date, text, text) to authenticated, service_role;
grant execute on function public.maint_billing_set_processing_status(uuid[], text) to authenticated, service_role;

notify pgrst, 'reload schema';
