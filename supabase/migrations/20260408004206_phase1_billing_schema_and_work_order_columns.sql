-- Phase 1: Service billing foundation
-- - billing schema + core tables
-- - work_orders columns for the workflow state machine
-- - employees ION + auth wiring
-- - app_roles
-- - views
-- - RLS

CREATE SCHEMA IF NOT EXISTS billing;

-- Work orders state columns
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'not_billable',
  ADD COLUMN IF NOT EXISTS billing_status_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS service_category text,
  ADD COLUMN IF NOT EXISTS qbo_class text,
  ADD COLUMN IF NOT EXISTS qbo_department text,
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS needs_review_reason text,
  ADD COLUMN IF NOT EXISTS last_classified_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

ALTER TABLE public.work_orders
  ADD CONSTRAINT work_orders_billing_status_check
    CHECK (billing_status IN (
      'not_billable', 'needs_classification', 'ready_to_process',
      'processing', 'processed', 'needs_review', 'skipped', 'on_hold'
    ));

ALTER TABLE public.work_orders
  ADD CONSTRAINT work_orders_payment_method_check
    CHECK (payment_method IS NULL OR payment_method IN ('on_file', 'invoice'));

CREATE INDEX IF NOT EXISTS idx_work_orders_billing_status
  ON public.work_orders(billing_status)
  WHERE billing_status != 'not_billable';

CREATE INDEX IF NOT EXISTS idx_work_orders_invoice_number
  ON public.work_orders(invoice_number)
  WHERE invoice_number IS NOT NULL;

