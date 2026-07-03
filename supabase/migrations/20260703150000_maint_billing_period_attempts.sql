-- Processing-attempt history for the billing-period detail page: the
-- customer-month's autopay transactions (maintenance charges sweep per
-- customer, so attempts are customer-month grain). billing schema is not
-- PostgREST-exposed -> definer RPC like the rest of the maint_billing surface.

create or replace function public.maint_billing_period_attempts(
  p_qbo_customer_id text,
  p_month text  -- 'YYYY-MM' (autopay_transactions.billing_month is text)
)
returns table (
  id                   uuid,
  created_at           timestamptz,
  status               text,
  dry_run              boolean,
  payment_method       text,
  card_type            text,
  last_four            text,
  charge_amount        numeric,
  charge_status        text,
  charge_error         text,
  charged_at           timestamptz,
  qbo_payment_id       text,
  qbo_invoice_numbers  text[],
  receipt_emailed      boolean,
  invoice_emailed      boolean,
  emailed_at           timestamptz,
  error_step           text,
  error_message        text,
  verified             boolean
)
language sql stable security definer
set search_path = billing, public
as $$
  select t.id, t.created_at, t.status, t.dry_run,
         t.payment_method, t.card_type, t.last_four,
         t.charge_amount, t.charge_status, t.charge_error, t.charged_at,
         t.qbo_payment_id, t.qbo_invoice_numbers,
         t.receipt_emailed, t.invoice_emailed, t.emailed_at,
         t.error_step, t.error_message, t.verified
  from billing.autopay_transactions t
  where t.qbo_customer_id = p_qbo_customer_id
    and t.billing_month = p_month
  order by t.created_at desc;
$$;

revoke all on function public.maint_billing_period_attempts(text, text) from public, anon;
grant execute on function public.maint_billing_period_attempts(text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
