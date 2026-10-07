-- Revenue nets out QBO discount lines.
--
-- billing.invoices.subtotal is QBO's SubTotal line, which sits ABOVE any
-- DiscountLineDetail; the pipeline's subtotal_matches gate needs it that
-- way (it compares to the ION work order). Revenue does not: a discount
-- added in QBO is money not earned. Ruling 2026-10-07 (Gardner WO 5053053,
-- $161.99 invoice discounted $28.88 to match a $135 prepaid diagnosis).
-- Both views now take subtotal minus the invoice's discount lines, read
-- from the cached payload; history rows have no invoice and are unchanged.

CREATE OR REPLACE FUNCTION public.fn_invoice_discount(lines jsonb)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(sum((l->>'Amount')::numeric), 0)
  FROM jsonb_array_elements(COALESCE(lines, '[]'::jsonb)) l
  WHERE l->>'DetailType' = 'DiscountLineDetail'
$$;

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
    COALESCE(inv.subtotal - public.fn_invoice_discount(inv.raw->'Line'), wo.sub_total, 0::numeric) AS sub_total,
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
    COALESCE(inv.subtotal - public.fn_invoice_discount(inv.raw->'Line'), wo.sub_total, 0::numeric) AS sub_total,
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
