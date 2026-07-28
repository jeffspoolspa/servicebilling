-- enrichment_ok becomes DERIVED like its four sibling indicators (it was the
-- only hand-written one): memo + class present AND memo confident/locked.
-- Scripts stop writing it; a BEFORE trigger maintains it from the source
-- columns. The "QBO PATCH succeeded" fact it used to also carry is dropped by
-- decision (Carter 2026-07-24): a failed class write no longer blocks the
-- charge — it becomes an audit finding, not a gate.
-- Applied 2026-07-24 via MCP apply_migration.

create or replace function billing.set_enrichment_ok() returns trigger
language plpgsql as $$
begin
  new.enrichment_ok := (new.memo is not null
                        and new.qbo_class is not null
                        and coalesce(new.memo_locked, false));
  return new;
end $$;

drop trigger if exists trg_set_enrichment_ok on billing.invoices;
create trigger trg_set_enrichment_ok
  before insert or update of memo, qbo_class, memo_locked
  on billing.invoices
  for each row execute function billing.set_enrichment_ok();

-- The projection watched UPDATE OF enrichment_ok — but a BEFORE-trigger-set
-- column is never in a SET list, so that clause is now dead. Watch the SOURCE
-- columns instead (the WHEN still tests enrichment_ok, now BEFORE-computed).
drop trigger if exists trg_project_billing_status_on_indicator_change on billing.invoices;
create trigger trg_project_billing_status_on_indicator_change
after update of subtotal_ok, credits_ok, payment_method_ok, attempts_ok,
                memo, qbo_class, memo_locked, pre_processed_at
on billing.invoices
for each row
when (
  old.subtotal_ok       is distinct from new.subtotal_ok       or
  old.credits_ok        is distinct from new.credits_ok        or
  old.payment_method_ok is distinct from new.payment_method_ok or
  old.attempts_ok       is distinct from new.attempts_ok       or
  old.enrichment_ok     is distinct from new.enrichment_ok     or
  old.pre_processed_at  is distinct from new.pre_processed_at
)
execute function billing.fn_project_billing_status_on_indicator_change();

-- backfill: correct any current drift + reproject rows that flip (touching
-- memo_locked fires both triggers).
update billing.invoices
   set memo_locked = memo_locked
 where enrichment_ok is distinct from
       (memo is not null and qbo_class is not null and coalesce(memo_locked, false));
