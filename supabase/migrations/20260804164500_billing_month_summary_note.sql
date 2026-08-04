-- The month's DEFINABLE SUMMARY — a person's overview of the customer's
-- month, shown on the Summary dashboard and printable into the PDF.
ALTER TABLE billing.billing_months ADD COLUMN IF NOT EXISTS summary_note text;
COMMENT ON COLUMN billing.billing_months.summary_note IS
  'Person-written overview of the customer''s month; rendered on the Summary tab and in the printable month summary.';
