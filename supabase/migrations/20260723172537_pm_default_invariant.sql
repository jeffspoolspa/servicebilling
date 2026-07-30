-- ADR 010 / route-resolution hardening: the default payment method is a
-- TABLE-MAINTAINED INVARIANT, not QBO's flag (Country Inn lesson):
--   default := the newest ACTIVE method per customer.
-- New active card added -> becomes default. Default disabled -> newest
-- remaining active auto-promotes. No active methods -> no default.
-- A real change emits payment_method_default_changed (customer aggregate,
-- actor 'system') and fires the existing route re-resolution cascade
-- (trg_resolve_pm_on_cpm_change listens on UPDATE OF is_default).
-- Applied 2026-07-23 via MCP apply_migration (recorded 20260723172537).

create or replace function billing.fn_maintain_default_pm() returns trigger
language plpgsql as $$
declare
  v_customer text := coalesce(new.qbo_customer_id, old.qbo_customer_id);
  v_old uuid;
  v_new uuid;
begin
  if pg_trigger_depth() > 1 then return null; end if;

  select id into v_old from billing.customer_payment_methods
   where qbo_customer_id = v_customer and is_default limit 1;

  select id into v_new from billing.customer_payment_methods
   where qbo_customer_id = v_customer and is_active = true
   order by (raw->>'created') desc nulls last, fetched_at desc
   limit 1;

  update billing.customer_payment_methods m
     set is_default = (m.id = v_new)
   where m.qbo_customer_id = v_customer
     and m.is_default is distinct from (m.id = v_new);

  if v_new is distinct from v_old then
    insert into billing.events (aggregate, aggregate_id, type, actor, participants, payload)
    values ('customer', v_customer, 'payment_method_default_changed', 'system',
            array_remove(array['pm:' || v_old, 'pm:' || v_new], null),
            jsonb_build_object('from', v_old, 'to', v_new,
              'provenance', jsonb_build_object('source', 'intent',
                'intent_ref', 'fn_maintain_default_pm')));
  end if;
  return null;
end $$;

create trigger trg_maintain_default_pm
  after insert or update of is_active
  on billing.customer_payment_methods
  for each row execute function billing.fn_maintain_default_pm();
