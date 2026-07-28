-- ADR 010: billing.events — the append-only domain event stream.
-- One stream for the billing bounded context; aggregate column discriminates.
-- Immutability is ENFORCED (trigger + revoke), not documented.
-- Applied 2026-07-23 via MCP apply_migration (recorded version 20260723122616).

create table billing.events (
  seq          bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  aggregate    text not null
               check (aggregate in ('invoice','payment','attempt','customer','work_order')),
  aggregate_id text not null,
  type         text not null,
  actor        text not null default 'auto',
  participants text[] not null default '{}',
  payload      jsonb not null default '{}'
);

create index idx_billing_events_agg on billing.events (aggregate, aggregate_id, seq);
create index idx_billing_events_type on billing.events (type, seq);
create index idx_billing_events_participants on billing.events using gin (participants);
create index idx_billing_events_occurred on billing.events (occurred_at);

create or replace function billing.events_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'billing.events is append-only (ADR 010): % blocked', tg_op;
end $$;

create trigger trg_events_no_update_delete
  before update or delete on billing.events
  for each row execute function billing.events_immutable();
create trigger trg_events_no_truncate
  before truncate on billing.events
  for each statement execute function billing.events_immutable();

revoke update, delete, truncate on billing.events from anon, authenticated;

-- ADR 010 §E: SyncToken storage on the mirror rows (ordering audit; monotonic
-- compare only, never used for writes — writes GET-fresh per Intuit's OCC).
alter table billing.invoices          add column if not exists sync_token bigint;
alter table billing.customer_payments add column if not exists sync_token bigint;
alter table public."Customers"        add column if not exists sync_token bigint;

comment on table billing.events is
  'Append-only billing domain event stream (ADR 010). Written only via f/billing/_lib/events.append_event. Names: docs/conventions/EVENT_VOCABULARY.md';
