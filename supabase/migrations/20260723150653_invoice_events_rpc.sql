-- ADR 010: the invoice timeline query — home events plus events naming the
-- invoice as a participant (payment applications, charges), one indexed call.
-- Applied 2026-07-23 via MCP apply_migration (recorded version 20260723150653).
create or replace function public.invoice_events(p_qbo_invoice_id text)
returns table (
  seq bigint, occurred_at timestamptz, aggregate text, aggregate_id text,
  type text, actor text, participants text[], payload jsonb
)
language sql stable security definer set search_path = billing, public as $$
  select e.seq, e.occurred_at, e.aggregate, e.aggregate_id,
         e.type, e.actor, e.participants, e.payload
  from billing.events e
  where (e.aggregate = 'invoice' and e.aggregate_id = p_qbo_invoice_id)
     or e.participants @> array['invoice:' || p_qbo_invoice_id]
  order by e.occurred_at desc, e.seq desc
$$;
grant execute on function public.invoice_events(text) to anon, authenticated, service_role;
