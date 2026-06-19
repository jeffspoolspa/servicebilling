-- Standardize customer edits onto ONE row-locking function, and remove the
-- PostgREST overload ambiguity on update_account_contact.
--
-- Module: docs/flows/lead-intake-to-conversion (proposer)
-- Shared type affected: docs/shared/customer.md (public."Customers")
--
-- BACKGROUND
-- public.update_account_contact had two overloads (…,text,text,text,text) and
-- (…,text,text,text,text,text,text) — both with all-default args — so a 5-arg
-- call ("Could not choose the best candidate function") was ambiguous and failed.
-- The app also edited the customer in TWO writes (contact RPC + a direct address
-- UPDATE), which isn't atomic. This adds public.update_customer: name + contact +
-- address in one SECURITY DEFINER call that locks the row FOR UPDATE so concurrent
-- edits serialize (no lost updates). It also drops the redundant 5-arg overload so
-- remaining update_account_contact callers (intake, the website) resolve cleanly.

-- 1. The standard customer-edit function. Locks the row, recomputes display_name
--    the same way maintenance.update_account_contact did, COALESCEs each field so
--    only provided values change.
create or replace function public.update_customer(
  p_account_id bigint,
  p_first_name text default null,
  p_last_name  text default null,
  p_email      text default null,
  p_phone      text default null,
  p_street     text default null,
  p_city       text default null,
  p_state      text default null,
  p_zip        text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_type    text;
  v_first   text;
  v_last    text;
  v_display text;
begin
  -- Serialize concurrent edits to this customer: the row lock makes a second
  -- editor wait for this transaction, so neither silently overwrites the other.
  select account_type, first_name, last_name
    into v_type, v_first, v_last
    from public."Customers"
   where id = p_account_id
   for update;
  if not found then
    raise exception 'update_customer: customer % not found', p_account_id;
  end if;

  v_first := coalesce(p_first_name, v_first);
  v_last  := coalesce(p_last_name,  v_last);
  v_display := case when v_type = 'commercial' then v_last else v_last || ', ' || v_first end;

  update public."Customers" set
    first_name   = v_first,
    last_name    = v_last,
    display_name = v_display,
    email = coalesce(p_email, email),
    phone = coalesce(p_phone, phone),
    street = coalesce(p_street, street),
    city   = coalesce(p_city,  city),
    state  = coalesce(p_state, state),
    zip    = coalesce(p_zip,   zip)
  where id = p_account_id;

  return jsonb_build_object(
    'account_id', p_account_id,
    'qbo_customer_id', (select qbo_customer_id from public."Customers" where id = p_account_id)
  );
end;
$$;

revoke execute on function
  public.update_customer(bigint, text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function
  public.update_customer(bigint, text, text, text, text, text, text, text, text)
  to service_role;

-- 2. Kill the overload ambiguity: drop the redundant 5-arg wrapper. A 5-arg call
--    now resolves unambiguously to the remaining 7-arg overload (extra args
--    default null), so intake + website keep working.
drop function if exists public.update_account_contact(bigint, text, text, text, text);
