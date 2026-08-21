-- maintenance.pool_configs — per-customer dosing defaults (volume + chlorination)
--
-- Module: docs/modules/maintenance/operations.md (tech app / dosing)
-- Entity doc: docs/entities/pool-config.md
--
-- BACKGROUND
-- The dosing tool asks for pool volume and chlorination type on every sample.
-- When a customer is selected, techs can save that pair once; the next sample
-- for that customer loads it automatically. One row per customer, upserted.
-- Deliberately minimal (ruled 2026-08-21) — extend later as needs appear.
-- NOTE: public.pools (location-keyed physical pool inventory) already exists;
-- this table is the customer-keyed DOSING config, not pool inventory.

CREATE TABLE maintenance.pool_configs (
  customer_id     bigint PRIMARY KEY REFERENCES public."Customers"(id) ON DELETE CASCADE,
  volume_gallons  integer NOT NULL CHECK (volume_gallons >= 1500),
  -- Closed vocab, house pattern: text + CHECK (matches the dosing API enum).
  sanitiser       text NOT NULL CHECK (sanitiser IN ('tab', 'liquid', 'salt')),
  last_set_by     uuid NOT NULL REFERENCES public.employees(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER pool_configs_updated_at
  BEFORE UPDATE ON maintenance.pool_configs
  FOR EACH ROW EXECUTE FUNCTION maintenance.set_updated_at();

GRANT SELECT, INSERT, UPDATE ON maintenance.pool_configs TO authenticated;
GRANT ALL ON maintenance.pool_configs TO service_role;
ALTER TABLE maintenance.pool_configs ENABLE ROW LEVEL SECURITY;

-- Org-wide read: internal operational data (same stance as follow_ups).
CREATE POLICY "org_select_all" ON maintenance.pool_configs
  FOR SELECT TO authenticated
  USING (true);

-- Writes must be attributed to the caller's own employee row.
CREATE POLICY "tech_insert_own" ON maintenance.pool_configs
  FOR INSERT TO authenticated
  WITH CHECK (
    last_set_by IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid())
  );
CREATE POLICY "tech_update_own" ON maintenance.pool_configs
  FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (
    last_set_by IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid())
  );
