-- The explainer's steering is a NOTE LOG, not a single field: each
-- generation appends the operator's note (author + timestamp) and the whole
-- chronological log rides along with the letter's current state into the
-- prompt — the person sees their history, the model sees the full context.
ALTER TABLE billing.billing_months
  ADD COLUMN IF NOT EXISTS explainer_notes jsonb NOT NULL DEFAULT '[]'::jsonb;
