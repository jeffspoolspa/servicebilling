-- A log ION deleted is a RETRACTED fact, not a fact we forget we saw. The
-- ingester upserts by ion_log_id and previously never noticed a log vanish
-- from the day grid — so a redone entry double-billed its chemicals (Chesser,
-- July 2026: deleted log 37431349's chems = the exact $24.93 over-bill;
-- labor survived only because per-visit labor collapses by day).
ALTER TABLE maintenance.visits ADD COLUMN ion_deleted_at timestamptz;
CREATE INDEX visits_ion_deleted ON maintenance.visits (ion_deleted_at) WHERE ion_deleted_at IS NOT NULL;
COMMENT ON COLUMN maintenance.visits.ion_deleted_at IS
  'Set by ingest_day_logs when this ion_log_id is no longer on its day''s ION grid; cleared if it reappears. Billing reads exclude retracted visits.';
