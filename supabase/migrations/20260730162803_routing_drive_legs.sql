-- Measured drive legs: directed pool-to-pool (and office-to-pool) road times
-- from Google Routes, learned once and owned forever. The pin snapshot is the
-- invalidation key — a re-geocoded pool no longer matches and its legs are
-- ignored (and re-measured on next view). Office ids embed coords (baseIdOf),
-- so office moves self-invalidate by id.
CREATE TABLE maintenance.drive_legs (
  from_id text NOT NULL,
  to_id text NOT NULL,
  minutes real NOT NULL,
  miles real NOT NULL,
  from_lat double precision NOT NULL,
  from_lng double precision NOT NULL,
  to_lat double precision NOT NULL,
  to_lng double precision NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id)
);

-- Internal planning tool: any authenticated office user may read and write.
GRANT SELECT, INSERT, UPDATE ON maintenance.drive_legs TO authenticated;
GRANT ALL ON maintenance.drive_legs TO service_role;
ALTER TABLE maintenance.drive_legs ENABLE ROW LEVEL SECURITY;
CREATE POLICY drive_legs_authenticated_all ON maintenance.drive_legs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
