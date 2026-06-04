-- Add the Pattern D cache-state columns to public."Customers".
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- We are making QBO the leader for customer identity from first contact: a new
-- customer is created in QBO at lead intake via the Pattern D write-through
-- (lib/qbo/write.ts). That state machine marks the cache row pending ->
-- awaiting_propagation -> synced and records sync errors. billing.invoices
-- already has these columns; public."Customers" did not, so the customer
-- write-through (ENTITY_CONFIG.customer) could never run. Decisions:
-- ~/.claude/plans/snoopy-hugging-lantern.md + docs/adrs/004-leads-canonical-model.md.
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- Mirror billing.invoices exactly: sync_state text NOT NULL default 'synced',
-- sync_state_changed_at timestamptz NOT NULL default now(), sync_error text null.
-- All ~8,876 existing customers are considered 'synced' (they already reflect QBO).
--
-- ─────────────────────────────────────────────────────────────────
-- WHAT WE KEEP / WHAT WE LOSE
-- ─────────────────────────────────────────────────────────────────
-- Additive only. No data lost. Existing rows default to 'synced'.

alter table public."Customers"
  add column if not exists sync_state text not null default 'synced',
  add column if not exists sync_state_changed_at timestamptz not null default now(),
  add column if not exists sync_error text;

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='Customers' and column_name='sync_state'
  ) then
    raise exception 'Customers.sync_state was not added';
  end if;
end $$;
