-- office_name on work_orders already carries the branch/department dimension.
-- Drop the parallel qbo_department column. Views that SELECT * need to be
-- recreated after the drop.

DROP VIEW IF EXISTS billing.v_billable_work_orders;
DROP VIEW IF EXISTS billing.v_billing_queue;
DROP VIEW IF EXISTS billing.v_needs_attention;

ALTER TABLE public.work_orders DROP COLUMN IF EXISTS qbo_department;

CREATE OR REPLACE VIEW billing.v_billable_work_orders AS
SELECT * FROM public.work_orders WHERE invoice_number IS NOT NULL;

CREATE OR REPLACE VIEW billing.v_billing_queue AS
SELECT w.*, i.balance AS qbo_balance, i.email_status AS qbo_email_status, i.total_amt AS qbo_total
FROM public.work_orders w
LEFT JOIN billing.invoices i ON i.doc_number = w.invoice_number
WHERE w.billing_status = 'ready_to_process';

CREATE OR REPLACE VIEW billing.v_needs_attention AS
SELECT * FROM public.work_orders WHERE billing_status = 'needs_review';
