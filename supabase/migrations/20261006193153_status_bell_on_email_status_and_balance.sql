-- billing_status re-projects when email_status or balance changes.
--
-- Module: docs/modules/service/billing.md
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- v3 (20260722171144 / 20260725183000) made compute_billing_status decide
-- from email_status and balance directly (terminal = settled AND delivered;
-- nothing left to do = open_ar). The bell that re-projects the stored
-- billing_status, trg_project_billing_status_on_indicator_change, kept
-- watching only the pre-v3 indicator columns. refresh_invoice and the send
-- path both rely on that bell ("NO MANUAL RECHECK NEEDED"), so:
--   - an email-route invoice sent by the queue stayed ready_to_process
--     until paid: 62 open invoices on 2026-10-06, txn 2026-08-26..09-30;
--   - an invoice emailed while in credit_review stayed in triage
--     (8116010, 8116116).
-- The queue was never fooled (its CLAIM re-asks invoice_ready live); the
-- stored column and everything reading it (triage, customer billing page,
-- WO export) were.
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- 1. Recreate the trigger with email_status and balance in its column list
--    and WHEN clause. Same function, same timing (AFTER UPDATE, per row).
--    fn_auto_promote_to_processed (BEFORE) still stamps processed first on
--    paid+sent; the projection then agrees with it.
-- 2. Re-project every open invoice whose stored status disagrees with the
--    computed one, EXCEPT where the computed status is ready_to_process:
--    those would enqueue a send/charge, which is a person's call
--    (8116043, 8116137, 8116107 on 2026-10-06).
--
-- ─────────────────────────────────────────────────────────────────
-- WHAT WE KEEP / WHAT WE LOSE
-- ─────────────────────────────────────────────────────────────────
-- Keep: the trigger function and every other bell. Each re-projected move
-- to needs_review emits invoice_held_for_review (fn_emit_gate_decision),
-- dated now: the event the missing bell should have emitted at send time.
-- Nothing is enqueued (checked below).

-- 1. the bell
drop trigger trg_project_billing_status_on_indicator_change on billing.invoices;

create trigger trg_project_billing_status_on_indicator_change
after update of subtotal_ok, credits_ok, payment_method_ok, attempts_ok,
                memo, qbo_class, memo_locked, pre_processed_at,
                email_status, balance
on billing.invoices
for each row
when (   old.subtotal_ok       is distinct from new.subtotal_ok
      or old.credits_ok        is distinct from new.credits_ok
      or old.payment_method_ok is distinct from new.payment_method_ok
      or old.attempts_ok       is distinct from new.attempts_ok
      or old.enrichment_ok     is distinct from new.enrichment_ok
      or old.pre_processed_at  is distinct from new.pre_processed_at
      or old.email_status      is distinct from new.email_status
      or old.balance           is distinct from new.balance)
execute function billing.fn_project_billing_status_on_indicator_change();

-- 2. re-project what the missing bell left stale
create temp table _queue_before as
select count(*) as n from billing.service_charge_queue where finished_at is null;

create temp table _stale as
select i.qbo_invoice_id
  from billing.invoices i
  join public.work_orders w on w.qbo_invoice_id = i.qbo_invoice_id
  cross join lateral billing.compute_billing_status(i.qbo_invoice_id) c
 where i.billing_status <> 'processed' and w.billable and w.skipped_at is null
   and (i.billing_status, i.needs_review_reason)
       is distinct from (c.billing_status, c.needs_review_reason)
   and c.billing_status <> 'ready_to_process';

select billing.project_billing_status(qbo_invoice_id) from _stale;

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
do $$
declare v_left int; v_queued int;
begin
  select count(*) into v_left
    from _stale s
    join billing.invoices i using (qbo_invoice_id)
    cross join lateral billing.compute_billing_status(i.qbo_invoice_id) c
   where (i.billing_status, i.needs_review_reason)
         is distinct from (c.billing_status, c.needs_review_reason);
  if v_left > 0 then
    raise exception 're-projection left % invoice(s) stale', v_left;
  end if;
  select (select count(*) from billing.service_charge_queue where finished_at is null)
         - (select n from _queue_before) into v_queued;
  if v_queued <> 0 then
    raise exception 're-projection changed the charge queue by % row(s)', v_queued;
  end if;
end $$;

drop table _stale;
drop table _queue_before;
