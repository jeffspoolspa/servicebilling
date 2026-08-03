-- The billing-month PROGRESSION read model: one row per customer-month with
-- every stage's moment, so the UI renders one table of journeys (filter by
-- derived status, expand for detail with null placeholders for unreached
-- stages) instead of a tab per status. Status derivation mirrors the
-- aggregate's ladder exactly — the view never invents a vocabulary.
CREATE OR REPLACE VIEW billing.v_months_overview AS
SELECT
  bm.id,
  bm.customer_id,
  cu.display_name AS customer_name,
  bm.month,
  CASE
    WHEN bm.sent_at IS NOT NULL THEN 'sent'
    WHEN bm.preprocessed_at IS NOT NULL THEN 'preprocessed'
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
  bm.preprocessed_at,
  bm.linked_payment_method_id,
  bm.sent_at,
  (SELECT jsonb_agg(jsonb_build_object('kind', mi.kind, 'doc_number', mi.doc_number, 'qbo_invoice_id', mi.qbo_invoice_id, 'subtotal_cents', mi.subtotal_cents, 'presentation', mi.presentation) ORDER BY mi.created_at)
     FROM billing.month_invoices mi WHERE mi.billing_month_id = bm.id) AS issued_invoices
FROM billing.billing_months bm
JOIN "Customers" cu ON cu.id = bm.customer_id;

GRANT SELECT ON billing.v_months_overview TO service_role, authenticated;
