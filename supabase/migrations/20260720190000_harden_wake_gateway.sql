-- Harden the wake gateway — the single chokepoint every queue wake routes
-- through (billing.wake_queue_worker). After the 2026-07-20 wake-storm, add the
-- four guardrails from docs/conventions/COMPUTE_GOVERNANCE.md:
--   1. allowlist   — only registered paths fire; unregistered = BLOCKED (kills
--                    the moved-script/__MOVED footgun that caused the storm)
--   2. kill switch — global + per-path enable flags (halt all wakes with 1 UPDATE)
--   3. debounce    — per-path min interval collapses bursts (structural volume cap)
--   4. observability — wakes_sent / wakes_skipped counters + last_sent_at
-- Fail-open throughout: any guard error still lets the enqueue succeed, and a
-- blocked/debounced wake only costs latency (drain-until-empty + the heartbeat
-- schedule are the correctness guarantee; the wake is best-effort — ADR 008).

-- 1. Global kill switch (singleton).
create table if not exists billing.wake_settings (
  id               boolean primary key default true check (id),
  globally_enabled boolean not null default true,
  note             text
);
insert into billing.wake_settings (id) values (true) on conflict (id) do nothing;

-- 2. Per-path policy = allowlist + debounce + counters.
create table if not exists billing.wake_policy (
  script_path       text primary key,
  enabled           boolean     not null default true,
  min_interval_secs int         not null default 5,   -- debounce window
  last_sent_at      timestamptz,
  wakes_sent        bigint      not null default 0,
  wakes_skipped     bigint      not null default 0,
  note              text
);
comment on table billing.wake_policy is
  'Allowlist + debounce + kill switch for billing.wake_queue_worker. Only a '
  'registered, enabled path gets a wake; an unregistered path is BLOCKED and '
  'auto-recorded (enabled=false) — this is what kills the moved-script footgun. '
  'min_interval_secs debounces bursts; wakes_sent/skipped give observability.';

-- 3. Seed the allowlist with every CURRENT live wake target (zero behaviour
--    change for legitimate wakes; only unregistered targets get blocked).
insert into billing.wake_policy (script_path, min_interval_secs, note) values
  ('f/service_billing/drain_qbo_inbox',                 5,  'QBO cache sync drainer (webhook-driven)'),
  ('f/billing/process_maint_charges',                   3,  'maintenance charge/send worker'),
  ('f/service_billing/process_invoice',                 3,  'service-billing charge worker'),
  ('f/maintenance/backfill_follow_ups_from_airtable',  10,  'Airtable follow-up push (amplification-prone)')
on conflict (script_path) do nothing;

-- 4. Hardened gateway (preserves the original SECURITY DEFINER / search_path /
--    fail-open; adds the guardrails).
create or replace function billing.wake_queue_worker(p_script_path text, p_body jsonb)
returns void
language plpgsql
security definer
set search_path to 'billing', 'public'
as $function$
declare
  v_token  text;
  v_pol    billing.wake_policy%rowtype;
  v_global boolean;
begin
  -- (2) global kill switch
  select globally_enabled into v_global from billing.wake_settings limit 1;
  if v_global is distinct from true then
    return;
  end if;

  -- (1)+(2)+(3) allowlist / per-path kill / debounce; row-locked so concurrent
  -- wakes to the same path serialize and the debounce is exact.
  select * into v_pol from billing.wake_policy where script_path = p_script_path for update;
  if not found then
    -- unregistered target -> BLOCK and record it (visible misconfig signal)
    insert into billing.wake_policy (script_path, enabled, wakes_skipped, note)
      values (p_script_path, false, 1, 'auto-added: unregistered wake target — blocked')
      on conflict (script_path) do update set wakes_skipped = billing.wake_policy.wakes_skipped + 1;
    return;
  end if;
  if not v_pol.enabled then
    update billing.wake_policy set wakes_skipped = wakes_skipped + 1 where script_path = p_script_path;
    return;
  end if;
  if v_pol.last_sent_at is not null
     and now() - v_pol.last_sent_at < make_interval(secs => v_pol.min_interval_secs) then
    update billing.wake_policy set wakes_skipped = wakes_skipped + 1 where script_path = p_script_path;
    return;
  end if;

  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'windmill_token' limit 1;
  if v_token is null then
    return;
  end if;

  perform net.http_post(
    url     := 'https://app.windmill.dev/api/w/jps-internal/jobs/run/p/' || p_script_path,
    body    := p_body,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    timeout_milliseconds := 5000
  );

  -- (4) observability
  update billing.wake_policy
     set last_sent_at = now(), wakes_sent = wakes_sent + 1
   where script_path = p_script_path;
exception when others then
  null;  -- fail-open: a wake failure never breaks the enqueue
end;
$function$;

-- 5. Route the follow-up push through the gateway (it was inlining http_post,
--    bypassing every guard — the one row-level wake left, and the amplification
--    risk flagged in the 07-14 sync spike). Per-row filter unchanged.
create or replace function billing.fn_wake_follow_up_push()
returns trigger
language plpgsql
security definer
set search_path to 'billing', 'public'
as $function$
begin
  if new.airtable_record_id is not null or new.source is distinct from 'app' then
    return new;
  end if;
  perform billing.wake_queue_worker(
    'f/maintenance/backfill_follow_ups_from_airtable', '{"mode":"push"}'::jsonb);
  return new;
end;
$function$;
