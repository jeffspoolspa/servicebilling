-- Customers joins the supersession family (Carter 2026-07-20): every QBO
-- entity we mirror carries a `fetched_at` — "when WE last wrote this row" —
-- so the qbo_inbox drainer can moot-finish an entity whose cache is already
-- fresher than the signal, uniformly, at zero API cost. Customer was the one
-- entity without it (it has qbo_last_updated = the LEADER's edit time, which
-- is not the same question — supersession asks about OUR fetch, not QBO's edit).
--
-- Backfill from the best "we touched it" signal we already have.

alter table public."Customers" add column if not exists fetched_at timestamptz;

update public."Customers"
set fetched_at = coalesce(sync_state_changed_at, imported_at)
where fetched_at is null;
