-- Check findings, persisted per run so the worklists and the flagged-bill
-- view read one table. Two phases with different remedies:
--   log_correction — fix in ION and re-ingest (before invoicing)
--   bill_review    — explain and/or discount (the chems are already in the pool)
CREATE TABLE billing.findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_month_id uuid NOT NULL REFERENCES billing.billing_months(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('log_correction','bill_review')),
  rule text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('error','warning','info')),
  customer_id bigint NOT NULL,
  task_id uuid,
  source_id uuid,
  message text NOT NULL,
  cents integer,
  resolved_at timestamptz,
  resolved_by text,
  resolution text,
  detected_at timestamptz NOT NULL DEFAULT now()
);

-- saveFindings replaces a month's OPEN findings (delete then insert), which is
-- already idempotent; resolved findings are history and may repeat across runs.
CREATE INDEX findings_subject ON billing.findings (billing_month_id, rule, source_id, task_id);
CREATE INDEX findings_open ON billing.findings (phase, severity) WHERE resolved_at IS NULL;
CREATE INDEX findings_month ON billing.findings (billing_month_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON billing.findings TO authenticated;
GRANT ALL ON billing.findings TO service_role;
ALTER TABLE billing.findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY findings_authenticated_all ON billing.findings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE billing.findings IS
  'Output of the billing check suites. log_correction = fix in ION before invoicing; bill_review = explain/discount after logs are trusted.';
