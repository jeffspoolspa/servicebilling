-- BillingMonth state, variances, and the AdvanceMonth queue.
-- Applied 2026-08-03. See docs/model/BILLING_MODEL.md and
-- docs/conventions/EVENTS_AND_COMMANDS.md for why each shape is what it is.
alter table billing.billing_months
  add column if not exists reconciled_at        timestamptz,
  add column if not exists disputed_at          timestamptz,
  add column if not exists disputes             jsonb not null default '[]'::jsonb,
  add column if not exists delivery_refreshed_at timestamptz,
  add column if not exists gated_at             timestamptz,
  add column if not exists gate_held_for        jsonb not null default '[]'::jsonb,
  add column if not exists invoiced_at          timestamptz,
  add column if not exists sent_at              timestamptz;

create table if not exists billing.variances (
  id               uuid primary key default gen_random_uuid(),
  billing_month_id uuid not null references billing.billing_months(id) on delete cascade,
  source_id        uuid,
  kind             text not null check (kind in ('remove_consumable','qty_correction','discount','missed','proration')),
  origin           text not null check (origin in ('visit','invoice')),
  reason           text not null check (btrim(reason) <> ''),
  delta_cents      integer,
  tech_id          uuid,
  disposition      text not null check (disposition in ('amend_invoice','recorded_only')),
  recorded_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);
create index if not exists variances_month_idx on billing.variances (billing_month_id);

create table if not exists billing.billing_month_queue (
  id               bigserial primary key,
  billing_month_id uuid not null references billing.billing_months(id) on delete cascade,
  priority         smallint not null default 3,
  received_at      timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  attempts         smallint not null default 0,
  error            text
);
create unique index if not exists billing_month_queue_open_uniq
  on billing.billing_month_queue (billing_month_id) where finished_at is null;
create index if not exists billing_month_queue_claimable
  on billing.billing_month_queue (priority, received_at) where finished_at is null;
