-- The billing aggregate at rest (docs/model/billing.html). billing_months is
-- the customer-month root; billable_items is its claim ledger — billing's
-- translation of delivery facts, one row per billed thing. Items are DERIVED
-- by set-based accrual (idempotent, domain-owned); invoices are NEVER stored
-- as drafts — the only invoice table remains billing.invoices (QBO mirror),
-- and grouping lands on items as qbo_invoice_id/qbo_line_id at issue.
CREATE TABLE billing.billing_months (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id bigint NOT NULL,
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  flag text,
  processing_status text,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, month)
);

CREATE TABLE billing.billable_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_month_id uuid NOT NULL REFERENCES billing.billing_months(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('visit','usage','flat')),
  -- visit/usage id; NULL only for the flat monthly charge
  source_id uuid,
  task_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('labor','consumable')),
  service_date date,
  item_name text,
  qty numeric NOT NULL,
  unit_price_cents integer,          -- NULL = unpriced worklist row
  amount_cents integer,
  qbo_invoice_id text,               -- stamped at issue
  qbo_line_id text,                  -- stamped at issue
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_kind = 'flat' OR source_id IS NOT NULL)
);

-- I-B1: a delivery fact is claimed at most once, ever (cross-month backstop;
-- the aggregate enforces it within a month).
CREATE UNIQUE INDEX billable_items_source_uniq ON billing.billable_items (source_id)
  WHERE source_id IS NOT NULL;
-- One flat charge per task per month.
CREATE UNIQUE INDEX billable_items_flat_uniq ON billing.billable_items (billing_month_id, task_id)
  WHERE source_kind = 'flat';
CREATE INDEX billable_items_month_idx ON billing.billable_items (billing_month_id);
CREATE INDEX billable_items_task_idx ON billing.billable_items (task_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON billing.billing_months, billing.billable_items TO authenticated;
GRANT ALL ON billing.billing_months, billing.billable_items TO service_role;
ALTER TABLE billing.billing_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.billable_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_months_authenticated_all ON billing.billing_months
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY billable_items_authenticated_all ON billing.billable_items
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
