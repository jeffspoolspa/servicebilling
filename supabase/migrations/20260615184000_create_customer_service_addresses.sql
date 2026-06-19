-- ADR 005, Phase 1: separate "who owns it" from the address itself.
--
-- public.service_locations is becoming the CANONICAL service address (one row per
-- physical place). Ownership moves to this link table. Minimal by design — just the
-- (customer, address) tuple + is_active — with one invariant: at most one ACTIVE
-- customer per address. No start/end dates, no relationship role (see ADR 005).
--
-- Non-breaking: service_locations.account_id stays during the transition. This
-- migration only ADDS the link table and backfills one link per existing row.

create table if not exists public.customer_service_addresses (
  id                  bigint generated always as identity primary key,
  customer_id         bigint  not null references public."Customers"(id) on delete cascade,
  service_location_id bigint  not null references public.service_locations(id) on delete cascade,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (customer_id, service_location_id)
);

-- The invariant: one active customer per canonical service address.
create unique index if not exists uq_csa_one_active_per_location
  on public.customer_service_addresses (service_location_id) where is_active;

create index if not exists idx_csa_customer
  on public.customer_service_addresses (customer_id);

comment on table public.customer_service_addresses is
  'Link: which customer is/was associated with a canonical service address (public.service_locations). Minimal tuple + is_active; at most one active customer per address. Ownership history is read from address-keyed visits, not from this table. See ADR 005.';

-- RLS: readable by authenticated app; writes go through SECURITY DEFINER RPCs / service_role.
alter table public.customer_service_addresses enable row level security;
create policy csa_authenticated_read on public.customer_service_addresses
  for select to authenticated using (true);
grant select on public.customer_service_addresses to authenticated;
grant all    on public.customer_service_addresses to service_role;

-- Backfill: one link per existing service location, mirroring its active flag.
insert into public.customer_service_addresses (customer_id, service_location_id, is_active)
select sl.account_id, sl.id, sl.is_active
from public.service_locations sl
where sl.account_id is not null
on conflict (customer_id, service_location_id) do nothing;
