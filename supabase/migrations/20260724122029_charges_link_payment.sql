-- The charge->payment link: leg 2's completion recorded on leg 1's row.
-- A captured charge with qbo_payment_id NULL IS the payment_orphan set
-- (derived, queryable — no WAL archaeology). Stamped at record time from
-- the create response; healed by recovery/reconciler lookups.
-- Applied 2026-07-24 via MCP apply_migration (recorded 20260724122029).
alter table billing.charges add column if not exists qbo_payment_id text;

create index if not exists idx_charges_unlinked
  on billing.charges (updated_at)
  where qbo_payment_id is null;

update billing.charges c
   set qbo_payment_id = a.qbo_payment_id
  from billing.processing_attempts a
 where a.charge_id = c.charge_id
   and a.qbo_payment_id is not null
   and c.qbo_payment_id is null;
