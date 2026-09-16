-- Runaway fix (2026-09-16): dispatch_pre_processing ran ~12k/day as 1s no-ops.
--
-- trg_wake_service_preprocess (statement-level AFTER INSERT on the queue,
-- deployed 2026-07-26 outside the repo — 315,680 wakes sent) fired on the
-- drainer's own SELF_HEAL `INSERT ... SELECT`, which is a statement even when
-- it inserts zero rows. Drainer -> insert(0 rows) -> wake -> drainer, every
-- min_interval_secs (5s) forever.
--
-- The trigger is redundant: the only inserters are trg_enqueue_service_preprocess
-- (which already wakes) and the drainer itself (which is already draining).
drop trigger if exists trg_wake_service_preprocess on billing.service_preprocess_queue;
drop function if exists billing.wake_service_preprocess();
