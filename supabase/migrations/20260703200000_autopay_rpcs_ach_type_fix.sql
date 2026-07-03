-- customer_payment_methods.type is 'ach' | 'credit_card' — the roster RPCs'
-- legacy-column sync tested ilike '%bank%', so enrolling/switching to an ACH
-- account stamped payment_method='card' (display-only columns; the engine
-- charges by pm.type and was already fixed). Same fix as the engine.

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
        payment_method = case when v_pm.type = 'ach' or v_pm.type ilike '%bank%' then 'ach' else 'card' end,
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
       case when v_pm.type = 'ach' or v_pm.type ilike '%bank%' then 'ach' else 'card' end,
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
      payment_method = case when v_pm.type = 'ach' or v_pm.type ilike '%bank%' then 'ach' else 'card' end,
      card_type = v_pm.card_brand, last_four = v_pm.last_four,
      updated_at = now()
  where qbo_customer_id = p_qbo_customer_id and is_active;
  return found;
end;
$$;


-- repair legacy rows already stamped wrong by the old mapping
update billing.autopay_customers ac
set payment_method = 'ach', updated_at = now()
from billing.customer_payment_methods pm
where pm.id = ac.payment_method_id and pm.type = 'ach'
  and ac.payment_method is distinct from 'ach';

notify pgrst, 'reload schema';
