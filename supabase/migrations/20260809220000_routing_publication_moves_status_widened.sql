-- Applied via MCP 2026-08-09 as routing_publication_moves_status_running_landed.
-- The staged process added 'running' (a move opens before its verbs so steps
-- stream live) and 'landed_unverified' (ION confirmed, floor not converged).
-- Carter's six-move publish failed instantly on the old four-value check
-- before any verb fired (pub b1f4fcef). Definition of record:
alter table routing.publication_moves drop constraint if exists publication_moves_status_check;
alter table routing.publication_moves add constraint publication_moves_status_check
  check (status in ('running','done','skipped_no_diff','failed','bridge_needs_probe','landed_unverified'));
