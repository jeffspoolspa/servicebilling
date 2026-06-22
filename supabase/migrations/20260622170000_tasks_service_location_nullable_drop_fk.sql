-- ADR 007 §9 — dropping maintenance.tasks.service_location_id (a task carries customer_id, not a
-- location; a contract can outlive an address change). EXPAND/CONTRACT, step A (this file):
-- make the column nullable + drop its FK, so the live task-writing ingesters (upsert_tasks,
-- recover_orphan_tasks) can be redeployed to stop populating it WITHOUT a NOT-NULL violation,
-- while old code (still writing a valid value) keeps working. The physical DROP COLUMN is step B
-- (a later migration), run only AFTER all three live scripts are redeployed off the column and a
-- cycle is verified. No view/function depends on this column (views repointed in the epic2 set;
-- reconcile_visit_locations reads only csa./v.service_location_id).
alter table maintenance.tasks alter column service_location_id drop not null;
alter table maintenance.tasks drop constraint if exists tasks_service_location_id_fkey;
