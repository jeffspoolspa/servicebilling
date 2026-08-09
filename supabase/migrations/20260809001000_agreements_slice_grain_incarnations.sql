-- Applied via MCP 2026-08-08 as agreements_slice_grain_incarnations.
-- RULED 2026-08-08: incarnations are task-grain rows carrying a `covers`
-- selector {stopType, ionProfileId}. An agreement may hold SEVERAL open
-- incarnations (one per slice — ION forces one task per service type);
-- one-open-per-TASK remains the uniqueness law.
alter table agreements.ion_incarnations
  add column covers jsonb not null default '{}'::jsonb;
drop index if exists agreements.ion_incarnations_one_open_per_agreement;
