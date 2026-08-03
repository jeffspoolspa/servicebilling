-- ION link attempts: the "awaiting" state ExternalRef already models.
-- A customer with a QBO identity but no ION link is not simply unlinked --
-- we are TRYING, a bounded number of times, and after that a person looks.
alter table public."Customers"
  add column if not exists ion_link_attempts smallint not null default 0,
  add column if not exists ion_link_attempted_at timestamptz;

comment on column public."Customers".ion_link_attempts is
  'ION match attempts made since the QBO identity existed. The give-up rule lives in the Customer aggregate (3), not here.';
comment on column public."Customers".ion_link_attempted_at is
  'When the last ION match was attempted. The daily sweep skips anything tried within 24h.';

-- The sweep''s index: awaiting customers, cheapest first.
create index if not exists customers_awaiting_ion_idx
  on public."Customers" (ion_link_attempted_at)
  where ion_cust_id is null and qbo_customer_id is not null;
