-- Routing scenarios: a scenario at rest is nothing but a named change list.
-- Stops are NEVER stored here — on open, `changes` replays over the live plan
-- and stale changes are invalidated (Scenario.restore, ADR: routing model card
-- 2026-07-29). Status is the scenario's fate: pending → committed | discarded.
CREATE TABLE maintenance.scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'committed', 'discarded')),
  -- The ordered RoutingEvent list — the scenario's identity, not a cache of it.
  changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scenarios_status_idx ON maintenance.scenarios (status, updated_at DESC);

-- Internal planning tool: any authenticated office user may read and write.
GRANT SELECT, INSERT, UPDATE ON maintenance.scenarios TO authenticated;
GRANT ALL ON maintenance.scenarios TO service_role;
ALTER TABLE maintenance.scenarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY scenarios_authenticated_all ON maintenance.scenarios
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