-- billing.invoices (narrow QBO cache)
CREATE TABLE IF NOT EXISTS billing.invoices (
  qbo_invoice_id text PRIMARY KEY,
  doc_number text NOT NULL UNIQUE,
  qbo_customer_id text,
  customer_name text,
  txn_date date,
  due_date date,
  total_amt numeric,
  subtotal numeric,
  balance numeric,
  email_status text,
  raw jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_customer ON billing.invoices(qbo_customer_id);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_balance ON billing.invoices(balance) WHERE balance > 0;

-- billing.customer_payment_methods
CREATE TABLE IF NOT EXISTS billing.customer_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qbo_customer_id text NOT NULL,
  qbo_payment_method_id text,
  type text NOT NULL CHECK (type IN ('card', 'ach')),
  card_brand text,
  last_four text,
  is_default boolean DEFAULT false,
  is_active boolean DEFAULT true,
  raw jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(qbo_customer_id, qbo_payment_method_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_payment_methods_customer
  ON billing.customer_payment_methods(qbo_customer_id) WHERE is_active;

-- billing.processing_attempts
CREATE TABLE IF NOT EXISTS billing.processing_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_number text NOT NULL REFERENCES public.work_orders(wo_number),
  invoice_number text,
  qbo_invoice_id text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  attempted_by uuid,
  status text NOT NULL CHECK (status IN ('success', 'failed', 'partial', 'skipped')),
  payment_method text,
  charge_amount numeric,
  charge_result jsonb,
  credits_applied jsonb,
  email_sent boolean DEFAULT false,
  error_message text,
  raw_result jsonb
);
CREATE INDEX IF NOT EXISTS idx_processing_attempts_wo
  ON billing.processing_attempts(wo_number, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_processing_attempts_status
  ON billing.processing_attempts(status, attempted_at DESC);

-- Employees ION + auth wiring
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS ion_username text[],
  ADD COLUMN IF NOT EXISTS auth_user_id uuid REFERENCES auth.users(id);
CREATE INDEX IF NOT EXISTS idx_employees_auth_user ON public.employees(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_employees_ion_username ON public.employees USING gin(ion_username);

-- app_roles
CREATE TABLE IF NOT EXISTS public.app_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL REFERENCES auth.users(id),
  app text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'reviewer', 'viewer')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid,
  UNIQUE(auth_user_id, app, role)
);
CREATE INDEX IF NOT EXISTS idx_app_roles_user ON public.app_roles(auth_user_id);

-- Views (initial — may be replaced by later phase1_* migrations)
CREATE OR REPLACE VIEW billing.v_billable_work_orders AS
SELECT * FROM public.work_orders
WHERE completed IS NOT NULL
  AND invoice_number IS NOT NULL
  AND type NOT ILIKE '%ESTIMATE%'
  AND type != 'WARRANTY';

CREATE OR REPLACE VIEW billing.v_billing_queue AS
SELECT w.*, i.balance AS qbo_balance, i.email_status AS qbo_email_status, i.total_amt AS qbo_total
FROM public.work_orders w
LEFT JOIN billing.invoices i ON i.doc_number = w.invoice_number
WHERE w.billing_status = 'ready_to_process';

CREATE OR REPLACE VIEW billing.v_needs_attention AS
SELECT * FROM public.work_orders WHERE billing_status = 'needs_review';

CREATE OR REPLACE VIEW billing.v_closed_missing_invoice AS
SELECT w.wo_number, w.customer, w.type, w.total_due, w.completed, w.assigned_to, w.office_name
FROM public.work_orders w
WHERE w.completed IS NOT NULL
  AND w.invoice_number IS NULL
  AND w.total_due > 0
  AND w.type NOT ILIKE '%ESTIMATE%'
  AND w.type != 'WARRANTY'
ORDER BY w.completed DESC;

CREATE OR REPLACE VIEW billing.v_unmapped_technicians AS
SELECT w.assigned_to, count(*) AS wo_count, max(w.completed) AS last_seen
FROM public.work_orders w
LEFT JOIN public.employees e ON w.assigned_to = ANY(e.ion_username)
WHERE w.assigned_to IS NOT NULL AND e.id IS NULL
  AND w.completed >= now() - interval '90 days'
GROUP BY w.assigned_to HAVING count(*) >= 3
ORDER BY wo_count DESC;

CREATE OR REPLACE VIEW billing.v_revenue_by_employee AS
SELECT e.id AS employee_id, (e.first_name || ' ' || e.last_name) AS display_name, e.status,
       date_trunc('month', w.completed) AS month,
       count(*) FILTER (WHERE w.invoice_number IS NOT NULL) AS billable_jobs,
       count(*) FILTER (WHERE w.billing_status = 'not_billable') AS not_billable_jobs,
       sum(w.total_due) FILTER (WHERE w.billing_status = 'processed') AS revenue_processed,
       avg(w.total_due) FILTER (WHERE w.invoice_number IS NOT NULL) AS avg_ticket
FROM public.employees e
LEFT JOIN public.work_orders w ON w.assigned_to = ANY(e.ion_username)
WHERE w.completed IS NOT NULL
GROUP BY e.id, e.first_name, e.last_name, e.status, date_trunc('month', w.completed);

-- RLS
ALTER TABLE billing.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.customer_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.processing_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service-billing read" ON billing.invoices FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'service-billing'));
CREATE POLICY "service-billing read" ON billing.customer_payment_methods FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'service-billing'));
CREATE POLICY "service-billing read" ON billing.processing_attempts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'service-billing'));
CREATE POLICY "service-billing admin write" ON billing.invoices FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'service-billing' AND role = 'admin'));
CREATE POLICY "service-billing admin write" ON billing.customer_payment_methods FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'service-billing' AND role = 'admin'));
CREATE POLICY "service-billing admin write" ON billing.processing_attempts FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.app_roles WHERE auth_user_id = auth.uid() AND app = 'service-billing' AND role = 'admin'));
CREATE POLICY "users see own roles" ON public.app_roles FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

-- Initial classification of existing data
UPDATE public.work_orders
SET billing_status = 'needs_classification', billing_status_set_at = now()
WHERE completed IS NOT NULL
  AND invoice_number IS NOT NULL
  AND type NOT ILIKE '%ESTIMATE%'
  AND type != 'WARRANTY'
  AND billing_status = 'not_billable';

UPDATE public.work_orders
SET billing_status = 'needs_review',
    needs_review_reason = 'Has invoice but type is excluded (' || type || ')',
    billing_status_set_at = now()
WHERE completed IS NOT NULL
  AND invoice_number IS NOT NULL
  AND (type ILIKE '%ESTIMATE%' OR type = 'WARRANTY')
  AND billing_status = 'not_billable';
