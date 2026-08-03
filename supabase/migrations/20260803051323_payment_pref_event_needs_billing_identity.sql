-- fn_log_payment_preference_change fired on EVERY Customers insert and keyed
-- the event on new.qbo_customer_id — which is always NULL at creation time
-- (Pattern D stamps the QBO id after create). billing.events.aggregate_id is
-- NOT NULL, so every new-account insert since the emit wiring landed
-- (20260723122616) failed outright. Rule: no billing identity yet -> nothing
-- to log yet. The preference-change emits resume once the id exists.
create or replace function billing.fn_log_payment_preference_change()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.qbo_customer_id is null then
    return null; -- no aggregate to attribute the event to yet
  end if;
  if new.preferred_payment_type is distinct from old.preferred_payment_type
     or tg_op = 'INSERT' then
    insert into billing.events (aggregate, aggregate_id, type, actor, participants, payload)
    values ('customer', new.qbo_customer_id, 'payment_preference_changed',
            coalesce(current_setting('billing.actor', true), 'system'),
            array[]::text[],
            jsonb_build_object(
              'from', case when tg_op = 'INSERT' then null else old.preferred_payment_type end,
              'to', new.preferred_payment_type,
              'account_type', new.account_type,
              'provenance', jsonb_build_object('source','intent',
                'intent_ref', coalesce(current_setting('billing.intent_ref', true),
                                       'fn_log_payment_preference_change'))));
  end if;
  return null;
end $$;
