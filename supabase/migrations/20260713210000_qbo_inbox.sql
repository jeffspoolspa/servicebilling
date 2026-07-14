-- The QBO inbox (ADR 008 §1 built): ONE inbox per external SYSTEM, entity
-- type as a COLUMN — one drainer, one watermark, one priority scheme. This
-- is a single worker's queue (the sync drainer), so it does not violate the
-- one-table-per-worker rule: entity_type is handler dispatch inside one
-- workflow ("reflect this entity"), not a router across workflows.
--
-- Envelope + a carried hint (§5: hints apply only if fresher than the cache,
-- else the handler refetches — so coalescing may safely overwrite them).
-- Webhook handlers become dumb: persist envelope, return 200 (the route
-- swaps its per-event triggerScript fan-out for one RPC insert).

create table if not exists billing.qbo_inbox (
  id bigint generated always as identity primary key,
  entity_type text not null,          -- Invoice | Payment | CreditMemo | Customer
  entity_id text not null,
  operation text,                     -- Create/Update/Delete/Void/Emailed (handlers that care)
  hint_payload jsonb,                 -- optional carried snapshot (OCC-guarded)
  source text not null default 'manual',  -- webhook | probe | sweep | manual | engine
  priority int not null default 3,
  received_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  attempts int not null default 0,
  error text
);

-- Coalescing: N signals for one entity = one unit of work. The NEWEST signal
-- wins operation/hint/priority (a Void arriving after an Update must not be
-- masked by the queued Update).
create unique index if not exists qbo_inbox_live
  on billing.qbo_inbox (entity_type, entity_id)
  where finished_at is null;
create index if not exists qbo_inbox_recent
  on billing.qbo_inbox (received_at desc);

-- PostgREST RPC (the route only sees the public schema — same pattern as
-- log_qbo_webhook).
create or replace function public.enqueue_qbo_inbox(
  p_entity_type text,
  p_entity_id text,
  p_operation text default null,
  p_payload jsonb default null,
  p_source text default 'webhook',
  p_priority int default 3
) returns void
language plpgsql security definer
set search_path to 'billing', 'public'
as $$
begin
  insert into billing.qbo_inbox
    (entity_type, entity_id, operation, hint_payload, source, priority)
  values (p_entity_type, p_entity_id, p_operation, p_payload, p_source, p_priority)
  on conflict (entity_type, entity_id) where finished_at is null
  do update set operation   = excluded.operation,
                hint_payload = excluded.hint_payload,
                priority    = least(billing.qbo_inbox.priority, excluded.priority);
end;
$$;

grant execute on function public.enqueue_qbo_inbox(text, text, text, jsonb, text, int)
  to service_role;

-- wake the drainer on every signal (heartbeat is the at-most-once backstop)
create or replace function billing.wake_qbo_inbox_drainer()
returns trigger
language plpgsql security definer
set search_path to 'billing'
as $$
begin
  perform billing.wake_queue_worker('f/service_billing/drain_qbo_inbox', '{}'::jsonb);
  return new;
end;
$$;

drop trigger if exists trg_wake_qbo_inbox on billing.qbo_inbox;
create trigger trg_wake_qbo_inbox
  after insert on billing.qbo_inbox
  for each row execute function billing.wake_qbo_inbox_drainer();

-- one pane of glass gains the fifth queue
create or replace view billing.v_queue_health as
select 'qbo_inbox' as queue,
       count(*) filter (where started_at is null and attempts < 3)  as queued,
       count(*) filter (where started_at is not null)               as in_flight,
       count(*) filter (where attempts >= 3)                        as dead_letter,
       min(received_at)                                             as oldest_unprocessed
from billing.qbo_inbox where finished_at is null
union all
select 'service_preprocess',
       count(*) filter (where started_at is null and attempts < 3),
       count(*) filter (where started_at is not null),
       count(*) filter (where attempts >= 3),
       min(received_at)
from billing.service_preprocess_queue where finished_at is null
union all
select 'service_charge',
       count(*) filter (where started_at is null and attempts < 3),
       count(*) filter (where started_at is not null),
       count(*) filter (where attempts >= 3),
       min(received_at)
from billing.service_charge_queue where finished_at is null
union all
select 'maint_preprocess',
       count(*) filter (where started_at is null and attempts < 3),
       count(*) filter (where started_at is not null),
       count(*) filter (where attempts >= 3),
       min(enqueued_at)
from billing_audit.maint_preprocess_queue where finished_at is null
union all
select 'maint_charge',
       count(*) filter (where started_at is null and attempts < 3),
       count(*) filter (where started_at is not null),
       count(*) filter (where attempts >= 3),
       min(received_at)
from billing_audit.maint_charge_queue where finished_at is null;
