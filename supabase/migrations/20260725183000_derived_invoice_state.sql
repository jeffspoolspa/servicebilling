-- ADR 011: invoice state is derived from facts; not sending is an event.
--
-- Additive only. This lands the derivation ALONGSIDE billing_status so the two
-- can be diffed on live data. Nothing reads it yet and the latch is untouched;
-- removing it is a later migration, after the diff is accepted.
--
-- Scope: WO-linked (service) invoices only. 1,638 maintenance invoices share
-- this table and have a different lifecycle — running this model over them
-- labels the whole maintenance book wrongly.

-- 1. the waiver fold -------------------------------------------------------
-- Not sending is a decision, so it is an event, and it is reversible: the
-- most recent of skip_send / skip_send_revoked wins.
create or replace function billing.send_waived(p_qbo_invoice_id text)
returns boolean
language sql stable
set search_path to 'billing', 'public'
as $$
  select coalesce(
    (select e.type = 'skip_send'
       from billing.events e
      where e.aggregate = 'invoice'
        and e.aggregate_id = p_qbo_invoice_id
        and e.type in ('skip_send', 'skip_send_revoked')
      order by e.seq desc
      limit 1), false)
$$;

-- 2. did WE settle this invoice? -------------------------------------------
-- The responsibility rule. An invoice that settled without us completed
-- outside our system, so we owe no delivery on it.
--
-- billing.events is the intended source (its actor says who acted), but it
-- was created 2026-07-23 and has no earlier history — so the pre-event era
-- falls back to the records that do: processing_attempts and invoice_send_log.
create or replace function billing.we_settled_it(p_qbo_invoice_id text)
returns boolean
language sql stable
set search_path to 'billing', 'public'
as $$
  select exists (select 1 from billing.processing_attempts a
                  where a.qbo_invoice_id = p_qbo_invoice_id)
      or exists (select 1 from billing.invoice_send_log s
                  where s.qbo_invoice_id = p_qbo_invoice_id)
      or exists (select 1 from billing.events e
                  where e.aggregate = 'invoice'
                    and e.aggregate_id = p_qbo_invoice_id
                    and e.type in ('payment_applied', 'charge_succeeded',
                                   'invoice_sent')
                    and e.actor <> 'external')
$$;

-- 3. the state view --------------------------------------------------------
-- One definition, set-based. The scalar function below delegates to it so the
-- rule cannot drift between the row view and the per-invoice call.
create or replace view billing.v_invoice_state as
select
  i.qbo_invoice_id,
  i.qbo_customer_id,
  i.doc_number,
  i.txn_date,
  i.balance,
  -- facts
  (coalesce(i.email_status, '') = 'EmailSent'
   or billing.send_waived(i.qbo_invoice_id))            as sent,
  coalesce(i.balance, 0) < 0.01                          as settled,
  (i.pre_processed_at is not null
   and coalesce(i.enrichment_ok, false))                 as enriched,
  billing.send_waived(i.qbo_invoice_id)                  as send_waived,
  -- in flight = a CLAIMABLE queue row. attempts < 3 matters: a dead-lettered
  -- row keeps finished_at NULL forever, and counting it as in-flight would
  -- hide the invoice exactly the way the latch does.
  (exists (select 1 from billing.service_preprocess_queue q
            where q.qbo_invoice_id = i.qbo_invoice_id
              and q.finished_at is null and q.attempts < 3)
   or exists (select 1 from billing.service_charge_queue q
            where q.qbo_invoice_id = i.qbo_invoice_id
              and q.finished_at is null and q.attempts < 3)) as in_flight,
  -- the state
  case
    when (coalesce(i.email_status, '') = 'EmailSent'
          or billing.send_waived(i.qbo_invoice_id))
         and coalesce(i.balance, 0) < 0.01                then 'paid'
    when (coalesce(i.email_status, '') = 'EmailSent'
          or billing.send_waived(i.qbo_invoice_id))       then 'ar'
    when exists (select 1 from billing.service_preprocess_queue q
                  where q.qbo_invoice_id = i.qbo_invoice_id
                    and q.finished_at is null and q.attempts < 3)
      or exists (select 1 from billing.service_charge_queue q
                  where q.qbo_invoice_id = i.qbo_invoice_id
                    and q.finished_at is null and q.attempts < 3)
                                                          then 'in_flight'
    else 'needs_review'
  end as state
from billing.invoices i
where exists (select 1 from public.work_orders w
               where w.qbo_invoice_id = i.qbo_invoice_id);

comment on view billing.v_invoice_state is
  'ADR 011. Derived invoice state for WO-linked (service) invoices only. '
  'paid/ar are the processed views and both require sent; in_flight is a '
  'claimable queue row, not a state; needs_review is the residual — not '
  'finished and nothing will move it automatically.';

create or replace function billing.invoice_state(p_qbo_invoice_id text)
returns text
language sql stable
set search_path to 'billing', 'public'
as $$
  select v.state from billing.v_invoice_state v
   where v.qbo_invoice_id = p_qbo_invoice_id
$$;

-- 4. "awaiting invoice" already exists, on the WORK ORDER -----------------
-- An invoice cannot be waiting for itself to exist, and billing.v_awaiting_invoice
-- already models this correctly:
--   work_orders WHERE billable AND qbo_invoice_id IS NULL
--               AND coalesce(sub_total,0) > 0 AND skipped_at IS NULL
-- 145 rows today. Deliberately NOT redefined here — its sub_total > 0 filter is
-- right (a zero-value work order needs no invoice) and this ADR only confirms
-- that the state belongs to the work order.
