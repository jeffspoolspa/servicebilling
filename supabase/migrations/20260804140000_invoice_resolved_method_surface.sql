-- The invoice's RESOLVED payment method: the instrument its charge actually
-- used when one exists (the truth of what happened), else the roster's
-- current default (what collect would use). Email-route invoices resolve
-- to nothing.
CREATE OR REPLACE FUNCTION public.maint_billing_invoice_method(p_qbo_invoice_id text)
RETURNS TABLE(method_type text, card_brand text, last_four text, source text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'billing', 'public'
AS $$
  WITH charged AS (
    SELECT cpm.type, cpm.card_brand, cpm.last_four
    FROM billing.charges ch
    JOIN billing.customer_payment_methods cpm ON cpm.id::text = ch.customer_payment_method_id::text
    WHERE ch.qbo_invoice_id = p_qbo_invoice_id AND ch.customer_payment_method_id IS NOT NULL
    ORDER BY ch.attempted_at DESC LIMIT 1
  ),
  roster AS (
    SELECT cpm.type, cpm.card_brand, cpm.last_four
    FROM billing.invoices i
    JOIN billing.autopay_customers ac ON ac.qbo_customer_id = i.qbo_customer_id AND ac.is_active
    JOIN billing.customer_payment_methods cpm ON cpm.qbo_customer_id = i.qbo_customer_id AND cpm.is_active
    WHERE i.qbo_invoice_id = p_qbo_invoice_id
    ORDER BY cpm.is_default DESC LIMIT 1
  )
  SELECT type, card_brand, last_four, 'charge' FROM charged
  UNION ALL
  SELECT type, card_brand, last_four, 'roster' FROM roster WHERE NOT EXISTS (SELECT 1 FROM charged)
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.maint_billing_invoice_method(text) TO authenticated;
