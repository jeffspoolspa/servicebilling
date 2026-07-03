-- Poll surface for the preprocess-queue chip: live queue rows (waiting /
-- running / recently finished) with customer names, newest work first.

create or replace function public.maint_billing_preprocess_queue()
returns table (
  qbo_customer_id text,
  customer_name   text,
  billing_month   date,
  enqueued_at     timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  error           text,
  attempts        int
)
language sql stable security definer
set search_path = billing_audit, public
as $$
  select q.qbo_customer_id, c.display_name, q.billing_month,
         q.enqueued_at, q.started_at, q.finished_at, q.error, q.attempts::int
  from maint_preprocess_queue q
  left join public."Customers" c on c.qbo_customer_id = q.qbo_customer_id
  where q.finished_at is null
     or q.finished_at > now() - interval '3 minutes'
  order by (q.started_at is not null and q.finished_at is null) desc,
           q.finished_at desc nulls last,
           q.enqueued_at asc;
$$;

revoke all on function public.maint_billing_preprocess_queue() from public, anon;
grant execute on function public.maint_billing_preprocess_queue() to authenticated, service_role;

notify pgrst, 'reload schema';
