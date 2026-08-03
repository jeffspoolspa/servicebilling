-- Chem provision is a TASK attribute, not something inferred per run.
-- customer_provides_chems already lives on the task; bulk_refill joins it:
-- tasks whose service includes bulk-container deliveries (buckets of tabs at
-- commercial properties). The audit puts both in their own peer groups with
-- their own rules — a bucket on a bulk_refill task is a delivery, a bucket
-- anywhere else is a mis-key, and ANY chem billing on a provides-chems task
-- is a finding.
ALTER TABLE maintenance.tasks ADD COLUMN bulk_refill boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN maintenance.tasks.bulk_refill IS
  'This task''s service includes bulk-container chemical deliveries (50lb buckets etc). Audit peer group bulk_refill: bulk items expected, not mis-bills. Set by review; backfilled from billed history.';

-- Backfill: commercial tasks that have actually billed bulk containers.
-- Residential tasks with bulk items are NOT backfilled — those are the
-- mis-bills the audit exists to catch.
UPDATE maintenance.tasks t SET bulk_refill = true
WHERE EXISTS (
  SELECT 1 FROM billing.billable_items bi
  JOIN maintenance.consumables c ON c.item_name = bi.item_name AND c.is_bulk
  JOIN billing.billing_months bm ON bm.id = bi.billing_month_id
  JOIN "Customers" cu ON cu.id = bm.customer_id
  WHERE bi.task_id::uuid = t.id AND bi.kind = 'consumable'
    AND NULLIF(TRIM(COALESCE(cu.company, '')), '') IS NOT NULL
);

-- The findings READ MODEL: one row per finding with everything the review
-- screen needs — who, which month, what the month is currently held for.
CREATE OR REPLACE VIEW billing.v_findings_review AS
SELECT
  f.id,
  f.billing_month_id,
  bm.month,
  f.customer_id,
  cu.display_name AS customer_name,
  f.phase,
  f.rule,
  f.severity,
  f.message,
  f.cents,
  f.detected_at,
  f.resolved_at,
  f.resolved_by,
  f.resolution,
  bm.gate_held_for,
  (bm.invoiced_at IS NOT NULL) AS month_invoiced
FROM billing.findings f
JOIN billing.billing_months bm ON bm.id = f.billing_month_id
JOIN "Customers" cu ON cu.id = f.customer_id;

GRANT SELECT ON billing.v_findings_review TO service_role;
-- The review page reads the view with the user's own session (the view is
-- definer-owned, so the grant alone suffices); resolution writes go through
-- the authenticated API route with the service client.
GRANT SELECT ON billing.v_findings_review TO authenticated;
