-- Model B: price consumables into the task billing period (the write-ahead promise).
--
-- Until now a promise carried labor only (expected_labor_cents) plus a {item_name: qty}
-- map; consumable DOLLARS lived only on the QBO invoice. Model B computes the expected
-- consumable dollars on OUR side so the promise can compute the task's FULL monthly total
-- and reconcile it against the ION invoice report (which should match QBO). Purpose is a
-- pre-sync DATA-QUALITY GATE: (1) surface glaring QBO issues to fix BEFORE we sync to ION,
-- and (2) confirm every visit for the month synced before running analysis. This is NOT
-- fraud / mispricing detection.
--
--   expected_consumable_cents  SUM over the month's usage of (item qty x unit_price_cents),
--                              priced by ion_item_id -> maintenance.consumables (the item
--                              master; see migration 20260701010000). Immune to item_id null-out.
--   expected_total_cents       DERIVED (generated): expected_labor_cents + expected_consumable_cents.
--                              Generated so it can NEVER disagree with its parts (one-writer discipline).
--   unpriced_consumables       {item_name: qty} for usage we could not price (no item_id, or
--                              items.price NULL/0). Makes expected_consumable_cents a known FLOOR
--                              instead of a silent undercount.
--
-- Price source validated 2026-07-01: QBO item price tracked the billed chemical total within
-- 3-11% per month (Feb-May 2026); via maintenance.consumables (ion_item_id key) June coverage
-- is 97% of rows (up from 22% on the item_id join).
--
-- Additive + nullable + generated -> safe, reversible (drop the three columns to revert).
-- The reconcile step (reconcile_billing_periods.py) reads expected_labor_cents and the qty
-- map only, so it is unaffected by this change.

alter table billing_audit.task_billing_periods
  add column if not exists expected_consumable_cents integer,
  add column if not exists unpriced_consumables jsonb not null default '{}'::jsonb,
  add column if not exists expected_total_cents integer
    generated always as (coalesce(expected_labor_cents, 0) + coalesce(expected_consumable_cents, 0)) stored,
  -- locked_at: a finalized month. The builder runs continuously (daily / any time mid-month)
  -- and UPSERTs the OPEN months so the table is a live picture of where billing stands. Once a
  -- month is billed + reconciled it is locked (locked_at set); the builder then SKIPS it entirely
  -- -- no wasted recompute, and a late retroactive visit edit can't disturb a closed month.
  add column if not exists locked_at timestamptz;

comment on column billing_audit.task_billing_periods.expected_consumable_cents is
  'Model B: SUM(consumable qty x maintenance.consumables.unit_price_cents) for the task-month, in cents, priced by ion_item_id. Unpriced tail is in unpriced_consumables.';
comment on column billing_audit.task_billing_periods.expected_total_cents is
  'Derived (generated): expected_labor_cents + expected_consumable_cents. Never hand-set.';
comment on column billing_audit.task_billing_periods.unpriced_consumables is
  '{item_name: qty} for consumables with no item_id or no items.price -> expected_consumable_cents is a floor, not exact.';
