-- Restore the service pre-process wake (2026-09-22).
--
-- 2026-09-16 dropped trg_wake_service_preprocess because it looped: it was
-- FOR EACH STATEMENT on the queue, and the drainer's own SELF_HEAL
-- `INSERT ... SELECT` is a statement even when it inserts zero rows, so every
-- drain rang its own alarm (~12k no-op runs/day, 315,688 wakes). That
-- migration assumed trg_enqueue_service_preprocess also woke the drainer. It
-- does not — it only inserts — so stage 1 has had NO starter since 9/16
-- (0 invoices pre-processed since; 84 in the two weeks before).
--
-- Fix: same alarm, same place, but FOR EACH ROW. A row-level AFTER INSERT
-- fires once per row actually inserted: a zero-row statement fires zero
-- times, and ON CONFLICT DO NOTHING rows are not inserted rows. So the wake
-- rings only when a queue row genuinely lands (new WO link, or a missed item
-- self-heal found), and the drainer can no longer wake itself on an idle
-- pass. Bursts collapse in billing.wake_queue_worker's 5s min_interval, which
-- is why the 2026-07-14 "wakes go statement-level" reasoning no longer
-- applies here: N rows = N cheap function calls, 1 POST.

create or replace function billing.wake_service_preprocess()
returns trigger
language plpgsql
security definer
set search_path to 'billing'
as $$
begin
  perform billing.wake_queue_worker('f/service_billing/dispatch_pre_processing',
                                    '{}'::jsonb);
  return null;
end;
$$;

drop trigger if exists trg_wake_service_preprocess on billing.service_preprocess_queue;
create trigger trg_wake_service_preprocess
  after insert on billing.service_preprocess_queue
  for each row execute function billing.wake_service_preprocess();

comment on trigger trg_wake_service_preprocess on billing.service_preprocess_queue is
  'Row-level on purpose: rings only for rows actually inserted, so the drainer''s '
  'zero-row SELF_HEAL statement cannot re-wake it (the 2026-09-16 runaway).';
