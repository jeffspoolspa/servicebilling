-- ADR 007: customer_service_addresses becomes the address ledger (link + history + resolution queue).
-- Additive substrate only — the columns + states the ledger needs. The behavioral cutover (the
-- resolver, the composer, reject-null on upsert_service_location, and the create_account/intake
-- rewire) lands separately. The existing UNIQUE(customer_id, service_location_id) is kept (the
-- upsert RPC's ON CONFLICT depends on it, and once service_location_id is nullable it correctly
-- allows multiple (customer, NULL) pending rows). See docs/adrs/007.

alter table public.customer_service_addresses
  add column if not exists raw_street       text,
  add column if not exists raw_city         text,
  add column if not exists raw_state        text,
  add column if not exists raw_zip          text,
  add column if not exists source           text not null default 'legacy',
  add column if not exists resolution_status text not null default 'resolved',
  add column if not exists resolved_at      timestamptz;

-- existing 8,762 links are all resolved (they point at a canonical row)
update public.customer_service_addresses
   set resolved_at = coalesce(resolved_at, created_at)
 where service_location_id is not null and resolved_at is null;

-- service_location_id null now means "claimed but not yet resolved" (raw_* carries the address)
alter table public.customer_service_addresses
  alter column service_location_id drop not null;

alter table public.customer_service_addresses
  drop constraint if exists csa_resolution_status_check;
alter table public.customer_service_addresses
  add constraint csa_resolution_status_check
  check (resolution_status in ('pending','resolved','needs_review','duplicate'));

comment on column public.customer_service_addresses.resolution_status is
  'Row lifecycle (ADR 007): pending (claimed, no place_id yet — drain retries) | resolved (service_location_id set) | needs_review (autocomplete found no confident pick — human resolves) | duplicate (resolved to a place the customer already links — human deletes). service_location_id is null for everything but resolved.';
comment on column public.customer_service_addresses.source is
  'Origin of the claim: legacy | lead | ion | qbo_ship | qbo_billing_fallback | manual.';

-- the human work-list: links that are not resolved, with the raw address for context
create or replace view public.v_addresses_needing_resolution as
select csa.id, csa.customer_id, c.display_name, c.qbo_customer_id,
       csa.raw_street, csa.raw_city, csa.raw_state, csa.raw_zip,
       csa.source, csa.resolution_status, csa.created_at
  from public.customer_service_addresses csa
  join public."Customers" c on c.id = csa.customer_id
 where csa.service_location_id is null
 order by csa.created_at desc;

grant select on public.v_addresses_needing_resolution to anon, authenticated, service_role;
