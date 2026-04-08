-- The "should this have been billed?" alert filters out estimates and warranty.
-- The billable RULE itself doesn't care about type — this filter only applies
-- to the alert views that ask "is something missing?"

CREATE OR REPLACE VIEW billing.v_closed_missing_invoice AS
SELECT w.wo_number, w.customer, w.type, w.total_due, w.completed, w.assigned_to, w.office_name
FROM public.work_orders w
WHERE w.completed IS NOT NULL
  AND w.invoice_number IS NULL
  AND w.total_due > 0
  AND w.type NOT ILIKE '%ESTIMATE%'
  AND w.type != 'WARRANTY'
ORDER BY w.completed DESC;

CREATE OR REPLACE VIEW billing.v_pending_estimates AS
SELECT w.wo_number, w.customer, w.type, w.total_due, w.completed, w.assigned_to, w.office_name
FROM public.work_orders w
WHERE w.completed IS NOT NULL
  AND w.invoice_number IS NULL
  AND w.type ILIKE '%ESTIMATE%'
ORDER BY w.completed DESC;

CREATE OR REPLACE VIEW billing.v_pending_warranty AS
SELECT w.wo_number, w.customer, w.type, w.total_due, w.completed, w.assigned_to, w.office_name
FROM public.work_orders w
WHERE w.completed IS NOT NULL
  AND w.invoice_number IS NULL
  AND w.type = 'WARRANTY'
ORDER BY w.completed DESC;
