-- Queues ALWAYS self-drain (Carter 2026-07-13): authorization happens BEFORE
-- enqueue — a queue row means "safe to process". The gate is the projection +
-- review process that feeds ready_to_process; once a row lands, workers run.
--
-- Mechanics per ADR 008 §3: AFTER INSERT -> pg_net -> kick the worker
-- (wake-on-event, priority-blind — any row wakes; priority orders WITHIN the
-- drain). Windmill's concurrent_limit 1 queues (not drops) a kick that fires
-- mid-drain, closing the exit race. pg_net is at-most-once (~6% drops seen
-- under burst), so 15-min heartbeat schedules on the workers are the
-- liveness backstop — wake gives latency, only the heartbeat guarantees
-- nothing is forgotten. Shared vault secret 'windmill_token' (canonical
-- DB->Windmill webhook token; one place to rotate).

create or replace function billing.wake_queue_worker(p_script_path text, p_body jsonb)
returns void
language plpgsql security definer
set search_path to 'billing', 'public'
as $$
declare
  v_token text;
begin
  select decrypted_secret into v_token
    from vault.decrypted_secrets
   where name = 'windmill_token'
   limit 1;
  if v_token is null then
    return;  -- heartbeat will pick the row up
  end if;
  perform net.http_post(
    url     := 'https://app.windmill.dev/api/w/jps-internal/jobs/run/p/' || p_script_path,
    body    := p_body,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Content-Type',  'application/json'),
    timeout_milliseconds := 5000
  );
exception when others then
  null;  -- wake is best-effort by design; never fail the enqueue
end;
$$;

-- service charge queue -> process_invoice drain
create or replace function billing.wake_service_charge_worker()
returns trigger
language plpgsql security definer
set search_path to 'billing'
as $$
begin
  perform billing.wake_queue_worker('f/service_billing/process_invoice',
                                    jsonb_build_object('drain', true));
  return new;
end;
$$;

drop trigger if exists trg_wake_service_charge on billing.service_charge_queue;
create trigger trg_wake_service_charge
  after insert on billing.service_charge_queue
  for each row execute function billing.wake_service_charge_worker();

-- maintenance charge queue -> process_maint_charges drain
create or replace function billing.wake_maint_charge_worker()
returns trigger
language plpgsql security definer
set search_path to 'billing'
as $$
begin
  perform billing.wake_queue_worker('f/billing/process_maint_charges',
                                    jsonb_build_object('dry_run', false));
  return new;
end;
$$;

drop trigger if exists trg_wake_maint_charge on billing_audit.maint_charge_queue;
create trigger trg_wake_maint_charge
  after insert on billing_audit.maint_charge_queue
  for each row execute function billing.wake_maint_charge_worker();

-- preprocess queue -> dispatcher (was heartbeat-only; linked invoices waited
-- up to 2 min when the old direct pg_net fire dropped)
create or replace function billing.wake_maint_preprocess_worker()
returns trigger
language plpgsql security definer
set search_path to 'billing'
as $$
begin
  perform billing.wake_queue_worker('f/billing/drain_maint_preprocess_queue',
                                    '{}'::jsonb);
  return new;
end;
$$;

drop trigger if exists trg_wake_maint_preprocess on billing_audit.maint_preprocess_queue;
create trigger trg_wake_maint_preprocess
  after insert on billing_audit.maint_preprocess_queue
  for each row execute function billing.wake_maint_preprocess_worker();
