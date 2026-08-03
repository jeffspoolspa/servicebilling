-- The month's HISTORY: every event where the billing month is the
-- aggregate OR a participant. RULED: invoice events that arrive after the
-- invoice is created (credit checks, payment resolution — run PER invoice,
-- emitting their own events) carry the billing month as a participant, so
-- one query assembles the whole story.
create or replace function public.billing_month_history(p_month_id text)
returns table (
  seq          bigint,
  occurred_at  timestamptz,
  aggregate    text,
  aggregate_id text,
  type         text,
  actor        text,
  payload      jsonb
)
language sql stable security definer
set search_path = maintenance, public
as $$
  select e.seq, e.occurred_at, e.aggregate, e.aggregate_id, e.type, e.actor, e.payload
  from maintenance.events e
  where (e.aggregate = 'billing_month' and e.aggregate_id = p_month_id)
     or p_month_id = any(e.participants)
  order by e.occurred_at desc, e.seq desc
  limit 500;
$$;

revoke all on function public.billing_month_history(text) from public, anon;
grant execute on function public.billing_month_history(text) to authenticated, service_role;
