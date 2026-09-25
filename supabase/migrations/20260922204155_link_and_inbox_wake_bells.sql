-- Two missing bells for the service pre-process drainer (2026-09-22), both
-- exposed the same day the runaway 5s wake was removed (that loop had been
-- masking them: its SELF_HEAL scan ran every drain).
--
-- Bell 1 — ION link path. trg_link_invoice_on_wo_change is a BEFORE trigger
-- that fills work_orders.qbo_invoice_id when the ION ingest writes
-- invoice_number. Postgres fires `UPDATE OF qbo_invoice_id` triggers only
-- when the STATEMENT names that column, so a BEFORE-trigger assignment
-- never reached trg_enqueue_service_preprocess, trg_emit_invoice_linked or
-- trg_bootstrap_indicators_on_wo_link. 47 of the 68 invoices synced 2026-09-22
-- linked this way with no queue row and no invoice_linked event.
-- Fix: a sibling of each, on UPDATE OF invoice_number, gated by the VALUE
-- change so the daily ION upsert of already-linked WOs fires nothing.
--
-- Bell 2 — inbox clear. dispatch_pre_processing refuses to CLAIM while
-- Payment/CreditMemo rows are unprocessed in billing.qbo_inbox
-- (credits_cache_fresh), and "nothing claimable" means no self-wake. Our own
-- stage-1 credit applications and stage-2 charges echo back as Payment
-- webhooks, so a burst stalls its own next batch (17 rows stranded 20:01).
-- Fix: when a Payment/CreditMemo inbox row finishes and pre-process work is
-- waiting, wake the pre-process drainer. Row-level; the pre-process drainer
-- never writes qbo_inbox, so it cannot loop; wake_queue_worker throttles.

-- Bell 1 -------------------------------------------------------------------
create trigger trg_enqueue_service_preprocess_via_number
  after update of invoice_number on public.work_orders
  for each row when (old.qbo_invoice_id is distinct from new.qbo_invoice_id)
  execute function billing.enqueue_service_preprocess();

create trigger trg_emit_invoice_linked_via_number
  after update of invoice_number on public.work_orders
  for each row when (old.qbo_invoice_id is distinct from new.qbo_invoice_id)
  execute function billing.fn_emit_invoice_linked();

create trigger trg_bootstrap_indicators_on_wo_link_via_number
  after update of invoice_number on public.work_orders
  for each row when (old.qbo_invoice_id is distinct from new.qbo_invoice_id)
  execute function billing.fn_bootstrap_indicators_on_wo_link();

-- Bell 2 -------------------------------------------------------------------
create or replace function billing.wake_preprocess_on_inbox_clear()
returns trigger
language plpgsql
security definer
set search_path to 'billing'
as $$
begin
  if exists (select 1 from billing.service_preprocess_queue
              where finished_at is null and attempts < 3) then
    perform billing.wake_queue_worker('f/service_billing/dispatch_pre_processing',
                                      '{}'::jsonb);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_wake_preprocess_on_inbox_clear on billing.qbo_inbox;
create trigger trg_wake_preprocess_on_inbox_clear
  after update of finished_at on billing.qbo_inbox
  for each row when (old.finished_at is null and new.finished_at is not null
                     and new.entity_type in ('Payment','CreditMemo'))
  execute function billing.wake_preprocess_on_inbox_clear();
