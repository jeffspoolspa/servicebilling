-- The month's ISSUED documents: one row per QBO invoice created for a
-- billing month (service / consumables / green — a month may issue several).
-- doc_number is RULED to be one of the month's ION invoice numbers, and
-- ion_invoice_numbers records the full set that CONSOLIDATED into this
-- document — ION's per-task grain is for reconciliation; this is the map
-- from their numbers to our customer-month.
CREATE TABLE billing.month_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_month_id uuid NOT NULL REFERENCES billing.billing_months(id),
  kind text NOT NULL CHECK (kind IN ('service','consumables','green')),
  qbo_invoice_id text NOT NULL UNIQUE,
  doc_number text NOT NULL,
  subtotal_cents integer NOT NULL,
  presentation text NOT NULL CHECK (presentation IN ('itemized','summary')),
  ion_invoice_numbers text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (billing_month_id, kind)
);
GRANT SELECT, INSERT ON billing.month_invoices TO service_role;
GRANT SELECT ON billing.month_invoices TO authenticated;
