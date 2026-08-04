-- The invoice-detail read surface: the modal's three facts. Payments come
-- from the PAYMENT mirror's linked lines (QBO's own linkage), history from
-- the event stream where the invoice is the aggregate.
CREATE OR REPLACE FUNCTION public.maint_billing_invoice_payments(p_qbo_invoice_id text)
RETURNS TABLE(qbo_payment_id text, txn_date date, applied_amount numeric, total_amt numeric, memo text, payment_method_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'billing', 'public'
AS $$
  SELECT p.qbo_payment_id, p.txn_date::date,
         (l->>'Amount')::numeric, p.total_amt, p.memo, p.payment_method_name
  FROM billing.customer_payments p, jsonb_array_elements(p.raw->'Line') l
  WHERE l->'LinkedTxn' @> jsonb_build_array(jsonb_build_object('TxnId', p_qbo_invoice_id, 'TxnType', 'Invoice'))
  ORDER BY p.txn_date DESC, p.qbo_payment_id DESC;
$$;

CREATE OR REPLACE FUNCTION public.maint_billing_invoice_history(p_qbo_invoice_id text)
RETURNS TABLE(seq bigint, occurred_at timestamptz, aggregate text, aggregate_id text, type text, actor text, payload jsonb)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'maintenance', 'public'
AS $$
  SELECT e.seq, e.occurred_at, e.aggregate, e.aggregate_id, e.type, e.actor, e.payload
  FROM maintenance.events e
  WHERE e.aggregate = 'invoice' AND e.aggregate_id = p_qbo_invoice_id
  ORDER BY e.occurred_at DESC, e.seq DESC;
$$;

GRANT EXECUTE ON FUNCTION public.maint_billing_invoice_payments(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.maint_billing_invoice_history(text) TO authenticated;
