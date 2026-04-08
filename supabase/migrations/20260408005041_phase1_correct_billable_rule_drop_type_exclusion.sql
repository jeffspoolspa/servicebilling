-- Correction: billable rule is purely "has invoice_number"
-- Drops the ESTIMATE/WARRANTY type exclusion. Reclassifies the 22 rows that
-- were marked needs_review back into needs_classification.

UPDATE public.work_orders
SET billing_status = 'needs_classification',
    needs_review_reason = NULL,
    billing_status_set_at = now()
WHERE completed IS NOT NULL
  AND invoice_number IS NOT NULL
  AND (type ILIKE '%ESTIMATE%' OR type = 'WARRANTY')
  AND billing_status = 'needs_review'
  AND needs_review_reason LIKE 'Has invoice but type is excluded%';

CREATE OR REPLACE VIEW billing.v_billable_work_orders AS
SELECT * FROM public.work_orders
WHERE invoice_number IS NOT NULL;

CREATE OR REPLACE VIEW billing.v_closed_missing_invoice AS
SELECT w.wo_number, w.customer, w.type, w.total_due, w.completed, w.assigned_to, w.office_name
FROM public.work_orders w
WHERE w.completed IS NOT NULL
  AND w.invoice_number IS NULL
  AND w.total_due > 0
ORDER BY w.completed DESC;
