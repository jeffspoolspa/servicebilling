-- Campaign engine: enroll a lead/customer in a named, multi-step comms campaign;
-- a daily Windmill driver fires due steps. First live campaign: quote_followup.
--
-- Module: docs/flows/lead-intake-to-conversion (proposer)
-- New schema: comms (owns the campaign engine; cross-cutting lead + customer comms)
-- Shared types read: public.leads, public."Customers", maintenance.lead_activities
--
-- BACKGROUND
-- The old f/comms/quote_followup_cadence.py read maintenance.maintenance_leads (a
-- dropped Gen-1 table) and sent via Gmail. It is dead. This replaces it with a
-- general engine. ALL access is through public.* SECURITY DEFINER RPCs, so the
-- comms schema never needs PostgREST exposure (matches the app's RPC-first pattern).
-- Sending/rendering stay in the app (Resend/RingCentral + public.communications);
-- the Windmill driver only selects due enrollments and calls the app to send + advance.
--
-- TIMELINE PATTERN (read-time, not write-through): the lead timeline reads from
-- canonical source tables (public.v_lead_timeline unions them). Campaign activity
-- is therefore NOT copied into maintenance.lead_activities — sends are read from
-- public.communications (live status) and enroll/complete/cancel are read from the
-- timestamps on comms.campaign_enrollments below. Adding an entity to the timeline
-- = adding a SELECT to the view, not a new table to write to.

create schema if not exists comms;

-- ── Tables ───────────────────────────────────────────────────────────────────

-- A named campaign definition (e.g. 'quote_followup').
create table if not exists comms.campaigns (
  key         text primary key,
  name        text not null,
  description text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- The ordered cadence inside a campaign. offset_days = gap from the PREVIOUS step
-- (step 0 is usually 0 = "send on enroll"). channel 'auto' = email if present else SMS.
create table if not exists comms.campaign_steps (
  id            uuid primary key default gen_random_uuid(),
  campaign_key  text not null references comms.campaigns(key) on delete cascade,
  step_index    int  not null,
  offset_days   int  not null check (offset_days >= 0),
  channel       text not null default 'auto' check (channel in ('auto','email','sms')),
  template_name text not null,
  unique (campaign_key, step_index)
);

-- One row per enrolled subject. current_step = index of the NEXT step to send.
create table if not exists comms.campaign_enrollments (
  id            uuid primary key default gen_random_uuid(),
  campaign_key  text not null references comms.campaigns(key),
  lead_id       uuid    references public.leads(id)       on delete cascade,
  customer_id   bigint  references public."Customers"(id) on delete cascade,
  current_step  int  not null default 0,
  status        text not null default 'active' check (status in ('active','completed','cancelled')),
  next_due_at   timestamptz not null default now(),
  enrolled_at   timestamptz not null default now(),
  last_sent_at  timestamptz,
  completed_at  timestamptz,        -- set when the last step is sent
  cancelled_at  timestamptz,        -- set on accept/convert/decline
  cancelled_reason text,
  metadata      jsonb not null default '{}'::jsonb,
  constraint campaign_enroll_subject_present check (lead_id is not null or customer_id is not null)
);

-- Idempotency: at most ONE active enrollment per (campaign, subject).
create unique index if not exists campaign_enroll_active_lead
  on comms.campaign_enrollments (campaign_key, lead_id)
  where status = 'active' and lead_id is not null;
create unique index if not exists campaign_enroll_active_customer
  on comms.campaign_enrollments (campaign_key, customer_id)
  where status = 'active' and customer_id is not null;
-- Driver hot path: "active and due".
create index if not exists campaign_enroll_due
  on comms.campaign_enrollments (next_due_at)
  where status = 'active';

-- RLS on by default; no policies → unreachable by anon/authenticated. Access is
-- via SECURITY DEFINER RPCs (owner-run) and the service-role client (bypasses RLS).
alter table comms.campaigns             enable row level security;
alter table comms.campaign_steps        enable row level security;
alter table comms.campaign_enrollments  enable row level security;

-- ── Seed: quote_followup (day 0, +2, +3, +5 → 4 touches, then complete) ──────
insert into comms.campaigns (key, name, description) values
  ('quote_followup',
   'Maintenance quote follow-up',
   'Chases a maintenance lead after the initial quote until they accept/convert or it completes.')
on conflict (key) do nothing;

insert into comms.campaign_steps (campaign_key, step_index, offset_days, channel, template_name) values
  ('quote_followup', 0, 0, 'auto', 'lead_quote'),
  ('quote_followup', 1, 2, 'auto', 'lead_quote'),
  ('quote_followup', 2, 3, 'auto', 'lead_quote'),
  ('quote_followup', 3, 5, 'auto', 'lead_quote')
on conflict (campaign_key, step_index) do nothing;

-- ── RPCs (public wrappers; the only access path) ─────────────────────────────

-- Enroll a subject. Idempotent: returns the existing active enrollment if one
-- exists. p_send_first_now=true makes step 0 due immediately (next_due_at=now);
-- false schedules it after step 0's offset. Logs a 'campaign_enrolled' activity
-- for leads so it shows on the lead timeline.
create or replace function public.enroll_in_campaign(
  p_campaign_key   text,
  p_lead_id        uuid   default null,
  p_customer_id    bigint default null,
  p_send_first_now boolean default true
) returns uuid
  language plpgsql security definer
  set search_path = public, comms, maintenance
as $$
declare
  v_id           uuid;
  v_first_offset int;
begin
  if p_lead_id is null and p_customer_id is null then
    raise exception 'enroll_in_campaign: need lead_id or customer_id';
  end if;
  if not exists (select 1 from comms.campaigns where key = p_campaign_key and active) then
    raise exception 'enroll_in_campaign: unknown or inactive campaign %', p_campaign_key;
  end if;

  -- Idempotent reuse of an existing active enrollment.
  select id into v_id
    from comms.campaign_enrollments
   where campaign_key = p_campaign_key and status = 'active'
     and ( (p_lead_id     is not null and lead_id     = p_lead_id)
        or (p_customer_id is not null and customer_id = p_customer_id) )
   limit 1;
  if v_id is not null then
    return v_id;
  end if;

  select offset_days into v_first_offset
    from comms.campaign_steps
   where campaign_key = p_campaign_key and step_index = 0;

  insert into comms.campaign_enrollments (campaign_key, lead_id, customer_id, next_due_at)
  values (
    p_campaign_key, p_lead_id, p_customer_id,
    case when p_send_first_now then now()
         else now() + make_interval(days => coalesce(v_first_offset, 0)) end
  )
  returning id into v_id;

  -- No write to lead_activities: the enrollment row IS the record. The timeline
  -- view reads enrolled_at directly from comms.campaign_enrollments.
  return v_id;
end;
$$;

-- Cancel active enrollments for a subject (called on accept/convert/decline).
-- Returns the number cancelled. Optionally scope to one campaign.
create or replace function public.cancel_campaign_enrollments(
  p_lead_id      uuid   default null,
  p_customer_id  bigint default null,
  p_campaign_key text   default null,
  p_reason       text   default null
) returns int
  language sql security definer
  set search_path = public, comms
as $$
  with upd as (
    update comms.campaign_enrollments
       set status = 'cancelled', cancelled_at = now(), cancelled_reason = p_reason
     where status = 'active'
       and (p_campaign_key is null or campaign_key = p_campaign_key)
       and ( (p_lead_id     is not null and lead_id     = p_lead_id)
          or (p_customer_id is not null and customer_id = p_customer_id) )
    returning 1
  )
  select count(*)::int from upd;
$$;

-- Driver read: the active enrollments whose next step is due now. The app then
-- renders + sends + logs each, and calls advance_campaign_enrollment.
create or replace function public.get_due_campaign_enrollments(
  p_limit        int  default 200,
  p_campaign_key text default null
) returns table (
  enrollment_id uuid,
  campaign_key  text,
  lead_id       uuid,
  customer_id   bigint,
  current_step  int,
  next_due_at   timestamptz
)
  language sql security definer
  set search_path = public, comms
as $$
  select id, campaign_key, lead_id, customer_id, current_step, next_due_at
    from comms.campaign_enrollments
   where status = 'active' and next_due_at <= now()
     and (p_campaign_key is null or campaign_key = p_campaign_key)
   order by next_due_at
   limit greatest(p_limit, 0);
$$;

-- Advance after the app sends the current step. Schedules the next step from its
-- offset_days, or marks the enrollment completed when there is no next step.
create or replace function public.advance_campaign_enrollment(p_enrollment_id uuid)
  returns jsonb
  language plpgsql security definer
  set search_path = public, comms
as $$
declare
  v_enr  comms.campaign_enrollments;
  v_next comms.campaign_steps;
begin
  select * into v_enr from comms.campaign_enrollments
   where id = p_enrollment_id for update;
  if not found then
    raise exception 'advance_campaign_enrollment: no enrollment %', p_enrollment_id;
  end if;

  select * into v_next from comms.campaign_steps
   where campaign_key = v_enr.campaign_key and step_index = v_enr.current_step + 1;

  if found then
    update comms.campaign_enrollments
       set current_step = current_step + 1,
           last_sent_at = now(),
           next_due_at  = now() + make_interval(days => v_next.offset_days)
     where id = p_enrollment_id;
    return jsonb_build_object('status','active','next_step', v_next.step_index,
                              'next_due_at', now() + make_interval(days => v_next.offset_days));
  else
    update comms.campaign_enrollments
       set current_step = current_step + 1,
           last_sent_at = now(),
           completed_at = now(),
           status = 'completed'
     where id = p_enrollment_id;
    return jsonb_build_object('status','completed');
  end if;
end;
$$;

-- Lead-form read: the active (else most-recent) enrollment for a lead, with
-- progress, so the detail page can render a "Campaign" card. Sent messages
-- themselves already appear on the lead timeline (maintenance.lead_activities).
create or replace function public.get_lead_campaign(p_lead_id uuid)
  returns jsonb
  language sql security definer
  set search_path = public, comms
as $$
  select to_jsonb(x) from (
    select e.id as enrollment_id, e.campaign_key, c.name as campaign_name,
           e.status, e.current_step,
           (select count(*) from comms.campaign_steps s where s.campaign_key = e.campaign_key) as total_steps,
           e.next_due_at, e.last_sent_at, e.enrolled_at
      from comms.campaign_enrollments e
      join comms.campaigns c on c.key = e.campaign_key
     where e.lead_id = p_lead_id
     order by (e.status = 'active') desc, e.enrolled_at desc
     limit 1
  ) x;
$$;

-- Lock all of these to the service-role client (the only caller). CREATE FUNCTION
-- grants EXECUTE to PUBLIC by default; revoke that so anon/authenticated cannot
-- enroll/advance via the data API.
revoke execute on function
  public.enroll_in_campaign(text, uuid, bigint, boolean),
  public.cancel_campaign_enrollments(uuid, bigint, text, text),
  public.get_due_campaign_enrollments(int, text),
  public.advance_campaign_enrollment(uuid),
  public.get_lead_campaign(uuid)
  from public, anon, authenticated;
grant execute on function
  public.enroll_in_campaign(text, uuid, bigint, boolean),
  public.cancel_campaign_enrollments(uuid, bigint, text, text),
  public.get_due_campaign_enrollments(int, text),
  public.advance_campaign_enrollment(uuid),
  public.get_lead_campaign(uuid)
  to service_role;
