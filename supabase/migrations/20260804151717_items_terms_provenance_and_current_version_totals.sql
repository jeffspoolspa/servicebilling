-- RULED: two temporal bindings for two concerns. VISITS tie to a terms
-- version by DATE COVERAGE (the deal that governed the water); BILLABLE
-- ITEMS — the pricing decisions — tie to the version in effect AT CLAIM,
-- which for unbilled work is the CURRENT one (matching ION: a mid-month
-- change reprices everything not yet billed).
ALTER TABLE billing.billable_items ADD COLUMN IF NOT EXISTS task_terms_id uuid;
COMMENT ON COLUMN billing.billable_items.task_terms_id IS
  'Pricing provenance: the task_terms VERSION this item was priced under at claim time. NULL = priced from the task''s inline fields or pre-provenance.';
-- maint_billing_review_visits recreated with the unbilled labor lateral
-- bound to the CURRENT terms version (valid at CURRENT_DATE) instead of
-- the version at the visit date; full definition in the applied MCP
-- migration items_terms_provenance_and_current_version_totals and in the
-- deployed function body (\sf public.maint_billing_review_visits).
