-- The explainer's persistence: a STABLE storage path per month (the same
-- link survives regeneration) + the month's stamps. Attach is an INTENT the
-- send path reads later — recording it never touches QBO.
INSERT INTO storage.buckets (id, name, public)
VALUES ('explainers', 'explainers', true)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE billing.billing_months
  ADD COLUMN IF NOT EXISTS explainer_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS explainer_narrative jsonb,
  ADD COLUMN IF NOT EXISTS explainer_attach_requested_at timestamptz;
