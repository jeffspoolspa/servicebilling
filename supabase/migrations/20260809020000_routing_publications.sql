-- Applied via MCP 2026-08-08 as routing_publications.
-- PublishScenario's ledger (RULED 2026-08-08): one publication header per
-- attempt, one row per move — processing-plane state (like invoice_queue),
-- not facts. Resumable: a re-run re-derives and skips moves whose fresh
-- diff is empty. Single writer: the publish sentence.
create table routing.publications (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null,
  mode text not null check (mode in ('dry','live')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  refused text,
  summary jsonb not null default '{}'::jsonb
);
create table routing.publication_moves (
  publication_id uuid not null references routing.publications(id),
  quota_id uuid not null,
  ion_task_id text not null,
  write_kind text not null,
  status text not null check (status in ('done','skipped_no_diff','failed','bridge_needs_probe')),
  ops jsonb not null default '[]'::jsonb,
  echoes jsonb not null default '[]'::jsonb,
  bridge jsonb,
  error text,
  created_at timestamptz not null default now(),
  primary key (publication_id, quota_id)
);
grant all on all tables in schema routing to service_role;
