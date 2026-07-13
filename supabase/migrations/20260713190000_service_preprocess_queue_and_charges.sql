-- Two changes decided 2026-07-13:
--
-- 1. Service-billing PRE-PROCESS becomes a real queue (WORKFLOW_EXECUTION
--    envelope) fed by the WO-link trigger, replacing the at-most-once pg_net
--    direct-fire (trg_pre_processing_on_link) + status-scan dispatcher. The
--    dispatcher becomes the claim-loop worker; eligibility (billable,
--    subtotal_ok, not yet pre-processed) is checked at CLAIM time, not
--    enqueue time.
--
-- 2. Phase 5 step 1 (attempt/charge split, entities/processing-attempt.md):
--    billing.charges — the reflection of Intuit's charge events, keyed by
--    Intuit's charge_id; written by charge_and_record (success AND declines
--    — Intuit ids declines too) and later by reconcile_payments as it
--    discovers state. processing_attempts gains `lines` jsonb
--    ([[qbo_invoice_id, amount], ...]) — the one genuinely variable-shape
--    field; domain labels (wo_number, billing_month) come from joins in the
--    read models, never from attempt columns.

-- 1a. the queue --------------------------------------------------------------

create table if not exists billing.service_preprocess_queue (
  id bigint generated always as identity primary key,
  qbo_invoice_id text not null,
  priority int not null default 3,
  received_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  attempts int not null default 0,
  error text
);

create unique index if not exists service_preprocess_queue_live
  on billing.service_preprocess_queue (qbo_invoice_id)
  where finished_at is null;
create index if not exists service_preprocess_queue_recent
  on billing.service_preprocess_queue (received_at desc);

-- 1b. enqueue on WO link (dumb SQL + best-effort wake) ------------------------

create or replace function billing.enqueue_service_preprocess()
returns trigger
language plpgsql security definer
set search_path to 'billing', 'public'
as $$
begin
  if new.qbo_invoice_id is null
     or old.qbo_invoice_id is not distinct from new.qbo_invoice_id then
    return new;
  end if;
  insert into billing.service_preprocess_queue (qbo_invoice_id)
  values (new.qbo_invoice_id)
  on conflict (qbo_invoice_id) where finished_at is null
  do nothing;
  perform billing.wake_queue_worker('f/service_billing/dispatch_pre_processing',
                                    '{}'::jsonb);
  return new;
end;
$$;

drop trigger if exists trg_pre_processing_on_link on public.work_orders;
drop function if exists billing.fn_trigger_pre_processing_on_link();

drop trigger if exists trg_enqueue_service_preprocess on public.work_orders;
create trigger trg_enqueue_service_preprocess
  after insert or update of qbo_invoice_id on public.work_orders
  for each row execute function billing.enqueue_service_preprocess();

-- 2a. the charge reflection ---------------------------------------------------

create table if not exists billing.charges (
  charge_id text primary key,          -- Intuit's identity, never ours
  payment_type text,                   -- card | ach
  status text,                         -- CAPTURED | DECLINED | PENDING | ...
  amount numeric,
  auth_code text,
  card_type text,
  card_last4 text,
  raw jsonb,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2b. attempt lines (domain-blind membership of the charge) -------------------

alter table billing.processing_attempts
  add column if not exists lines jsonb;

-- 3. health view gains the fourth queue ---------------------------------------

create or replace view billing.v_queue_health as
select 'service_preprocess' as queue,
       count(*) filter (where started_at is null and attempts < 3)  as queued,
       count(*) filter (where started_at is not null)               as in_flight,
       count(*) filter (where attempts >= 3)                        as dead_letter,
       min(received_at)                                             as oldest_unprocessed
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
