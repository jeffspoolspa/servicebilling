-- Maintenance billing: stored processing-status pipeline (stage 1 of the
-- ION-matched, invoice-linked state machine — columns + queue + backfill +
-- projection + ION matcher; triggers land in the next migration).
--
-- State machine on billing_audit.task_billing_periods.processing_status:
--   pending -> ion_matched (ION invoice number + amount stamped, $1 tol;
--              amount mismatch -> needs_review: ion_amount_mismatch)
--   ion_matched -> [QBO invoice cached, DocNumber match -> qbo_invoice_id set
--              + queued] -> preprocess -> needs_review | ready_to_process
--   needs_review <-> ready_to_process (projection re-evaluates gates)
--   -> processed (terminal; auto when invoice balance<=0 AND EmailSent, or
--      confirmed autopay charge, or manual)
-- "queued/preprocessing" is DERIVED (qbo_invoice_id set, pre_processed_at
-- null), never stored. "paid" stays a derived UI overlay (balance <= 0).
--
-- ONE projection function owns every transition
-- (billing_audit.project_maint_processing_status). It never demotes
-- 'processed' and skips locked months. reviewed_at is the manual override:
-- set when a human reviews a period, it passes the data-mismatch gates
-- (ion_amount/subtotal/reconcile/credit_error) — the HIGH CPV flag is NOT
-- overridden by it; that hold releases only via customer_month_audit review.

-- ── 1) Columns ──────────────────────────────────────────────────────
alter table billing_audit.task_billing_periods
  add column if not exists processing_status text not null default 'pending'
    check (processing_status in
      ('pending', 'ion_matched', 'needs_review', 'ready_to_process', 'processed')),
  add column if not exists ion_invoice_number text,
  add column if not exists ion_amt_cents      bigint,
  add column if not exists ion_matched_at     timestamptz,
  add column if not exists needs_review_reason text
    check (needs_review_reason is null or needs_review_reason in
      ('ion_amount_mismatch', 'subtotal_mismatch', 'high_flag',
       'reconcile_mismatch', 'credit_error')),
  add column if not exists pre_processed_at   timestamptz,
  add column if not exists credits_applied    jsonb,
  add column if not exists processed_at       timestamptz,
  add column if not exists reviewed_at        timestamptz;

-- The link trigger matches QBO DocNumber -> ion_invoice_number.
create index if not exists tbp_ion_invoice_number
  on billing_audit.task_billing_periods (ion_invoice_number)
  where ion_invoice_number is not null and qbo_invoice_id is null;

-- ── 2) Preprocess queue (filled by the link trigger, drained serially) ──
create table if not exists billing_audit.maint_preprocess_queue (
  id              bigint generated always as identity primary key,
  qbo_customer_id text not null,
  billing_month   date not null,
  enqueued_at     timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  attempts        int not null default 0,
  error           text
);
-- one live queue entry per customer-month (re-links dedupe into it)
create unique index if not exists maint_preprocess_queue_live
  on billing_audit.maint_preprocess_queue (qbo_customer_id, billing_month)
  where finished_at is null;

-- ── 3) Backfill April/May from the old derived chain, then lock them ──
-- (Old derivation lived in public.maint_billing_periods, migration
-- 20260702130000. Pre-June months predate the ION transactions report, so
-- they are grandfathered: status backfilled, ion_* stays null, month locked.)
update billing_audit.task_billing_periods tbp
set processing_status = d.st,
    needs_review_reason = case when d.st = 'needs_review' then 'high_flag' end,
    processed_at = case when d.st = 'processed' then coalesce(tbp.reconciled_at, now()) end
from (
  select p.id,
    case
      when p.qbo_invoice_id is not null and (
             exists (select 1 from billing.invoices i
                     where i.qbo_invoice_id = p.qbo_invoice_id
                       and (i.balance <= 0 or i.email_status = 'EmailSent'))
          or exists (select 1 from billing_audit.maintenance_invoices mi
                     where mi.qbo_invoice_id = p.qbo_invoice_id
                       and mi.send_status = 'sent')
          or exists (select 1 from billing.autopay_transactions t
                     where t.qbo_customer_id = p.qbo_customer_id
                       and t.billing_month = to_char(p.billing_month, 'YYYY-MM')
                       and coalesce(t.dry_run, false) = false
                       and t.status in ('charge_success', 'payment_created',
                                        'completed', 'verified')))
        then 'processed'
      when p.qbo_invoice_id is not null and exists (
             select 1 from billing_audit.customer_month_audit a
             join public."Customers" c on c.id = a.customer_id
             where c.qbo_customer_id = p.qbo_customer_id
               and a.month = p.billing_month
               and a.flag_level = 'HIGH' and a.audit_status = 'flagged')
        then 'needs_review'
      when p.qbo_invoice_id is not null then 'ready_to_process'
      else 'pending' end as st
  from billing_audit.task_billing_periods p
  where p.billing_month < date '2026-06-01'
) d
where tbp.id = d.id;

update billing_audit.task_billing_periods
set locked_at = coalesce(locked_at, now())
where billing_month < date '2026-06-01';

