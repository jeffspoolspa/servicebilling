-- The customer-facing letter that accompanies a flagged month's invoice.
-- Drafted by f/billing/draft_customer_letter (Claude), iterated by the
-- reviewer in the workbench, printed to PDF at send time. Latest draft only —
-- iteration happens in the request thread, not in rows.
CREATE TABLE billing.customer_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id bigint NOT NULL,
  billing_month date NOT NULL,
  letter text NOT NULL,
  reviewer_context text,
  model text,
  usage jsonb,
  approved_at timestamptz,
  approved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, billing_month)
);

GRANT SELECT, INSERT, UPDATE ON billing.customer_letters TO authenticated;
GRANT ALL ON billing.customer_letters TO service_role;
ALTER TABLE billing.customer_letters ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_letters_authenticated_all ON billing.customer_letters
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE billing.customer_letters IS
  'AI-drafted, human-approved letter explaining a flagged month. Accompanies the invoice as a PDF. approved_at NULL = still a draft.';
