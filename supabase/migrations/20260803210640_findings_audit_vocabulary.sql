-- The audit joins the findings vocabulary: phase 'audit' (pre-invoice
-- billing checks) and severities 'blocking'/'high' — the two the gate's
-- findings_resolved criterion already holds on. The original constraints
-- predate the audit and only knew the log-correction/bill-review phases.
ALTER TABLE billing.findings DROP CONSTRAINT findings_phase_check;
ALTER TABLE billing.findings ADD CONSTRAINT findings_phase_check
  CHECK (phase = ANY (ARRAY['log_correction','bill_review','audit']));
ALTER TABLE billing.findings DROP CONSTRAINT findings_severity_check;
ALTER TABLE billing.findings ADD CONSTRAINT findings_severity_check
  CHECK (severity = ANY (ARRAY['error','warning','info','blocking','high']));
