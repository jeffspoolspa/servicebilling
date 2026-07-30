-- Charge-stage work queue (WORKFLOW_EXECUTION.md applied to maintenance
-- Phase B). Unit of work = one customer-month. A trigger enqueues on the
-- ready_to_process transition; f/billing/process_maint_charges drains until
-- empty and resolves everything else at claim time (envelope, not payload).
--
-- Also: the projection learns the delivered-without-charge rule, so the
-- worker stamps NO status — processed/needs_review derive entirely from
-- facts (attempt log + invoice cache echoes + roster). ADR 009 §E.
--
-- billing_audit.maint_process_queue (period-keyed, engine-seeded UI mirror)
-- is superseded; kept for history, no longer written.

-- 1. the queue ---------------------------------------------------------------

create table if not exists billing_audit.maint_charge_queue (
  id bigint generated always as identity primary key,
  qbo_customer_id text not null,
  billing_month date not null,
  priority int not null default 3,          -- 1 = money-critical .. 5 = analytics (ADR 008 §4)
  received_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  attempts int not null default 0,
  error text
);

-- coalescing: N ready-transitions for one customer-month = one unit of work
create unique index if not exists maint_charge_queue_live
  on billing_audit.maint_charge_queue (qbo_customer_id, billing_month)
  where finished_at is null;
create index if not exists maint_charge_queue_recent
  on billing_audit.maint_charge_queue (received_at desc);

-- 2. the trigger: period becomes ready -> enqueue its customer-month ---------

create or replace function billing_audit.enqueue_maint_charge()
returns trigger
language plpgsql security definer
set search_path to 'billing_audit', 'public'
as $$
begin
  insert into billing_audit.maint_charge_queue (qbo_customer_id, billing_month)
  values (new.qbo_customer_id, new.billing_month)
  on conflict (qbo_customer_id, billing_month) where finished_at is null
  do nothing;
  return new;
end;
$$;

drop trigger if exists trg_enqueue_maint_charge on billing_audit.task_billing_periods;
create trigger trg_enqueue_maint_charge
  after insert or update of processing_status on billing_audit.task_billing_periods
  for each row
  when (new.processing_status = 'ready_to_process')
  execute function billing_audit.enqueue_maint_charge();

-- 3. projection: the delivered-without-charge rule ---------------------------
-- processed now derives for ALL paths:
--   charge path:  attempt log (charge_id + charge_succeeded/email_failed/
--                 succeeded) or paid+sent echoes           (already present)
--   email path:   invoice delivered and the month is not chargeable
--                 (no active roster, or no live payment method)      (NEW)
--   declined:     invoice delivered and the latest real attempt was a
--                 decline — collection moves to balance + autopay health (NEW)

create or replace function billing_audit.project_maint_processing_status(
  p_month date,
  p_qbo_customer_id text default null
) returns int
language sql security definer
set search_path to 'billing_audit', 'public'
as $$
  with target as (
    select tbp.id,
           tbp.processing_status, tbp.needs_review_reason,
           tbp.ion_matched_at, tbp.ion_amt_cents, tbp.expected_total_cents,
           tbp.qbo_invoice_id, tbp.pre_processed_at, tbp.reviewed_at,
           tbp.status as reconcile_status, tbp.qbo_customer_id,
           tbp.autopay_customer_id,
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
      -- chargeable = an active roster row AND at least one live payment
      -- method (the worker falls back to the customer's live default, so
      -- "any live PM" mirrors its behavior)
      (exists (select 1 from billing.autopay_customers ac
               where ac.id = t.autopay_customer_id and ac.is_active)
       and exists (select 1 from billing.customer_payment_methods pm2
                   where pm2.qbo_customer_id = t.qbo_customer_id
                     and pm2.is_active
                     and pm2.auto_disabled_at is null
                     and pm2.deactivated_at is null))
        as chargeable,
      (select a.status from billing.processing_attempts a
        where a.stage = 'maint'
          and a.qbo_invoice_id = t.qbo_invoice_id
          and coalesce(a.dry_run, false) = false
        order by a.attempted_at desc limit 1)
        as last_attempt_status,
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
                  or g.autopay_charged
                  -- delivered-without-charge: email-path months and
                  -- declined-but-delivered months are DONE; collection
                  -- lives on the balance + autopay health
                  or (g.email_status = 'EmailSent'
                      and (not g.chargeable
                           or g.last_attempt_status = 'charge_declined')))
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

