-- The ION customer id (CustomerID from the service log) belongs on the visit as ground truth,
-- alongside ion_task_id (the EventID). Every visit should carry BOTH raw ION ids; the resolved
-- customer link (visits.customer_id) is derived, and the owning task also carries the customer.
-- Populated by the log-detail ingester and the orphan-visit recovery. See
-- docs/operations/ion-visit-task-backfill.md.
alter table maintenance.visits add column if not exists ion_cust_id text;

comment on column maintenance.visits.ion_cust_id is
  'ION customer id (CustomerID read from the service log / addLog) -- the ground-truth ION customer reference on the visit, alongside ion_task_id. The resolved link is customer_id; the owning task also carries the customer. Populated by the log-detail ingester / recovery. See docs/operations/ion-visit-task-backfill.md.';