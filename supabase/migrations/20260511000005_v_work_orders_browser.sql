-- Browser-specific view: every billable, non-skipped WO, joined LEFT to
-- invoices so WOs without an invoice yet still appear (with NULL invoice_*
-- columns).
--
-- Why this is separate from v_revenue_by_month:
--   - v_revenue_by_month uses INNER JOIN on invoices because the dashboard
--     and bonus pool consumers compute monetary aggregates that only make
--     sense for invoiced WOs.
--   - The /work-orders page is an operational browser; it should show the
--     entire billable backlog including stuff still waiting for office
--     staff to enter the invoice number into ION.
--
-- The "completed" alias is COALESCE(inv.txn_date, wo.completed) so the
-- date column behaves sensibly for both invoiced and uninvoiced rows.
-- Sort and date-range filtering both key off the same column.

CREATE OR REPLACE VIEW public.v_work_orders_browser AS
SELECT
  wo.wo_number,
  date_trunc('month',
    COALESCE(inv.txn_date, wo.completed)::timestamp without time zone
  )::date AS month,
  COALESCE(inv.txn_date, wo.completed) AS completed,
  wo.office_name AS location,
  COALESCE(
    NULLIF(
      TRIM(BOTH FROM
        (COALESCE(e.first_name, '') || ' ') || COALESCE(e.last_name, '')
      ),
      ''
    ),
    'Unassigned'
  ) AS tech,
  COALESCE(d.name, 'Unassigned') AS department,
  wo.employee_id,
  wo.customer,
  wo.type AS wo_type,
  COALESCE(inv.subtotal, wo.sub_total, 0::numeric) AS sub_total,
  COALESCE(inv.total_amt, wo.total_due, 0::numeric) AS total_due,
  wo.qbo_invoice_id,
  inv.billing_status,
  inv.balance     AS invoice_balance,
  inv.doc_number  AS invoice_doc_number,
  inv.qbo_class   AS invoice_qbo_class,
  inv.memo        AS invoice_memo,
  wo.included_in_bonus AS bonus_override,
  COALESCE(wo.included_in_bonus, inv.qbo_class = 'Service') AS included_in_bonus
FROM public.work_orders wo
  LEFT JOIN billing.invoices inv ON wo.qbo_invoice_id = inv.qbo_invoice_id
  LEFT JOIN public.employees e   ON wo.employee_id = e.id
  LEFT JOIN public.departments d ON e.department_id = d.id
WHERE wo.billable    = true
  AND wo.skipped_at IS NULL;
