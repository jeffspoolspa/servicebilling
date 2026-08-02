-- maintenance.events — the history plane for the maintenance context (ADR 010).
-- One append-only stream PER BOUNDED CONTEXT (billing has its own); maintenance
-- earns one on the same terms: its truth is a mutable mirror of ION, so we need
-- a record of what we PROVED changed, separate from the state we cache.
-- Same envelope as billing.events on purpose. `aggregate` discriminates.
create table if not exists maintenance.events (
  seq           bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  aggregate     text not null,
  aggregate_id  text not null,
  type          text not null,
  actor         text not null default 'auto',
  participants  text[] not null default '{}',
  payload       jsonb not null default '{}'
);
comment on table maintenance.events is
  'Maintenance domain event stream (ADR 010). Append-only, immutable, permanent. State lives in maintenance.tasks/task_schedules — this is history, audit, and the fold used to verify the mirror, never the source of state.';
create index if not exists maintenance_events_aggregate_idx on maintenance.events (aggregate, aggregate_id, seq);
create index if not exists maintenance_events_participants_idx on maintenance.events using gin (participants);
create index if not exists maintenance_events_occurred_idx on maintenance.events (occurred_at desc);

create or replace function maintenance.events_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'maintenance.events is append-only (attempted %)', tg_op;
end;
$$;
drop trigger if exists maintenance_events_no_update on maintenance.events;
create trigger maintenance_events_no_update
  before update or delete or truncate on maintenance.events
  for each statement execute function maintenance.events_immutable();

create or replace function maintenance.append_event(
  p_aggregate text, p_aggregate_id text, p_type text,
  p_payload jsonb default '{}', p_actor text default 'auto',
  p_participants text[] default '{}', p_occurred_at timestamptz default now()
) returns bigint
language plpgsql security definer as $$
declare v_seq bigint;
begin
  insert into maintenance.events
    (occurred_at, aggregate, aggregate_id, type, actor, participants, payload)
  values (p_occurred_at, p_aggregate, p_aggregate_id, p_type, p_actor,
     (select array(select distinct unnest(p_participants || array[p_aggregate || ':' || p_aggregate_id]))),
     p_payload)
  returning seq into v_seq;
  return v_seq;
end;
$$;
comment on function maintenance.append_event is
  'The only writer for maintenance.events. Stamps the aggregate as a participant of its own fact.';
