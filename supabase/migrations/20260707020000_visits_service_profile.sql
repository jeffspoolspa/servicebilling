-- ION's per-log ServiceProfile = the body of water the log was submitted
-- against (multi-body customers have one profile per body). Parsed by
-- get_log_detail all along; now persisted per visit.
ALTER TABLE maintenance.visits ADD COLUMN service_profile text;
