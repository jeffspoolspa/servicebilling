-- Append invoice memo to v_revenue_by_month so the work-orders table can
-- show the memo column (and the CSV export endpoint can include it)
-- without a separate fetch per row.
--
-- CREATE OR REPLACE VIEW only allows appending columns at the end, never
-- reordering or renaming, so invoice_memo lands at position 19.

CREATE OR REPLACE VIEW public.v_revenue_by_month AS
SELECT wo.wo_number,
    date_trunc('month'::text, inv.txn_date::timestamp without time zone)::date AS month,
    inv.txn_date AS completed,
    wo.office_name AS location,
    COALESCE(NULLIF(TRIM(BOTH FROM (COALESCE(e.first_name, ''::text) || ' '::text) || COALESCE(e.last_name, ''::text)), ''::text), 'Unassigned'::text) AS tech,
    COALESCE(d.name, 'Unassigned'::text) AS department,
    wo.employee_id,
    wo.customer,
    wo.type AS wo_type,
    COALESCE(inv.subtotal, wo.sub_total, 0::numeric) AS sub_total,
    COALESCE(inv.total_amt, wo.total_due, 0::numeric) AS total_due,
    wo.qbo_invoice_id,
    inv.billing_status,
    inv.balance AS invoice_balance,
    inv.doc_number AS invoice_doc_number,
    inv.qbo_class AS invoice_qbo_class,
    wo.included_in_bonus AS bonus_override,
    COALESCE(wo.included_in_bonus, inv.qbo_class = 'Service'::text) AS included_in_bonus,
    inv.memo AS invoice_memo
FROM work_orders wo
  JOIN billing.invoices inv ON wo.qbo_invoice_id = inv.qbo_invoice_id
  LEFT JOIN employees e ON wo.employee_id = e.id
  LEFT JOIN departments d ON e.department_id = d.id
WHERE wo.billable = true AND inv.txn_date IS NOT NULL;
