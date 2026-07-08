-- Processing-queue visibility for the Ready-to-Process UI.
--
-- Attempts rows are only created as the run REACHES each invoice, so the
-- Processing chip could never show the full queue. process_maint_period now
-- seeds one maint_process_queue row per period at run start (live runs only)
-- and stamps started/finished as it works; maint_billing_recent_processing
-- unions the unfinished queue rows in as attempt_status='queued' and gains
-- channel + email_sent so the UI can say charged (autopay) vs sent (email).

create table if not exists billing_audit.maint_process_queue (
  id bigint generated always as identity primary key,
  period_id uuid not null references billing_audit.task_billing_periods(id) on delete cascade,
  enqueued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- one active queue entry per period; history is fine once finished
create unique index if not exists maint_process_queue_active
  on billing_audit.maint_process_queue (period_id) where finished_at is null;
create index if not exists maint_process_queue_recent
  on billing_audit.maint_process_queue (enqueued_at desc);

-- return type changes (new columns) -> drop + recreate
drop function if exists public.maint_billing_recent_processing();

create function public.maint_billing_recent_processing()
returns table(
  period_id uuid,
  customer_name text,
  doc_number text,
  attempt_status text,
  channel text,
  email_sent boolean,
  charge_amount numeric,
  qbo_payment_id text,
  error_message text,
  attempted_at timestamptz,
  processing_status text,
  qbo_balance numeric,
  queue_order bigint
)
language sql stable security definer
set search_path to 'billing', 'public'
as $function$
  with attempts as (
    select distinct on (a.qbo_invoice_id)
           tbp.id as period_id, c.display_name as customer_name, a.invoice_number as doc_number,
           a.status as attempt_status, a.channel, a.email_sent,
           a.charge_amount, a.qbo_payment_id, a.error_message, a.attempted_at,
           tbp.processing_status, i.balance as qbo_balance
    from billing.processing_attempts a
    join billing_audit.task_billing_periods tbp on tbp.qbo_invoice_id = a.qbo_invoice_id
    left join public."Customers" c on c.qbo_customer_id = tbp.qbo_customer_id
    left join billing.invoices i on i.qbo_invoice_id = a.qbo_invoice_id
    where a.stage = 'maint'
      and coalesce(a.dry_run, false) = false
      and a.attempted_at > now() - interval '2 hours'
      and (a.attempted_at > now() - interval '10 minutes'
           or a.status in ('pending', 'charge_succeeded', 'charge_uncertain'))
    order by a.qbo_invoice_id, a.attempted_at desc
  )
  select a.period_id, a.customer_name, a.doc_number, a.attempt_status,
         a.channel, a.email_sent, a.charge_amount, a.qbo_payment_id,
         a.error_message, a.attempted_at, a.processing_status, a.qbo_balance,
         q.id as queue_order
  from attempts a
  left join billing_audit.maint_process_queue q
    on q.period_id = a.period_id and q.enqueued_at > now() - interval '2 hours'
  union all
  -- seeded but not yet attempted: the waiting part of the queue
  select tbp.id, c.display_name, i.doc_number,
         'queued', null, null, null, null, null,
         q.enqueued_at, tbp.processing_status, i.balance,
         q.id
  from billing_audit.maint_process_queue q
  join billing_audit.task_billing_periods tbp on tbp.id = q.period_id
  left join public."Customers" c on c.qbo_customer_id = tbp.qbo_customer_id
  left join billing.invoices i on i.qbo_invoice_id = tbp.qbo_invoice_id
  where q.finished_at is null
    and q.enqueued_at > now() - interval '2 hours'
    and not exists (
      select 1 from billing.processing_attempts a
      where a.qbo_invoice_id = tbp.qbo_invoice_id
        and a.stage = 'maint' and coalesce(a.dry_run, false) = false
        and a.attempted_at > q.enqueued_at
    );
$function$;
