-- ADR 010: the money-movement aggregate is named 'charge' (an attempt is its
-- birth event, not the aggregate). Table is empty; pure constraint swap.
-- Applied 2026-07-23 via MCP apply_migration (recorded version 20260723133334).
alter table billing.events drop constraint events_aggregate_check;
alter table billing.events add constraint events_aggregate_check
  check (aggregate in ('invoice','payment','charge','customer','work_order'));