-- ── 4) The projection function — owns every transition ──────────────
create or replace function billing_audit.project_maint_processing_status(
  p_month date,
  p_qbo_customer_id text default null   -- null = the whole month
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
           i.balance, i.email_status, i.total_amt
    from task_billing_periods tbp
    left join billing.invoices i on i.qbo_invoice_id = tbp.qbo_invoice_id
    where tbp.billing_month = p_month
      and tbp.locked_at is null
      and tbp.processing_status <> 'processed'      -- terminal, never demoted
      and (p_qbo_customer_id is null or tbp.qbo_customer_id = p_qbo_customer_id)
  ),
  gates as (
    select t.*,
      -- confirmed non-dry-run autopay charge for the customer-month
      exists (select 1 from billing.autopay_transactions x
              where x.qbo_customer_id = t.qbo_customer_id
                and x.billing_month = to_char(p_month, 'YYYY-MM')
                and coalesce(x.dry_run, false) = false
                and x.status in ('charge_success','payment_created','completed','verified'))
        as autopay_charged,
      -- unreviewed HIGH CPV flag (NOT overridable by reviewed_at)
      exists (select 1 from customer_month_audit a
              join public."Customers" c on c.id = a.customer_id
              where c.qbo_customer_id = t.qbo_customer_id and a.month = p_month
                and a.flag_level = 'HIGH' and a.audit_status = 'flagged')
        as high_hold,
      -- data-mismatch gates (all pass once a human sets reviewed_at)
      (t.ion_matched_at is not null
        and abs(coalesce(t.ion_amt_cents, 0) - coalesce(t.expected_total_cents, 0)) > 100)
        as ion_mismatch,
      -- per-row: one ION invoice per task -> compare the period's ION amount
      -- to ITS OWN QBO invoice total (sync-fidelity; the maintenance
      -- subtotal_ok). Split re-bills (ion_amt = SUM over >1 txn) deliberately
      -- trip this and surface for review.
      (t.qbo_invoice_id is not null and t.total_amt is not null
        and abs(coalesce(t.ion_amt_cents, 0) - round(t.total_amt * 100)) > 100)
        as subtotal_mismatch,
      (t.reconcile_status = 'mismatch') as reconcile_mismatch,
      -- sticky operational flag: only a clean preprocess re-run clears it
      (t.needs_review_reason = 'credit_error' and t.processing_status = 'needs_review')
        as credit_error
    from target t
  ),
  verdict as (
    select g.id,
      case
        -- terminal first: paid+sent from the cache (covers manual processing
        -- outside the app) or our own confirmed charge
        when g.qbo_invoice_id is not null
             and ((g.balance is not null and g.balance <= 0
                   and g.email_status = 'EmailSent')
                  or g.autopay_charged)
          then 'processed'
        when g.ion_matched_at is null then 'pending'
        when g.high_hold
             or (g.reviewed_at is null
                 and (g.ion_mismatch or g.subtotal_mismatch
                      or g.reconcile_mismatch or g.credit_error))
          then 'needs_review'
        -- linked + preprocessed + clean -> ready; not yet linked or not yet
        -- preprocessed -> ion_matched (UI derives "queued" from the FK)
        when g.qbo_invoice_id is not null and g.pre_processed_at is not null
          then 'ready_to_process'
        else 'ion_matched'
      end as st,
      case
        when g.high_hold then 'high_flag'
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

-- ── 5) ION matcher — stage 1 (promise gets its ION invoice number) ──
create or replace function billing_audit.match_promises_to_ion(p_month date)
returns int
language sql security definer
set search_path = billing_audit, public
as $$
  with agg as (
    -- one invoice per task; a split re-bill means >1 txn -> SUM the amount,
    -- keep the max-amount txn as the representative (linkable) number
    select itt.ion_task_id,
           sum(itt.amt_cents)::bigint as amt_cents,
           (array_agg(itt.transaction_id order by itt.amt_cents desc))[1] as rep
    from ion_task_transactions itt
    where itt.month = p_month
    group by 1
  ),
  stamped as (
    update task_billing_periods tbp
    set ion_invoice_number = agg.rep,
        ion_amt_cents      = agg.amt_cents,
        ion_matched_at     = coalesce(tbp.ion_matched_at, now()),
        updated_at         = now()
    from maintenance.v_task_class vc
    join agg on agg.ion_task_id = vc.ion_task_id
    where vc.task_id = tbp.task_id
      and tbp.billing_month = p_month
      and tbp.locked_at is null
      and (tbp.ion_invoice_number is distinct from agg.rep
           or tbp.ion_amt_cents is distinct from agg.amt_cents)
    returning 1
  )
  select count(*)::int from stamped;
$$;

revoke all on function billing_audit.project_maint_processing_status(date, text) from public, anon, authenticated;
revoke all on function billing_audit.match_promises_to_ion(date) from public, anon, authenticated;
grant execute on function billing_audit.project_maint_processing_status(date, text) to service_role;
grant execute on function billing_audit.match_promises_to_ion(date) to service_role;
