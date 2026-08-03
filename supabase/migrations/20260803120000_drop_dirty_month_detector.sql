-- Dropped 2026-08-03 (Carter): redundant with the reconciler. The trigger
-- could only see rows the ingester writes — recent days, whose months are in
-- active accrual anyway. The changes that matter are edits to PAST months,
-- which the ingester never re-reads; those are caught by the reconcile
-- against ION's own report, which self-heals via the targeted log refresh.
drop trigger if exists trg_detect_dirty_billing_months_ins on maintenance.visits;
drop trigger if exists trg_detect_dirty_billing_months_upd on maintenance.visits;
drop function if exists billing.detect_dirty_billing_months();
