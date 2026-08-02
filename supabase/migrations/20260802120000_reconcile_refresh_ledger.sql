-- The loop-breaker for reconcile-driven visit refreshes. A mismatch triggers
-- at most ONE re-ingest per (task, month, evidence), where evidence is the
-- ION report pull it was judged against (pulled_at). Still mismatched after
-- refreshing against the same evidence -> it stays a mismatch for human
-- review; only a NEW report pull makes it refreshable again.
CREATE TABLE billing_audit.reconcile_refreshes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  month date NOT NULL,
  evidence_pulled_at timestamptz NOT NULL,
  diff_cents_before integer NOT NULL,
  diff_cents_after integer,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (task_id, month, evidence_pulled_at)
);
CREATE INDEX reconcile_refreshes_month ON billing_audit.reconcile_refreshes (month);

GRANT SELECT, INSERT, UPDATE ON billing_audit.reconcile_refreshes TO authenticated;
GRANT ALL ON billing_audit.reconcile_refreshes TO service_role;
ALTER TABLE billing_audit.reconcile_refreshes ENABLE ROW LEVEL SECURITY;
CREATE POLICY reconcile_refreshes_authenticated_all ON billing_audit.reconcile_refreshes
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE billing_audit.reconcile_refreshes IS
  'One visit-refresh attempt per (task, month, ION report pull). The unique key IS the infinite-loop guard.';
