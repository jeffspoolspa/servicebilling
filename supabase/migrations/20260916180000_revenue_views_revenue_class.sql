-- revenue_class on the revenue and browser views.
--
-- The Service dashboard reports SERVICE revenue, not every billable work
-- order. The class comes from the QBO invoice where one is cached; for
-- history rows (2019-2025, no invoice) it is derived by the same mechanical
-- rule the billing pipeline uses (f/billing/_lib/calc.derive_qbo_class):
-- MNT- tech -> Maintenance, DELIVERY type -> Delivery, renovation keywords
-- -> Renovation, else Service. Verified 2026-09-16: on rows with both, the
-- rule agrees with the invoice class.

CREATE OR REPLACE FUNCTION public.fn_revenue_class(invoice_qbo_class text, assigned_to text, wo_type text, work_description text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(invoice_qbo_class,
    CASE
      WHEN upper(coalesce(assigned_to, '')) LIKE 'MNT-%' THEN 'Maintenance'
      WHEN upper(coalesce(wo_type, '')) = 'DELIVERY'
        OR (upper(coalesce(assigned_to, '')) LIKE 'SVC-%'
            AND lower(coalesce(work_description, '')) LIKE '%deliver%'
            AND length(coalesce(work_description, '')) < 80) THEN 'Delivery'
      WHEN lower(coalesce(work_description, '')) ~ '(renovation|replaster|retile)' THEN 'Renovation'
      ELSE 'Service'
    END)
$$;

-- Both views: identical bodies to the previous migrations plus the
-- appended revenue_class column (CREATE OR REPLACE VIEW may only append).
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
    inv.memo AS invoice_memo,
    public.fn_revenue_class(inv.qbo_class, wo.assigned_to, wo.type, wo.work_description) AS revenue_class
FROM work_orders wo
  LEFT JOIN billing.invoices inv ON wo.qbo_invoice_id = inv.qbo_invoice_id
  LEFT JOIN employees e ON wo.employee_id = e.id
  LEFT JOIN departments d ON e.department_id = d.id
WHERE wo.billable = true
  AND wo.completed IS NOT NULL
  AND (inv.qbo_invoice_id IS NOT NULL
       OR (wo.skipped_reason = 'pre-pipeline history' AND wo.invoice_number IS NOT NULL));

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
    COALESCE(wo.included_in_bonus, inv.qbo_class = 'Service'::text) AS included_in_bonus,
    public.fn_revenue_class(inv.qbo_class, wo.assigned_to, wo.type, wo.work_description) AS revenue_class
FROM work_orders wo
  LEFT JOIN billing.invoices inv ON wo.qbo_invoice_id = inv.qbo_invoice_id
  LEFT JOIN employees e ON wo.employee_id = e.id
  LEFT JOIN departments d ON e.department_id = d.id
WHERE wo.billable = true
  AND (wo.skipped_at IS NULL
       OR (wo.skipped_reason = 'pre-pipeline history' AND wo.invoice_number IS NOT NULL));
