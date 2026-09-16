-- v_revenue_by_month: show pre-pipeline history without a cached QBO invoice.
--
-- Historical work orders (2019-2025) are backfilled from the .NET `ion`
-- mirror by f/ION/backfill_work_orders_from_mirror, stamped
-- skipped_reason = 'pre-pipeline history'. Most of their QBO invoices are
-- not in any cache, so the old INNER JOIN hid them from the revenue
-- dashboard entirely. The view now LEFT JOINs billing.invoices and admits a
-- work order when it has a linked invoice OR is pre-pipeline history; the
-- sub_total/total_due COALESCE already falls back to the WO's ION amounts.
--
-- Current-pipeline rows keep today's rule: no invoice, no revenue.
-- ponytail: the history marker is a skipped_reason constant (also in the
-- backfill script). Upgrade path if a second provenance ever appears: a
-- work_orders.provenance column.

CREATE OR REPLACE VIEW public.v_revenue_by_month AS
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
    wo.included_in_bonus AS bonus_override,
    COALESCE(wo.included_in_bonus, inv.qbo_class = 'Service'::text) AS included_in_bonus,
    inv.memo AS invoice_memo
FROM work_orders wo
  LEFT JOIN billing.invoices inv ON wo.qbo_invoice_id = inv.qbo_invoice_id
  LEFT JOIN employees e ON wo.employee_id = e.id
  LEFT JOIN departments d ON e.department_id = d.id
WHERE wo.billable = true
  AND wo.completed IS NOT NULL
  AND (inv.qbo_invoice_id IS NOT NULL OR wo.skipped_reason = 'pre-pipeline history');
