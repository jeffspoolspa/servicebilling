-- lead_events: append-only, typed lifecycle log for a lead — answers when / who /
-- how (incl. how a lead was accepted and who completed it).
--
-- Module: docs/flows/lead-intake-to-conversion (proposer)
-- Schema: maintenance (lead is a maintenance entity; already PostgREST-exposed)
-- Shared types read: public.leads, maintenance.residential_lead_details / commercial_lead_details
--
-- DESIGN (decided in-thread)
-- A single mutable status column only remembers the LATEST stage, so quoted/accepted
-- timing + actor were unrecoverable. We record each lifecycle event as a typed row
-- with an actor (who) and a context jsonb (how / with whom). Messages are NOT copied
-- here — they live in public.communications; the lead timeline view UNIONs the two.
--
-- Capture is "RPC actor + trigger safety net":
--   * A trigger on the child detail tables records EVERY status change (when/from/to),
--     so a transition is never silently lost.
--   * The actor is read from transaction-local session GUCs (app.actor_*) that the
--     transition RPCs set right before they change status (added in a follow-up
--     migration). Unset → actor_type='system' (captured, actor unknown).
--   * Non-status events (notes, contact edits) are written explicitly via log_lead_event.

-- ── Table ────────────────────────────────────────────────────────────────────
create table if not exists maintenance.lead_events (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.leads(id) on delete cascade,
  event_type   text not null,        -- 'created','quoted','accepted','converted','note','contact_updated',...
  from_status  text,
  to_status    text,
  actor_type   text not null default 'system' check (actor_type in ('staff','customer','system')),
  actor_id     text,                 -- authUserId (staff) | account_id (customer) | null (system)
  actor_label  text,                 -- email/display name, for quick rendering
  body         text,                 -- free text: the note itself, or a human description of the event
  context      jsonb not null default '{}'::jsonb,  -- { via:'web_link'|'phone'|'in_office', completed_by, ... }
  created_at   timestamptz not null default now()
);
create index if not exists lead_events_lead_idx
  on maintenance.lead_events (lead_id, created_at desc);

alter table maintenance.lead_events enable row level security;  -- RPC + service-role only

-- ── Trigger: capture every status transition, enriched from session GUCs ──────
create or replace function maintenance.tg_log_lead_status_event()
  returns trigger
  language plpgsql security definer
  set search_path = public, maintenance
as $$
declare
  v_from text;
  v_to   text;
  v_evt  text;
begin
  if tg_op = 'INSERT' then
    v_from := null; v_to := NEW.status; v_evt := 'created';
  else
    if NEW.status is not distinct from OLD.status then
      return NEW;                    -- not a status change; ignore
    end if;
    v_from := OLD.status; v_to := NEW.status; v_evt := NEW.status;
  end if;

  insert into maintenance.lead_events
    (lead_id, event_type, from_status, to_status, actor_type, actor_id, actor_label, context)
  values (
    NEW.lead_id, v_evt, v_from, v_to,
    coalesce(nullif(current_setting('app.actor_type',  true), ''), 'system'),
    nullif(current_setting('app.actor_id',    true), ''),
    nullif(current_setting('app.actor_label', true), ''),
    coalesce(nullif(current_setting('app.event_context', true), '')::jsonb, '{}'::jsonb)
  );
  return NEW;
end;
$$;

drop trigger if exists trg_resi_lead_status_event on maintenance.residential_lead_details;
create trigger trg_resi_lead_status_event
  after insert or update of status on maintenance.residential_lead_details
  for each row execute function maintenance.tg_log_lead_status_event();

drop trigger if exists trg_comm_lead_status_event on maintenance.commercial_lead_details;
create trigger trg_comm_lead_status_event
  after insert or update of status on maintenance.commercial_lead_details
  for each row execute function maintenance.tg_log_lead_status_event();

-- ── Helper: explicit write for NON-status events (notes, contact edits, ...) ──
create or replace function public.log_lead_event(
  p_lead_id     uuid,
  p_event_type  text,
  p_actor_type  text   default 'system',
  p_actor_id    text   default null,
  p_actor_label text   default null,
  p_body        text   default null,
  p_context     jsonb  default '{}'::jsonb,
  p_from_status text   default null,
  p_to_status   text   default null
) returns uuid
  language plpgsql security definer
  set search_path = public, maintenance
as $$
declare v_id uuid;
begin
  insert into maintenance.lead_events
    (lead_id, event_type, from_status, to_status, actor_type, actor_id, actor_label, body, context)
  values (p_lead_id, p_event_type, p_from_status, p_to_status,
          coalesce(p_actor_type,'system'), p_actor_id, p_actor_label, p_body, coalesce(p_context,'{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

-- App + service-role only. (add_lead_note will be repointed to call this with event_type='note'.)
revoke execute on function public.log_lead_event(uuid, text, text, text, text, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.log_lead_event(uuid, text, text, text, text, text, jsonb, text, text)
  to service_role;
