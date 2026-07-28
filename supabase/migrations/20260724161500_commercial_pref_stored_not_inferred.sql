-- Carter 2026-07-24: a commercial account defaults to email because someone
-- STORED that, not because the resolver assumes it. Same outcome, but the
-- fact is now visible on the customer row and a human can override it.
--
-- Order is load-bearing: 28 of the 718 commercial customers have a default
-- card on file. Dropping the branch before the backfill would flip them from
-- "email the invoice" to "charge the card".

-- 1. materialise what the resolver was inferring (718 rows, semantic no-op)
update public."Customers"
   set preferred_payment_type = 'email'
 where account_type = 'commercial'
   and preferred_payment_type is null;

-- 2. keep it true for customers that arrive, or turn commercial, later
create or replace function billing.fn_default_commercial_to_email()
returns trigger language plpgsql as $$
begin
  if new.account_type = 'commercial' and new.preferred_payment_type is null then
    new.preferred_payment_type := 'email';
  end if;
  return new;
end $$;

drop trigger if exists trg_default_commercial_to_email on public."Customers";
create trigger trg_default_commercial_to_email
  before insert or update of account_type, preferred_payment_type
  on public."Customers"
  for each row execute function billing.fn_default_commercial_to_email();

-- 3. the resolver stops assuming. Preference is read, never inferred.
create or replace function billing.resolve_preferred_payment_type(
  p_qbo_customer_id text,
  p_wo_description  text default null
)
returns text
language plpgsql stable
as $function$
declare
  v_customer_pref text;
  v_default_type  text;
begin
  -- per-job override: '*bill*' in the work order means send it, don't charge
  if p_wo_description is not null and p_wo_description ilike '%*bill*%' then
    return 'email';
  end if;

  select preferred_payment_type into v_customer_pref
    from public."Customers" where qbo_customer_id = p_qbo_customer_id;
  if v_customer_pref is not null then return v_customer_pref; end if;

  -- no stored preference: fall back to the type of their default method
  select type into v_default_type
    from billing.customer_payment_methods
   where qbo_customer_id = p_qbo_customer_id
     and is_active = true and is_default = true
   order by (raw->>'created') desc nulls last, fetched_at desc
   limit 1;

  return coalesce(v_default_type, 'email');
end;
$function$;
