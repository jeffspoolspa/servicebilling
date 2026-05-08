-- Append `i.total_amt` to the three queue views
-- (v_billing_queue / v_needs_attention / v_processed) so the dashboard KPIs
-- can sum the relevant invoice totals while ALSO inheriting the views'
-- WO-link filter (work_order JOIN + billable=true + skipped_at IS NULL).
--
-- Why this matters: the previous KPI queries summed billing.invoices
-- directly by billing_status. That over-counted because maintenance autopay
-- invoices live in the same table without a linked WO. Switching dashboard
-- to read from these views guarantees the count + sum scope to the
-- service-billing pipeline only.
--
-- Postgres CREATE OR REPLACE VIEW only allows APPENDING columns, never
-- reordering or renaming. Hence total_amt sits at the end.

CREATE OR REPLACE VIEW billing.v_billing_queue AS
SELECT
  w.wo_number,
  w.customer,
  w.type,
  w.sub_total,
  w.total_due,
  w.completed,
  w.assigned_to,
  w.office_name,
  w.employee_id,
  i.qbo_invoice_id,
  i.doc_number AS invoice_number,
  i.billing_status,
  i.payment_method,
  i.qbo_class,
  i.memo,
  i.statement_memo,
  i.subtotal AS qbo_subtotal,
  i.balance AS qbo_balance,
  i.email_status AS qbo_email_status,
  i.preferred_payment_type,
  i.target_payment_method_id,
  cpm.type        AS target_pm_type,
  cpm.card_brand  AS target_pm_brand,
  cpm.last_four   AS target_pm_last_four,
  i.total_amt
FROM billing.invoices i
  JOIN public.work_orders w ON w.qbo_invoice_id = i.qbo_invoice_id
  LEFT JOIN billing.customer_payment_methods cpm ON cpm.id = i.target_payment_method_id
WHERE i.billing_status = 'ready_to_process'
  AND w.billable     = true
  AND w.skipped_at IS NULL
ORDER BY w.completed DESC NULLS LAST;

CREATE OR REPLACE VIEW billing.v_needs_attention AS
SELECT
  w.wo_number,
  w.customer,
  w.type,
  w.sub_total,
  w.total_due,
  w.completed,
  w.assigned_to,
  w.office_name,
  w.employee_id,
  i.qbo_invoice_id,
  i.doc_number AS invoice_number,
  i.billing_status,
  i.needs_review_reason,
  i.payment_method,
  i.qbo_class,
  i.memo,
  i.statement_memo,
  i.subtotal_ok,
  i.enrichment_ok,
  i.subtotal AS qbo_subtotal,
  i.balance AS qbo_balance,
  i.email_status AS qbo_email_status,
  i.preferred_payment_type,
  i.target_payment_method_id,
  cpm.type        AS target_pm_type,
  cpm.card_brand  AS target_pm_brand,
  cpm.last_four   AS target_pm_last_four,
  i.total_amt
FROM billing.invoices i
  JOIN public.work_orders w ON w.qbo_invoice_id = i.qbo_invoice_id
  LEFT JOIN billing.customer_payment_methods cpm ON cpm.id = i.target_payment_method_id
WHERE i.billing_status = 'needs_review'
  AND w.billable     = true
  AND w.skipped_at IS NULL
ORDER BY w.completed DESC NULLS LAST;

CREATE OR REPLACE VIEW billing.v_processed AS
SELECT
  w.wo_number,
  w.customer,
  w.type,
  w.sub_total,
  w.total_due,
  w.completed,
  w.assigned_to,
  w.office_name,
  w.employee_id,
  i.qbo_invoice_id,
  i.doc_number AS invoice_number,
  i.billing_status,
  i.payment_method,
  i.qbo_class,
  i.processed_at,
  i.subtotal AS qbo_subtotal,
  i.balance  AS qbo_balance,
  i.email_status AS qbo_email_status,
  i.preferred_payment_type,
  i.target_payment_method_id,
  i.total_amt
FROM billing.invoices i
  JOIN public.work_orders w ON w.qbo_invoice_id = i.qbo_invoice_id
WHERE i.billing_status = 'processed'
  AND w.billable     = true
  AND w.skipped_at IS NULL
ORDER BY i.processed_at DESC NULLS LAST;

-- Refresh the public proxies that the anon client reads.
CREATE OR REPLACE VIEW public.v_billing_queue   AS SELECT * FROM billing.v_billing_queue;
CREATE OR REPLACE VIEW public.v_needs_attention AS SELECT * FROM billing.v_needs_attention;
CREATE OR REPLACE VIEW public.v_processed       AS SELECT * FROM billing.v_processed;
