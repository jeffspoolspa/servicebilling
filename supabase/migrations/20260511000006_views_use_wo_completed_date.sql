-- Switch both v_revenue_by_month and v_work_orders_browser to key on
-- wo.completed (the date the work was actually done in ION) instead of
-- inv.txn_date (when QBO's invoice was created).
--
-- Rationale: operational queries — "what did we do that day", "this
-- week's revenue", date-range filters on the WO browser, the dashboard's
-- monthly revenue chart — are naturally anchored to when the WORK
-- happened, not when the office got around to creating the invoice.
-- A WO completed late April but invoiced early May should belong to
-- April's bucket regardless of admin lag.
--
-- Data impact (sampled at migration time on ~1,594 invoiced billable
-- WOs): 99.7% are same-day, only 1 row across all history crosses a
-- month boundary. So the dashboard's existing monthly buckets shift by
-- at most 1 row.

CREATE OR REPLACE VIEW public.v_revenue_by_month AS
SELECT
  wo.wo_number,
  date_trunc('month', wo.completed::timestamp without time zone)::date AS month,
  wo.completed,
  wo.office_name AS location,
  COALESCE(
    NULLIF(
      TRIM(BOTH FROM (COALESCE(e.first_name, '') || ' ') || COALESCE(e.last_name, '')),
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
  wo.included_in_bonus AS bonus_override,
  COALESCE(wo.included_in_bonus, inv.qbo_class = 'Service') AS included_in_bonus,
  inv.memo        AS invoice_memo
FROM public.work_orders wo
  JOIN billing.invoices inv     ON wo.qbo_invoice_id = inv.qbo_invoice_id
  LEFT JOIN public.employees e  ON wo.employee_id = e.id
  LEFT JOIN public.departments d ON e.department_id = d.id
WHERE wo.billable    = true
  AND wo.completed IS NOT NULL;

CREATE OR REPLACE VIEW public.v_work_orders_browser AS
SELECT
  wo.wo_number,
  date_trunc('month', wo.completed::timestamp without time zone)::date AS month,
  wo.completed,
  wo.office_name AS location,
  COALESCE(
    NULLIF(
      TRIM(BOTH FROM (COALESCE(e.first_name, '') || ' ') || COALESCE(e.last_name, '')),
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
