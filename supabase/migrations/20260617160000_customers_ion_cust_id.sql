-- ADR 006: persist ION's customer id on the customer row (fuzzy-match-once-and-persist).
-- ION Pool Care exposes no QBO id anywhere in its own pages/API (verified: the customer
-- "QuickBooks Data" button only opens an empty custom-fields page; the QBO<->ION link lives
-- entirely in the third-party ProEdge sync bridge). So we cannot key ION->QBO deterministically
-- from ION. Instead we match each ION customer to a QBO customer once and persist the result
-- here; from then on task ownership resolves off this stable key, not the service-location owner.
alter table public."Customers"
  add column if not exists ion_cust_id          text,
  add column if not exists ion_match_method     text,        -- recurring_task_sync | report_exact | report_fuzzy | api_fuzzy | manual
  add column if not exists ion_match_confidence text,        -- high | medium | low
  add column if not exists ion_matched_at        timestamptz;

-- An ION customer maps to exactly one QBO customer: one ion_cust_id per Customers row.
create unique index if not exists uq_customers_ion_cust_id
  on public."Customers" (ion_cust_id) where ion_cust_id is not null;

comment on column public."Customers".ion_cust_id is
  'ION Pool Care internal customer id (= ION "Customer ID" / IPCCustomerID). Persisted '
  'fuzzy-match-once because ION exposes no QBO id (ADR 006). The deterministic key for '
  'resolving maintenance task ownership. Sources tracked in ion_match_method.';
comment on column public."Customers".ion_match_method is
  'How ion_cust_id was set: recurring_task_sync (from ion.recurring_tasks resolved pairs), '
  'report_exact / report_fuzzy (manual ION customer-report ingest), api_fuzzy (scheduled '
  'ION-API reconciler), or manual (set by a human).';
