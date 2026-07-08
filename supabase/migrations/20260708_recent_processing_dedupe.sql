-- The Processing queue sheet showed duplicate rows after a re-run: the
-- attempts side of maint_billing_recent_processing left-joined
-- maint_process_queue with only a 2h window, so a period re-queued within
-- the window (failed email fixed -> reprocessed) fanned each attempt out
-- once per queue row. Join only the LATEST queue entry per period.

create or replace function public.maint_billing_recent_processing()
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
  left join lateral (
    select id from billing_audit.maint_process_queue q
    where q.period_id = a.period_id and q.enqueued_at > now() - interval '2 hours'
    order by q.enqueued_at desc limit 1
  ) q on true
  union all
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
