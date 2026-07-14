-- Wake triggers go statement-level (2026-07-14): a 12-row enqueue was firing
-- 12 pg_net wake POSTs -> 12 queued drain jobs that each ran and exited on
-- an empty queue. The wake functions never reference NEW, so FOR EACH
-- STATEMENT gives one wake per batch at zero information loss.
-- (trg_enqueue_service_preprocess keeps its row-level shape — its function
-- does the enqueue itself and needs NEW.)

drop trigger if exists trg_wake_qbo_inbox on billing.qbo_inbox;
create trigger trg_wake_qbo_inbox
  after insert on billing.qbo_inbox
  for each statement execute function billing.wake_qbo_inbox_drainer();

drop trigger if exists trg_wake_service_charge on billing.service_charge_queue;
create trigger trg_wake_service_charge
  after insert on billing.service_charge_queue
  for each statement execute function billing.wake_service_charge_worker();

drop trigger if exists trg_wake_maint_charge on billing_audit.maint_charge_queue;
create trigger trg_wake_maint_charge
  after insert on billing_audit.maint_charge_queue
  for each statement execute function billing.wake_maint_charge_worker();

drop trigger if exists trg_wake_maint_preprocess on billing_audit.maint_preprocess_queue;
create trigger trg_wake_maint_preprocess
  after insert on billing_audit.maint_preprocess_queue
  for each statement execute function billing.wake_maint_preprocess_worker();
