-- Token bucket (ADR 008 §4, finally built) + the service-billing charge
-- queue (WORKFLOW_EXECUTION applied to the WO charge stage) + the one-pane
-- queue health view.
--
-- Rate limiting, two knobs: Windmill concurrency keys stay the WRITE
-- serializer (qbo_writer limit 1); this bucket governs total CALL volume —
-- one row per external system, every leader API call claims from it via
-- billing.claim_rate_token (wired inside f/billing/_lib/qbo so workers,
-- probes, sweeps, and UI fresh-reads all draw one budget without knowing
-- the bucket exists). QBO budget per the ADR 008 §8 rulebook: ~250/min
-- sustained (4/s refill), burst cap 200.

-- 1. the bucket ---------------------------------------------------------------

create table if not exists billing.rate_buckets (
  system text primary key,
  tokens numeric not null,
  cap numeric not null,
  refill_per_sec numeric not null,
  updated_at timestamptz not null default now()
);

insert into billing.rate_buckets (system, tokens, cap, refill_per_sec)
values ('qbo', 200, 200, 4.0)
on conflict (system) do nothing;

-- Atomic claim: refill-by-elapsed-time, then take p_cost if available.
-- Returns 0 when granted, else the suggested wait in seconds. An unknown
-- system returns 0 (no limit configured = fail open — the bucket must never
-- dead-stop a money path).
create or replace function billing.claim_rate_token(p_system text, p_cost numeric default 1)
returns numeric
language sql security definer
set search_path to 'billing'
as $$
  with b as (
    select system,
           least(cap, tokens + extract(epoch from (now() - updated_at)) * refill_per_sec) as avail,
           refill_per_sec
    from rate_buckets where system = p_system
    for update
  ),
  upd as (
    update rate_buckets r
    set tokens = case when b.avail >= p_cost then b.avail - p_cost else b.avail end,
        updated_at = now()
    from b where r.system = b.system
    returning case when b.avail >= p_cost then 0
                   else (p_cost - b.avail) / b.refill_per_sec end as wait_s
  )
  select coalesce((select wait_s from upd), 0);
$$;

grant execute on function billing.claim_rate_token(text, numeric) to service_role;

-- 2. the service-billing charge queue (unit = one invoice) --------------------

create table if not exists billing.service_charge_queue (
  id bigint generated always as identity primary key,
  qbo_invoice_id text not null,
  priority int not null default 3,   -- 1 = interactive click .. 4 = backfill flood
  received_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  attempts int not null default 0,
  error text
);

create unique index if not exists service_charge_queue_live
  on billing.service_charge_queue (qbo_invoice_id)
  where finished_at is null;
create index if not exists service_charge_queue_recent
  on billing.service_charge_queue (received_at desc);

create or replace function billing.enqueue_service_charge()
returns trigger
language plpgsql security definer
set search_path to 'billing'
as $$
begin
  insert into billing.service_charge_queue (qbo_invoice_id)
  values (new.qbo_invoice_id)
  on conflict (qbo_invoice_id) where finished_at is null
  do nothing;
  return new;
end;
$$;

drop trigger if exists trg_enqueue_service_charge on billing.invoices;
create trigger trg_enqueue_service_charge
  after insert or update of billing_status on billing.invoices
  for each row
  when (new.billing_status = 'ready_to_process')
  execute function billing.enqueue_service_charge();

-- 3. one pane of glass over every work queue ----------------------------------

create or replace view billing.v_queue_health as
select 'maint_preprocess' as queue,
       count(*) filter (where started_at is null and attempts < 3)  as queued,
       count(*) filter (where started_at is not null)               as in_flight,
       count(*) filter (where attempts >= 3)                        as dead_letter,
       min(enqueued_at)                                             as oldest_unprocessed
from billing_audit.maint_preprocess_queue where finished_at is null
union all
select 'maint_charge',
       count(*) filter (where started_at is null and attempts < 3),
       count(*) filter (where started_at is not null),
       count(*) filter (where attempts >= 3),
       min(received_at)
from billing_audit.maint_charge_queue where finished_at is null
union all
select 'service_charge',
       count(*) filter (where started_at is null and attempts < 3),
       count(*) filter (where started_at is not null),
       count(*) filter (where attempts >= 3),
       min(received_at)
from billing.service_charge_queue where finished_at is null;

create or replace view public.v_queue_health as select * from billing.v_queue_health;
grant select on public.v_queue_health to anon, authenticated, service_role;
