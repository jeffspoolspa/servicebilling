-- Per-invoice event history (Carter 2026-07-22): the UI's History tab reads
-- ONE view unioning the event tables that already exist — pre-process runs
-- (service_preprocess_queue), charge/process attempts (processing_attempts),
-- credit decision events (invoice_credit_decisions), review completions
-- (invoice_pre_process.reviewed_at). No new logging; the logs were already
-- being written — this is just the read surface.

create or replace view billing.v_invoice_history as
select q.qbo_invoice_id,
       coalesce(q.finished_at, q.started_at, q.received_at) as at,
       'pre_process_run' as kind,
       case when q.error is not null then 'failed'
            when q.finished_at is not null then 'completed'
            when q.started_at is not null then 'running'
            else 'queued' end as outcome,
       q.error as detail,
       null::numeric as amount,
       null::text as actor
from billing.service_preprocess_queue q
union all
select a.qbo_invoice_id,
       a.attempted_at,
       'process_attempt_' || coalesce(a.stage, 'process'),
       a.status,
       left(coalesce(a.error_message, ''), 200),
       a.charge_amount,
       a.payment_method
from billing.processing_attempts a
where a.qbo_invoice_id is not null
  and coalesce(a.dry_run, false) = false
union all
select d.qbo_invoice_id,
       coalesce(d.decided_at, d.created_at),
       'credit_' || d.state,
       d.state,
       coalesce(d.reason, '') || ' (credit ' || d.credit_id || ')',
       d.amount,
       d.decided_by
from billing.invoice_credit_decisions d
union all
select pp.qbo_invoice_id,
       pp.reviewed_at,
       'review_completed',
       'completed',
       null,
       null,
       null
from billing.invoice_pre_process pp
where pp.reviewed_at is not null;

create or replace view public.invoice_history as
  select * from billing.v_invoice_history;

grant select on public.invoice_history to anon, authenticated, service_role;
