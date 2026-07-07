-- Audit trail for review-workbench discounts. The QBO invoice's DISCOUNT
-- line is the customer-facing record; this table is the queryable ledger:
-- one row per applied adjustment with the reason and when it landed.
-- Written by f/billing/apply_maint_adjustments after a successful QBO write.
CREATE TABLE billing_audit.invoice_adjustments (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  qbo_invoice_id text NOT NULL,
  doc_number     text,
  item_name      text NOT NULL,
  amount_usd     numeric(10,2) NOT NULL,  -- positive dollars off
  reason         text NOT NULL,
  applied_at     timestamptz NOT NULL DEFAULT now(),
  -- same identity the QBO line carries; blocks double-recording on retry
  UNIQUE (qbo_invoice_id, item_name, amount_usd, reason)
);
CREATE INDEX idx_invoice_adjustments_invoice ON billing_audit.invoice_adjustments (qbo_invoice_id);

create or replace function public.maint_billing_invoice_adjustments(p_qbo_invoice_id text)
returns table (item_name text, amount_usd numeric, reason text, applied_at timestamptz)
language sql stable security definer
set search_path = billing_audit, public
as $$
  select a.item_name, a.amount_usd, a.reason, a.applied_at
  from billing_audit.invoice_adjustments a
  where a.qbo_invoice_id = p_qbo_invoice_id
  order by a.applied_at;
$$;

revoke all on function public.maint_billing_invoice_adjustments(text) from public, anon;
grant execute on function public.maint_billing_invoice_adjustments(text) to authenticated, service_role;
