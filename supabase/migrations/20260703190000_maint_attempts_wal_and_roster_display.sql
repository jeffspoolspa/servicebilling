-- Maintenance charging on billing.processing_attempts proper (no separate
-- autopay_transactions write), and the autopay roster displays the LINKED
-- payment method, not the roster row's stale legacy columns.
--
-- 1. processing_attempts admits maintenance attempts: stage 'maint',
--    wo_number nullable (still required for WO stages).
-- 2. maint_billing_period_attempts reads processing_attempts (stage='maint')
--    — same return shape, so the Processing tab is unchanged.
-- 3. project_maint_processing_status + maint_billing_periods: the
--    autopay_charged gate reads processing_attempts charge evidence
--    (charge_id set, live run) instead of autopay_transactions.
-- 4. maint_billing_autopay_roster joins customer_payment_methods — the row
--    the engine actually charges — for brand/last4/type display.

-- 1) schema: admit maintenance attempts
alter table billing.processing_attempts alter column wo_number drop not null;
alter table billing.processing_attempts drop constraint processing_attempts_stage_check;
alter table billing.processing_attempts add constraint processing_attempts_stage_check
  check (stage in ('pre_process', 'process', 'maint'));
alter table billing.processing_attempts add constraint pa_wo_number_by_stage
  check (stage = 'maint' or wo_number is not null);
create index if not exists idx_processing_attempts_maint
  on billing.processing_attempts (qbo_invoice_id, attempted_at desc)
  where stage = 'maint';

-- 2) attempts RPC over processing_attempts (return shape unchanged)
create or replace function public.maint_billing_period_attempts(
  p_qbo_customer_id text,
  p_month text  -- 'YYYY-MM'
)
returns table (
  id                   uuid,
  created_at           timestamptz,
  status               text,
  dry_run              boolean,
  payment_method       text,
  card_type            text,
  last_four            text,
  charge_amount        numeric,
  charge_status        text,
  charge_error         text,
  charged_at           timestamptz,
  qbo_payment_id       text,
  qbo_invoice_numbers  text[],
  receipt_emailed      boolean,
  invoice_emailed      boolean,
  emailed_at           timestamptz,
  error_step           text,
  error_message        text,
  verified             boolean
)
language sql stable security definer
set search_path = billing, public
as $$
  select a.id, a.attempted_at, a.status, a.dry_run,
         case a.channel when 'credit_card' then 'card' else a.channel end,
         pm.card_brand, pm.last_four,
         a.charge_amount,
         case when a.charge_id is not null then 'captured' end,
         case when a.status in ('charge_declined', 'charge_uncertain')
              then a.error_message end,
         case when a.charge_id is not null then a.attempted_at end,
         a.qbo_payment_id,
         array_remove(array[a.invoice_number], null),
         coalesce((a.raw_result->>'receipt')::boolean, false),
         coalesce(a.email_sent, false),
         case when coalesce(a.email_sent, false) then a.attempted_at end,
         null::text,
         a.error_message,
         (a.status = 'succeeded')
  from billing.processing_attempts a
  left join billing.customer_payment_methods pm
    on pm.id = a.customer_payment_method_id
  where a.stage = 'maint'
    and a.qbo_invoice_id in (
      select tbp.qbo_invoice_id
      from billing_audit.task_billing_periods tbp
      where tbp.qbo_customer_id = p_qbo_customer_id
        and tbp.billing_month = (p_month || '-01')::date
        and tbp.qbo_invoice_id is not null)
  order by a.attempted_at desc;
$$;

-- 3a) projection: autopay_charged from processing_attempts charge evidence
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
  segment text, credits_applied jsonb
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
    (hold.held is true),
    tbp.processing_status,
    tbp.needs_review_reason,
    tbp.reviewed_at,
    b.name,
    case when nullif(c.company, '') is not null then 'commercial' else 'residential' end,
    tbp.credits_applied
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
  left join lateral (
    select true as held
    from v_chem_flags f
    where f.customer_id = c.id and f.month = p_month
      and not exists (select 1 from customer_month_audit a
                      where a.customer_id = c.id and a.month = p_month
                        and a.audit_status in ('reviewed', 'resolved'))
    limit 1
  ) hold on true
  where tbp.billing_month = p_month;
$$;

-- 4) roster displays the LINKED payment method (what the engine charges)
create or replace function public.maint_billing_autopay_roster()
returns table(
  qbo_customer_id text, customer_name text, payment_method text,
  card_type text, last_four text, email text, payment_status text,
  consecutive_declines integer, is_active boolean
)
language sql stable security definer
set search_path = billing, public
as $$
  select ac.qbo_customer_id, ac.customer_name,
         case pm.type when 'ach' then 'ach' when 'credit_card' then 'card'
              else pm.type end,
         pm.card_brand, pm.last_four,
         ac.email, ac.payment_status,
         ac.consecutive_declines::int, ac.is_active
  from autopay_customers ac
  left join customer_payment_methods pm on pm.id = ac.payment_method_id
  order by ac.customer_name;
$$;

notify pgrst, 'reload schema';
