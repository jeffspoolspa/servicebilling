-- Applied via MCP 2026-08-08 as agreements_context_floor + agreements_schema_exposure.
-- The agreements bounded context (RULED): context = schema; one writer per
-- table (the repository / intake store); facts go to maintenance.events.
-- See lib/agreements/domain for the model this stores.
create schema if not exists agreements;

create table agreements.service_agreements (
  id uuid primary key,
  customer_id text not null,
  basis jsonb not null,
  status text not null default 'active' check (status in ('active','ended')),
  ended_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table agreements.terms_versions (
  agreement_id uuid not null references agreements.service_agreements(id),
  version int not null,
  pattern jsonb not null,
  billing jsonb not null,
  period jsonb not null,
  from_at timestamptz not null,
  cause text not null check (cause in ('opened','our_edit','ion_side')),
  primary key (agreement_id, version)
);

create table agreements.ion_incarnations (
  agreement_id uuid not null references agreements.service_agreements(id),
  ion_task_id text not null,
  from_at timestamptz not null,
  to_at timestamptz,
  cause text not null check (cause in ('opened','terms_change','placement_change','ion_side','unknown_backfill')),
  primary key (agreement_id, ion_task_id, from_at)
);
create unique index ion_incarnations_one_open_per_agreement
  on agreements.ion_incarnations (agreement_id) where to_at is null;
create unique index ion_incarnations_open_task_unique
  on agreements.ion_incarnations (ion_task_id) where to_at is null;

create table agreements.intake_translations (
  id bigint generated always as identity primary key,
  ion_task_id text not null,
  observed_at timestamptz not null,
  translation jsonb not null,
  raw_delta jsonb not null default '{}'::jsonb,
  unique (ion_task_id, observed_at)
);
create index intake_translations_latest on agreements.intake_translations (ion_task_id, observed_at desc);

create table agreements.intake_failures (
  id bigint generated always as identity primary key,
  ion_task_id text,
  observed_at timestamptz not null,
  failed text not null,
  raw jsonb not null,
  replayed_at timestamptz
);

-- PostgREST exposure: service_role only (backend schema; no anon/authenticated grants)
grant usage on schema agreements to service_role;
grant all on all tables in schema agreements to service_role;
grant usage, select on all sequences in schema agreements to service_role;
alter default privileges in schema agreements grant all on tables to service_role;
alter default privileges in schema agreements grant usage, select on sequences to service_role;
alter role authenticator set pgrst.db_schemas to 'public,graphql_public,app_checks,maintenance,billing_audit,billing,agreements';
notify pgrst, 'reload config';
