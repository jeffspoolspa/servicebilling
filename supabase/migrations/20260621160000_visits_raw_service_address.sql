-- ADR 007 §9: keep the RAW service address ION reported on each visit, for debugging. The
-- visit's actual service_location is resolved/inherited separately (it's the task's/customer's
-- canonical address); this column is never used for resolution -- it's the audit trail of what
-- the visit report literally said, so a mis-resolution can be diagnosed. Populated by the ION
-- visit ingester (f/ION/_lib/upsert).
alter table maintenance.visits
  add column if not exists raw_service_address text;

comment on column maintenance.visits.raw_service_address is
  'The address string ION reported on the visit row (Address2/Address1 + city), kept for debugging only -- NOT used to resolve service_location_id (ADR 007 §9).';
