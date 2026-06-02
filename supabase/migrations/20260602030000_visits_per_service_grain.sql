-- Correct the visit grain from per-pool to per-(location, day, service_type).
-- Multiple service bodies (pools) serviced under ONE service on the same day are
-- ONE billable visit (they bill together), not one-per-pool. Different services
-- (POOL MAINTENANCE vs CHEMICAL TESTING) stay separate. Pool is a per-row detail
-- on chem_readings / consumables_usage / visit_tasks; the visit's pool_id is the
-- primary pool. Supersedes the per-pool grain (20260602020000).
DROP INDEX IF EXISTS maintenance.visits_uniq_loc_day_pool_service;
CREATE UNIQUE INDEX IF NOT EXISTS visits_uniq_loc_day_service
  ON maintenance.visits (service_location_id, scheduled_date, service_type)
  NULLS NOT DISTINCT;
