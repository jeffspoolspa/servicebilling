-- v_work_orders_browser: admit pre-pipeline history the same way
-- v_revenue_by_month does (20260916160000). The browser excluded every
-- skipped row, which hid the mirror backfill and stopped the month filter
-- at the first scraped month. UI-skipped rows stay hidden.

CREATE OR REPLACE VIEW public.v_work_orders_browser AS
SELECT wo.wo_number,
    date_trunc('month'::text, wo.completed::timestamp without time zone)::date AS month,
    wo.completed,
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
    inv.memo AS invoice_memo,
    wo.included_in_bonus AS bonus_override,
    COALESCE(wo.included_in_bonus, inv.qbo_class = 'Service'::text) AS included_in_bonus
FROM work_orders wo
  LEFT JOIN billing.invoices inv ON wo.qbo_invoice_id = inv.qbo_invoice_id
  LEFT JOIN employees e ON wo.employee_id = e.id
  LEFT JOIN departments d ON e.department_id = d.id
WHERE wo.billable = true
  AND (wo.skipped_at IS NULL
       OR (wo.skipped_reason = 'pre-pipeline history' AND wo.invoice_number IS NOT NULL));
