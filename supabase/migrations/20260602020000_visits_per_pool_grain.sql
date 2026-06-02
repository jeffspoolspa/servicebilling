-- maintenance.visits: re-key from one-visit-per-location-day to one-visit-per
-- (location, day, POOL, service_type).
--
-- BACKGROUND: visits_uniq_loc_scheduled = UNIQUE (service_location_id,
-- scheduled_date) forced ONE visit per address per day. But ION's service log
-- emits a SEPARATE completed-log entry per POOL (and per service type) on the
-- same day. Multi-pool communities/commercial accounts were therefore massively
-- under-counted: e.g. WINDING RIVER COMMUNITY = 104 ION events in May 2026 (a
-- handful of pools each serviced on most days) but only 31 stored visits -- the
-- ON CONFLICT (loc, scheduled_date) collapsed every pool of a day into one row,
-- discarding the rest (and their chem readings / consumables). That under-states
-- completed work and breaks billing reconciliation for these accounts.
--
-- The pool dimension was resolved during ingestion (public.pools via
-- get_or_create_pool) but DROPPED at the visit grain (no pool_id column). This
-- adds it and re-keys uniqueness to the actual unit of service.
--
-- GRAIN: (service_location_id, scheduled_date, pool_id, service_type). Derivable
-- from the bulk CompletedLogDetail report we already fetch (each row carries pool
-- name + service type as text) -- no extra ION calls. The report has no per-entry
-- LogID, so a true 1-visit-per-log-entry key would need ~40k per-visit lookups
-- (Imperva-WAF-risky) -- rejected in favor of this composite. Single-pool
-- residentials are unaffected (one pool/day either way).
--
-- NULLS NOT DISTINCT (PG15+): legacy/manual rows have NULL pool_id/service_type;
-- treating NULLs as equal preserves the old one-per-(loc,date) guard for them.
-- Existing rows (all NULL pool/service today) already satisfy this since the old
-- index allowed one per (loc, scheduled_date) -- so the swap is violation-free.
-- The f/ION re-ingest (delete external_source='ion' visits + re-backfill) then
-- populates pool_id/service_type and recovers the collapsed per-pool visits.

ALTER TABLE maintenance.visits
  ADD COLUMN IF NOT EXISTS pool_id uuid REFERENCES public.pools(id),
  ADD COLUMN IF NOT EXISTS service_type text;

DROP INDEX IF EXISTS maintenance.visits_uniq_loc_scheduled;

CREATE UNIQUE INDEX IF NOT EXISTS visits_uniq_loc_day_pool_service
  ON maintenance.visits (service_location_id, scheduled_date, pool_id, service_type)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS visits_pool_id ON maintenance.visits (pool_id) WHERE pool_id IS NOT NULL;

COMMENT ON COLUMN maintenance.visits.pool_id IS
  'The pool serviced (public.pools). Part of the visit grain so multi-pool '
  'locations get one visit per pool per day instead of collapsing to one.';
COMMENT ON COLUMN maintenance.visits.service_type IS
  'ION service type for this visit (e.g. POOL MAINTENANCE 80, CHEMICAL TESTING). '
  'Part of the visit grain so a pool serviced for two services the same day '
  'stays two visits.';
