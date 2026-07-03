-- Autopay roster management from the /maintenance/billing/autopay tab:
-- add a maintenance customer (searchable from customers with recurring tasks
-- not already enrolled), pick which of their ACTIVE payment methods on file
-- the charge hits, change it later, and remove (soft: is_active=false, so
-- history/declines survive re-enrollment). All SECURITY DEFINER — the
-- billing schema is not PostgREST-exposed.

-- maintenance customers not currently on the active roster
create or replace function public.maint_billing_autopay_candidates()
returns table (qbo_customer_id text, display_name text)
language sql stable security definer
set search_path = billing, public
as $$
  select distinct c.qbo_customer_id, c.display_name
  from public."Customers" c
  where c.qbo_customer_id is not null
    and exists (select 1 from maintenance.tasks t
                where t.customer_id = c.id and t.category = 'recurring')
    and not exists (select 1 from billing.autopay_customers ac
                    where ac.qbo_customer_id = c.qbo_customer_id and ac.is_active)
  order by c.display_name;
$$;

-- a customer's ACTIVE payment methods on file (for the PM selector)
create or replace function public.maint_billing_customer_pms(p_qbo_customer_id text)
returns table (id uuid, type text, card_brand text, last_four text, is_default boolean)
language sql stable security definer
set search_path = billing, public
as $$
  select pm.id, pm.type, pm.card_brand, pm.last_four, pm.is_default
  from billing.customer_payment_methods pm
  where pm.qbo_customer_id = p_qbo_customer_id
    and pm.is_active and pm.auto_disabled_at is null and pm.deactivated_at is null
  order by pm.is_default desc, pm.card_brand, pm.last_four;
$$;

-- enroll (or re-enroll) with a chosen payment method
create or replace function public.maint_billing_autopay_add(
  p_qbo_customer_id text,
  p_payment_method_id uuid
)
returns boolean
language plpgsql security definer
set search_path = billing, public
as $$
declare v_pm record; v_name text; v_email text;
begin
  select pm.* into v_pm from billing.customer_payment_methods pm
  where pm.id = p_payment_method_id and pm.qbo_customer_id = p_qbo_customer_id
    and pm.is_active and pm.auto_disabled_at is null and pm.deactivated_at is null;
  if v_pm is null then
    raise exception 'payment method does not belong to this customer or is inactive';
  end if;
  select c.display_name, c.email into v_name, v_email
  from public."Customers" c where c.qbo_customer_id = p_qbo_customer_id;

  if exists (select 1 from billing.autopay_customers where qbo_customer_id = p_qbo_customer_id) then
    update billing.autopay_customers
    set is_active = true,
        payment_method_id = v_pm.id,
        payment_method = case when v_pm.type ilike '%bank%' then 'ach' else 'card' end,
        card_type = v_pm.card_brand, last_four = v_pm.last_four,
        customer_name = coalesce(v_name, customer_name),
        email = coalesce(email, v_email),
        payment_status = 'good', consecutive_declines = 0,
        updated_at = now()
    where qbo_customer_id = p_qbo_customer_id;
  else
    insert into billing.autopay_customers
      (qbo_customer_id, customer_name, email, payment_method, card_type, last_four,
       payment_method_id, payment_status, is_active)
    values
      (p_qbo_customer_id, v_name, v_email,
       case when v_pm.type ilike '%bank%' then 'ach' else 'card' end,
       v_pm.card_brand, v_pm.last_four, v_pm.id, 'good', true);
  end if;
  return true;
end;
$$;

-- change the charged payment method
create or replace function public.maint_billing_autopay_set_pm(
  p_qbo_customer_id text,
  p_payment_method_id uuid
)
returns boolean
language plpgsql security definer
set search_path = billing, public
as $$
declare v_pm record;
begin
  select pm.* into v_pm from billing.customer_payment_methods pm
  where pm.id = p_payment_method_id and pm.qbo_customer_id = p_qbo_customer_id
    and pm.is_active and pm.auto_disabled_at is null and pm.deactivated_at is null;
  if v_pm is null then
    raise exception 'payment method does not belong to this customer or is inactive';
  end if;
  update billing.autopay_customers
  set payment_method_id = v_pm.id,
      payment_method = case when v_pm.type ilike '%bank%' then 'ach' else 'card' end,
      card_type = v_pm.card_brand, last_four = v_pm.last_four,
      updated_at = now()
  where qbo_customer_id = p_qbo_customer_id and is_active;
  return found;
end;
$$;

-- remove (soft — history survives; re-adding reactivates)
create or replace function public.maint_billing_autopay_remove(p_qbo_customer_id text)
returns boolean
language plpgsql security definer
set search_path = billing, public
as $$
begin
  update billing.autopay_customers
  set is_active = false, updated_at = now()
  where qbo_customer_id = p_qbo_customer_id and is_active;
  return found;
end;
$$;

revoke all on function public.maint_billing_autopay_candidates() from public, anon;
revoke all on function public.maint_billing_customer_pms(text) from public, anon;
revoke all on function public.maint_billing_autopay_add(text, uuid) from public, anon;
revoke all on function public.maint_billing_autopay_set_pm(text, uuid) from public, anon;
revoke all on function public.maint_billing_autopay_remove(text) from public, anon;
grant execute on function public.maint_billing_autopay_candidates() to authenticated, service_role;
grant execute on function public.maint_billing_customer_pms(text) to authenticated, service_role;
grant execute on function public.maint_billing_autopay_add(text, uuid) to authenticated, service_role;
grant execute on function public.maint_billing_autopay_set_pm(text, uuid) to authenticated, service_role;
grant execute on function public.maint_billing_autopay_remove(text) to authenticated, service_role;

notify pgrst, 'reload schema';
