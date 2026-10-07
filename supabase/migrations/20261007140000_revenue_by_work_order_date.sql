-- Revenue is a billable, completed work order on its work-order date.
--
-- Two rulings (2026-10-07):
--   1. A billable, completed work order is revenue the day the work is
--      done. It no longer waits for its QBO invoice to be cached; the
--      invoice's amounts still replace the ION amounts once it lands.
--   2. Revenue is dated by the work order's date (ION's "Date", our
--      `scheduled`; it equals ion.work_orders.wo_date on every live row and
--      on every backfilled history row), not by the completion stamp.
-- Bonuses are the exception: they pay on invoices, dated by the invoice
-- (invoice_date = billing.invoices.txn_date), so lib/queries/bonuses.ts
-- ranges on that column.
--
-- Live rows skipped for another reason stay out unless an invoice exists;
-- history rows keep the ION invoice-number rule (estimates and
-- not-invoiced types are not revenue).

CREATE OR REPLACE VIEW public.v_revenue_by_month AS
SELECT wo.wo_number,
    date_trunc('month'::text, wo.scheduled::timestamp without time zone)::date AS month,
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
    inv.memo AS invoice_memo,
    public.fn_revenue_class(inv.qbo_class, wo.assigned_to, wo.type, wo.work_description) AS revenue_class,
    wo.scheduled AS wo_date,
    inv.txn_date AS invoice_date
FROM work_orders wo
  LEFT JOIN billing.invoices inv ON wo.qbo_invoice_id = inv.qbo_invoice_id
  LEFT JOIN employees e ON wo.employee_id = e.id
  LEFT JOIN departments d ON e.department_id = d.id
WHERE wo.billable = true
  AND wo.completed IS NOT NULL
  AND wo.scheduled IS NOT NULL
  AND (inv.qbo_invoice_id IS NOT NULL
       OR wo.skipped_at IS NULL
       OR (wo.skipped_reason = 'pre-pipeline history' AND wo.invoice_number IS NOT NULL));

-- The browser buckets by the same month so a pivot cell drills into the
-- rows that made it.
CREATE OR REPLACE VIEW public.v_work_orders_browser AS
SELECT wo.wo_number,
    date_trunc('month'::text, wo.scheduled::timestamp without time zone)::date AS month,
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
    COALESCE(wo.included_in_bonus, inv.qbo_class = 'Service'::text) AS included_in_bonus,
    public.fn_revenue_class(inv.qbo_class, wo.assigned_to, wo.type, wo.work_description) AS revenue_class,
    wo.scheduled AS wo_date
FROM work_orders wo
  LEFT JOIN billing.invoices inv ON wo.qbo_invoice_id = inv.qbo_invoice_id
  LEFT JOIN employees e ON wo.employee_id = e.id
  LEFT JOIN departments d ON e.department_id = d.id
WHERE wo.billable = true
  AND (wo.skipped_at IS NULL
       OR (wo.skipped_reason = 'pre-pipeline history' AND wo.invoice_number IS NOT NULL));

CREATE OR REPLACE VIEW public.v_service_revenue_daily AS
WITH days AS (
  SELECT d::date AS day
  FROM generate_series(
    DATE '2019-01-01',
    (date_trunc('year', now()) + INTERVAL '1 year - 1 day')::date,
    INTERVAL '1 day') AS d
),
rev AS (
  SELECT wo_date AS day, sum(sub_total) AS revenue, count(*) AS work_orders
  FROM public.v_revenue_by_month
  WHERE revenue_class = 'Service'
  GROUP BY wo_date
)
SELECT days.day,
       extract(year FROM days.day)::int AS year,
       COALESCE(rev.revenue, 0)::numeric AS revenue,
       COALESCE(rev.work_orders, 0)::int AS work_orders,
       sum(COALESCE(rev.revenue, 0)) OVER (PARTITION BY extract(year FROM days.day) ORDER BY days.day)::numeric AS cumulative
FROM days
LEFT JOIN rev ON rev.day = days.day;
