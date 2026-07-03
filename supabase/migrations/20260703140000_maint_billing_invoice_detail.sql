-- Invoice drill-down for the Ready to Process tab: now that periods link to
-- billing.invoices, expose one invoice's header + line items to the app
-- (billing schema is not PostgREST-exposed; SECURITY DEFINER RPC like the
-- other maint_billing_* surfaces).

create or replace function public.maint_billing_invoice_detail(p_qbo_invoice_id text)
returns table (
  qbo_invoice_id text,
  doc_number     text,
  txn_date       date,
  subtotal       numeric,
  total_amt      numeric,
  balance        numeric,
  email_status   text,
  line_items     jsonb
)
language sql stable security definer
set search_path = billing, public
as $$
  select i.qbo_invoice_id, i.doc_number, i.txn_date::date,
         i.subtotal, i.total_amt, i.balance, i.email_status, i.line_items
  from billing.invoices i
  where i.qbo_invoice_id = p_qbo_invoice_id;
$$;

revoke all on function public.maint_billing_invoice_detail(text) from public, anon;
grant execute on function public.maint_billing_invoice_detail(text) to authenticated, service_role;

notify pgrst, 'reload schema';
