-- Warranty work with $0 total isn't an alert — that's normal warranty service.
-- The pending_warranty view should only flag warranty WOs with money attached
-- (parts billed, oddities, etc.).

CREATE OR REPLACE VIEW billing.v_pending_warranty AS
SELECT wo_number, customer, type, total_due, completed, assigned_to, office_name
FROM public.work_orders
WHERE completed IS NOT NULL
  AND invoice_number IS NULL
  AND type = 'WARRANTY'
  AND total_due > 0
ORDER BY completed DESC;