-- 4. the UI read-model: queue leg reads the charge queue ---------------------
-- Attempts leg unchanged (per-invoice outcomes still come from the WAL; a
-- multi-invoice charge reports on its anchor row). Queued/in-flight rows now
-- expand a customer-month unit to its ready member periods.

drop function if exists public.maint_billing_recent_processing();

create function public.maint_billing_recent_processing()
returns table(
  period_id uuid,
  customer_name text,
  doc_number text,
  attempt_status text,
  channel text,
  email_sent boolean,
  charge_amount numeric,
  qbo_payment_id text,
  error_message text,
  attempted_at timestamptz,
  processing_status text,
  qbo_balance numeric,
  queue_order bigint
)
language sql stable security definer
set search_path to 'billing', 'public'
as $function$
  with attempts as (
    select distinct on (a.qbo_invoice_id)
           tbp.id as period_id, c.display_name as customer_name,
           a.invoice_number as doc_number,
           a.status as attempt_status, a.channel, a.email_sent,
           a.charge_amount, a.qbo_payment_id, a.error_message, a.attempted_at,
           tbp.processing_status, i.balance as qbo_balance,
           tbp.qbo_customer_id, tbp.billing_month
    from billing.processing_attempts a
    join billing_audit.task_billing_periods tbp on tbp.qbo_invoice_id = a.qbo_invoice_id
    left join public."Customers" c on c.qbo_customer_id = tbp.qbo_customer_id
    left join billing.invoices i on i.qbo_invoice_id = a.qbo_invoice_id
    where a.stage = 'maint'
      and coalesce(a.dry_run, false) = false
      and a.attempted_at > now() - interval '2 hours'
      and (a.attempted_at > now() - interval '10 minutes'
           or a.status in ('pending', 'charge_succeeded', 'charge_uncertain'))
    order by a.qbo_invoice_id, a.attempted_at desc
  )
  select a.period_id, a.customer_name, a.doc_number, a.attempt_status,
         a.channel, a.email_sent, a.charge_amount, a.qbo_payment_id,
         a.error_message, a.attempted_at, a.processing_status, a.qbo_balance,
         q.id as queue_order
  from attempts a
  left join lateral (
    select id from billing_audit.maint_charge_queue q
    where q.qbo_customer_id = a.qbo_customer_id
      and q.billing_month = a.billing_month
      and q.received_at > now() - interval '2 hours'
    order by q.received_at desc limit 1
  ) q on true
  union all
  -- queued / in-flight units expanded to their ready member periods
  select tbp.id, c.display_name, i.doc_number,
         case when q.attempts >= 3 then 'dead_letter'
              when q.started_at is not null then 'in_flight'
              else 'queued' end,
         null, null, null, null, q.error,
         q.received_at, tbp.processing_status, i.balance,
         q.id
  from billing_audit.maint_charge_queue q
  join billing_audit.task_billing_periods tbp
    on tbp.qbo_customer_id = q.qbo_customer_id
   and tbp.billing_month = q.billing_month
   and tbp.processing_status = 'ready_to_process'
   and tbp.locked_at is null
   and tbp.qbo_invoice_id is not null
  left join public."Customers" c on c.qbo_customer_id = tbp.qbo_customer_id
  left join billing.invoices i on i.qbo_invoice_id = tbp.qbo_invoice_id
  where q.finished_at is null
    and q.received_at > now() - interval '2 hours'
    and not exists (
      select 1 from billing.processing_attempts a
      where a.qbo_invoice_id = tbp.qbo_invoice_id
        and a.stage = 'maint' and coalesce(a.dry_run, false) = false
        and a.attempted_at > q.received_at
    );
$function$;
