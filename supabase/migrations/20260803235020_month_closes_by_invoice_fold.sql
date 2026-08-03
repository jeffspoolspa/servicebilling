-- RULED: the billing month's own lifecycle ENDS at invoice creation. Each
-- invoice then runs its own machine (enrich folded into creation -> credit
-- check -> charge -> send), kind-scoped by what it is linked to; the month
-- is CLOSED when every linked invoice is sent AND paid — a FOLD derived
-- here, never a command. The preprocess/sent month moments were the wrong
-- grain and are dropped (sent_at kept as a dead column until nothing
-- references it).
DROP VIEW billing.v_months_overview;
ALTER TABLE billing.billing_months DROP COLUMN IF EXISTS preprocessed_at;
ALTER TABLE billing.billing_months DROP COLUMN IF EXISTS linked_payment_method_id;

CREATE VIEW billing.v_months_overview AS
SELECT
  bm.id,
  bm.customer_id,
  cu.display_name AS customer_name,
  bm.month,
  CASE
    WHEN bm.invoiced_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM billing.month_invoices mi WHERE mi.billing_month_id = bm.id)
     AND NOT EXISTS (
       SELECT 1 FROM billing.month_invoices mi
       LEFT JOIN billing.invoices i ON i.qbo_invoice_id = mi.qbo_invoice_id
       WHERE mi.billing_month_id = bm.id
         AND (i.qbo_invoice_id IS NULL OR i.email_status IS DISTINCT FROM 'EmailSent' OR COALESCE(i.balance, 1) > 0)
     )
    THEN 'closed'
    WHEN bm.invoiced_at IS NOT NULL THEN 'invoiced'
    WHEN jsonb_array_length(COALESCE(bm.gate_held_for, '[]'::jsonb)) > 0 THEN 'held'
    WHEN bm.gated_at IS NOT NULL THEN 'gated'
    WHEN bm.disputed_at IS NOT NULL THEN 'disputed'
    WHEN bm.reconciled_at IS NOT NULL THEN 'reconciled'
    ELSE 'accruing'
  END AS status,
  (SELECT COALESCE(sum(bi.amount_cents), 0) FROM billing.billable_items bi WHERE bi.billing_month_id = bm.id) AS subtotal_cents,
  (SELECT count(*) FROM billing.billable_items bi WHERE bi.billing_month_id = bm.id) AS item_count,
  (SELECT count(*) FROM billing.findings f WHERE f.billing_month_id = bm.id AND f.phase = 'audit' AND f.resolved_at IS NULL) AS open_findings,
  bm.reconciled_at,
  bm.disputed_at,
  bm.disputes,
  bm.gated_at,
  bm.gate_held_for,
  bm.invoiced_at,
  (SELECT jsonb_agg(jsonb_build_object(
      'kind', mi.kind, 'doc_number', mi.doc_number, 'qbo_invoice_id', mi.qbo_invoice_id,
      'subtotal_cents', mi.subtotal_cents, 'presentation', mi.presentation,
      'email_status', i.email_status, 'balance', i.balance, 'total_amt', i.total_amt) ORDER BY mi.created_at)
     FROM billing.month_invoices mi
     LEFT JOIN billing.invoices i ON i.qbo_invoice_id = mi.qbo_invoice_id
     WHERE mi.billing_month_id = bm.id) AS issued_invoices
FROM billing.billing_months bm
JOIN "Customers" cu ON cu.id = bm.customer_id;

GRANT SELECT ON billing.v_months_overview TO service_role, authenticated;
