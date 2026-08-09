-- Applied via MCP 2026-08-08 as routing_context_floor.
-- routing context floor (RULED 2026-08-08): quota identity = one agreement
-- requirement era. Owner: routing module. See docs/conventions/SCHEMA_OWNERSHIP.md.
create schema if not exists routing;

-- One quota per requirement era. A terms change (new terms_version) births a
-- NEW quota — so a quota's stop-count can never legally drift from its
-- requirement (the Deen invariant, made unrepresentable structurally).
create table routing.quotas (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null,
  terms_version int not null,
  created_at timestamptz not null default now(),
  unique (agreement_id, terms_version),
  foreign key (agreement_id, terms_version)
    references agreements.terms_versions (agreement_id, version)
);

-- Whole-config placement history: each row is the COMPLETE stop set from its
-- from_date (whole-config versioning, RULED — stops never edited piecemeal).
-- Single writer: the converger from ION task translations.
create table routing.placement_versions (
  quota_id uuid not null references routing.quotas(id),
  version int not null,
  stops jsonb not null,
  from_date date not null,
  cause text not null check (cause in ('opened','transition','ion_side')),
  created_at timestamptz not null default now(),
  primary key (quota_id, version)
);

-- PostgREST exposure: service_role only (backend schema)
grant usage on schema routing to service_role;
grant all on all tables in schema routing to service_role;
grant usage, select on all sequences in schema routing to service_role;
alter default privileges in schema routing grant all on tables to service_role;
alter default privileges in schema routing grant usage, select on sequences to service_role;
alter role authenticator set pgrst.db_schemas to 'public,graphql_public,app_checks,maintenance,billing_audit,billing,agreements,routing';
notify pgrst, 'reload config';
