-- Pool watchlist: one row per OPEN CONCERN on an active task (not a status
-- column on tasks — a pool can have several concurrent concerns, entries
-- carry priority/reason/source, and closed rows keep the history that
-- chronic-problem rules need). A task is "good" when it has no open rows.
--
-- Sources: 'manual' (review workbench / future UI) and 'rule' (scheduled
-- log-scanning rules — chronic low FC, algae-looking photos — insert rows
-- with rule_key; dedup via the open-unique index).

CREATE TABLE maintenance.watch_reasons (
  key   text PRIMARY KEY,
  label text NOT NULL
);
INSERT INTO maintenance.watch_reasons VALUES
  ('watch',          'General watch'),
  ('green_pool',     'Green pool'),
  ('equipment_down', 'Equipment down'),
  ('low_chlorine',   'Chronic low chlorine');

CREATE TABLE maintenance.task_watchlist (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id       uuid NOT NULL REFERENCES maintenance.tasks(id),
  reason        text NOT NULL REFERENCES maintenance.watch_reasons(key),
  priority      smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3), -- 1=high
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'rule')),
  rule_key      text,           -- which rule fired, for source='rule'
  note          text,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_note text
);
-- one OPEN entry per (task, reason); re-flagging while open is a no-op,
-- re-flagging after resolve opens a fresh row (the history)
CREATE UNIQUE INDEX idx_task_watchlist_open
  ON maintenance.task_watchlist (task_id, reason) WHERE resolved_at IS NULL;
CREATE INDEX idx_task_watchlist_task ON maintenance.task_watchlist (task_id);
GRANT SELECT ON maintenance.watch_reasons, maintenance.task_watchlist TO authenticated, service_role;

-- add entries for a customer-month's billing periods (the workbench grain)
create or replace function public.maint_watchlist_add(
  p_period_ids uuid[],
  p_reason text,
  p_priority int default 2,
  p_note text default null
) returns int
language sql security definer
set search_path = maintenance, billing_audit, public
as $$
  with ins as (
    insert into maintenance.task_watchlist (task_id, reason, priority, note)
    select distinct tbp.task_id, p_reason, p_priority, p_note
    from billing_audit.task_billing_periods tbp
    where tbp.id = any(p_period_ids)
    on conflict (task_id, reason) where resolved_at is null do nothing
    returning 1
  ) select coalesce(count(*), 0)::int from ins;
$$;

create or replace function public.maint_watchlist_resolve(
  p_id bigint,
  p_note text default null
) returns boolean
language sql security definer
set search_path = maintenance, public
as $$
  with upd as (
    update maintenance.task_watchlist
    set resolved_at = now(), resolved_note = p_note
    where id = p_id and resolved_at is null
    returning 1
  ) select exists(select 1 from upd);
$$;

-- open entries for a customer (workbench header chip + future watchlist page)
create or replace function public.maint_watchlist_for_customer(p_customer_id bigint)
returns table (id bigint, reason text, reason_label text, priority int,
               source text, rule_key text, note text, opened_at timestamptz)
language sql stable security definer
set search_path = maintenance, public
as $$
  select w.id, w.reason, r.label, w.priority::int, w.source, w.rule_key, w.note, w.opened_at
  from maintenance.task_watchlist w
  join maintenance.tasks t on t.id = w.task_id
  join maintenance.watch_reasons r on r.key = w.reason
  where t.customer_id = p_customer_id and w.resolved_at is null
  order by w.priority, w.opened_at;
$$;

revoke all on function public.maint_watchlist_add(uuid[], text, int, text) from public, anon;
revoke all on function public.maint_watchlist_resolve(bigint, text) from public, anon;
revoke all on function public.maint_watchlist_for_customer(bigint) from public, anon;
grant execute on function public.maint_watchlist_add(uuid[], text, int, text) to authenticated, service_role;
grant execute on function public.maint_watchlist_resolve(bigint, text) to authenticated, service_role;
grant execute on function public.maint_watchlist_for_customer(bigint) to authenticated, service_role;

-- fleet-wide open entries (maintenance dashboard watchlist table)
create or replace function public.maint_watchlist_open()
returns table (id bigint, customer_id bigint, customer_name text,
               service_name text, reason text, reason_label text,
               priority int, source text, rule_key text, note text,
               opened_at timestamptz)
language sql stable security definer
set search_path = maintenance, public
as $$
  select w.id, t.customer_id, c.display_name, vc.service_name,
         w.reason, r.label, w.priority::int, w.source, w.rule_key, w.note, w.opened_at
  from maintenance.task_watchlist w
  join maintenance.tasks t on t.id = w.task_id
  join maintenance.watch_reasons r on r.key = w.reason
  left join public."Customers" c on c.id = t.customer_id
  left join maintenance.v_task_class vc on vc.task_id = t.id
  where w.resolved_at is null
  order by w.priority, w.opened_at;
$$;
revoke all on function public.maint_watchlist_open() from public, anon;
grant execute on function public.maint_watchlist_open() to authenticated, service_role;

-- 2026-07-07b: priorities 1=critical 2=high 3=medium 4=low (default medium);
-- hard delete RPC for mistaken entries (resolve stays the normal off-ramp)
ALTER TABLE maintenance.task_watchlist DROP CONSTRAINT task_watchlist_priority_check;
ALTER TABLE maintenance.task_watchlist ADD CONSTRAINT task_watchlist_priority_check CHECK (priority BETWEEN 1 AND 4);
ALTER TABLE maintenance.task_watchlist ALTER COLUMN priority SET DEFAULT 3;
create or replace function public.maint_watchlist_delete(p_id bigint)
returns boolean
language sql security definer
set search_path = maintenance, public
as $$
  with del as (
    delete from maintenance.task_watchlist where id = p_id returning 1
  ) select exists(select 1 from del);
$$;
revoke all on function public.maint_watchlist_delete(bigint) from public, anon;
grant execute on function public.maint_watchlist_delete(bigint) to authenticated, service_role;
