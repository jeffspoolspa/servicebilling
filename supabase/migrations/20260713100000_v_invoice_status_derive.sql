-- Invoice status derives; the engines just record state (ADR 009 §E,
-- WORKFLOW_EXECUTION "events out, state derives", Carter 2026-07-13).
--
-- billing.v_invoice_status is the ONE home for the status rules. Contexts
-- differ on what "done" means (service billing: paid AND sent; a sent-only
-- invoice with a balance is OPEN AR, watched separately) — so the view
-- exposes both the facts (is_paid / is_sent / last_attempt_status) and the
-- service-billing derived_status, and other contexts define their own
-- readings over the same facts instead of a new stamped column.
--
-- The tab views (v_billing_queue / v_needs_attention / v_processed) stop
-- filtering on the STAMPED billing_status for terminal states and read the
-- derivation: a refund-reopened invoice falls OUT of processed by fact; a
-- sent-but-unpaid email-route or declined invoice moves to open AR instead
-- of masquerading as processed or clogging the ready queue.
-- (Applied to prod 2026-07-13 as v_invoice_status_derive +
-- v_processed_ts_fallback; day-one derivation deltas: 92 stamped-processed
-- invoices reclassified open_ar, 10 unstamped paid+sent became processed.)

-- 1. the rules home -----------------------------------------------------------

create or replace view billing.v_invoice_status as
select i.qbo_invoice_id,
       (i.balance is not null and i.balance <= 0)      as is_paid,
       (i.email_status = 'EmailSent')                  as is_sent,
       la.status                                       as last_attempt_status,
       i.billing_status                                 as stamped_status,
       i.needs_review_reason,
       case
         -- terminal: money collected AND customer has the document
         when (i.balance is not null and i.balance <= 0)
              and i.email_status = 'EmailSent'
           then 'processed'
         -- money moved or moving — never reclassify under an in-flight attempt
         when la.status in ('payment_orphan', 'charge_uncertain',
                            'charge_succeeded', 'pending')
           then coalesce(nullif(i.billing_status, 'processed'), 'needs_review')
         -- delivered, balance open, and nothing left for US to do:
         -- email-route months and declined (pay-it-yourself) -> open AR
         when i.email_status = 'EmailSent'
              and (i.balance is null or i.balance > 0)
              and (i.preferred_payment_type = 'email'
                   or la.status = 'charge_declined')
           then 'open_ar'
         -- pipeline stages stay as recorded by pre-process + gates
         else i.billing_status
       end as derived_status
from billing.invoices i
left join lateral (
  select a.status
  from billing.processing_attempts a
  where a.qbo_invoice_id = i.qbo_invoice_id
    and a.stage = 'process'
    and coalesce(a.dry_run, false) = false
  order by a.attempted_at desc
  limit 1
) la on true;

-- 2. tab views read the derivation -------------------------------------------

create or replace view billing.v_billing_queue as
select w.wo_number, w.customer, w.type, w.sub_total, w.total_due, w.completed,
       w.assigned_to, w.office_name, w.employee_id,
       i.qbo_invoice_id, i.doc_number as invoice_number,
       s.derived_status as billing_status,
       i.payment_method, i.qbo_class, i.memo, i.statement_memo,
       i.subtotal as qbo_subtotal, i.balance as qbo_balance,
       i.email_status as qbo_email_status,
       i.preferred_payment_type, i.target_payment_method_id,
       cpm.type as target_pm_type, cpm.card_brand as target_pm_brand,
       cpm.last_four as target_pm_last_four,
       i.total_amt
from billing.invoices i
join billing.v_invoice_status s on s.qbo_invoice_id = i.qbo_invoice_id
join work_orders w on w.qbo_invoice_id = i.qbo_invoice_id
left join billing.customer_payment_methods cpm on cpm.id = i.target_payment_method_id
where s.derived_status = 'ready_to_process'
  and w.billable = true and w.skipped_at is null
order by w.completed desc nulls last;

create or replace view billing.v_needs_attention as
select w.wo_number, w.customer, w.type, w.sub_total, w.total_due, w.completed,
       w.assigned_to, w.office_name, w.employee_id,
       i.qbo_invoice_id, i.doc_number as invoice_number,
       s.derived_status as billing_status,
       i.needs_review_reason,
       i.payment_method, i.qbo_class, i.memo, i.statement_memo,
       i.subtotal_ok, i.enrichment_ok,
       i.subtotal as qbo_subtotal, i.balance as qbo_balance,
       i.email_status as qbo_email_status,
       i.preferred_payment_type, i.target_payment_method_id,
       cpm.type as target_pm_type, cpm.card_brand as target_pm_brand,
       cpm.last_four as target_pm_last_four,
       i.total_amt
from billing.invoices i
join billing.v_invoice_status s on s.qbo_invoice_id = i.qbo_invoice_id
join work_orders w on w.qbo_invoice_id = i.qbo_invoice_id
left join billing.customer_payment_methods cpm on cpm.id = i.target_payment_method_id
where s.derived_status = 'needs_review'
  and w.billable = true and w.skipped_at is null
order by w.completed desc nulls last;

create or replace view billing.v_processed as
select w.wo_number, w.customer, w.type, w.sub_total, w.total_due, w.completed,
       w.assigned_to, w.office_name, w.employee_id,
       i.qbo_invoice_id, i.doc_number as invoice_number,
       s.derived_status as billing_status,
       i.payment_method, i.qbo_class,
       -- engines no longer stamp processed_at; fall back to the last
       -- attempt's time, then the cache-refresh time
       coalesce(i.processed_at, la.attempted_at, i.fetched_at) as processed_at,
       i.subtotal as qbo_subtotal, i.balance as qbo_balance,
       i.email_status as qbo_email_status,
       i.preferred_payment_type, i.target_payment_method_id,
       i.total_amt
from billing.invoices i
join billing.v_invoice_status s on s.qbo_invoice_id = i.qbo_invoice_id
join work_orders w on w.qbo_invoice_id = i.qbo_invoice_id
left join lateral (
  select a.attempted_at from billing.processing_attempts a
  where a.qbo_invoice_id = i.qbo_invoice_id and a.stage = 'process'
    and coalesce(a.dry_run, false) = false
  order by a.attempted_at desc limit 1
) la on true
where s.derived_status = 'processed'
  and w.billable = true and w.skipped_at is null
order by coalesce(i.processed_at, la.attempted_at, i.fetched_at) desc nulls last;

-- 3. open AR: delivered, balance outstanding, ball in the customer's court ---

create or replace view billing.v_open_ar as
select w.wo_number, w.customer, w.type, w.completed,
       w.assigned_to, w.office_name, w.employee_id,
       i.qbo_invoice_id, i.doc_number as invoice_number,
       i.balance as qbo_balance, i.total_amt,
       i.txn_date, i.due_date,
       greatest(0, (current_date - i.due_date))::int as days_past_due,
       s.last_attempt_status,
       case when s.last_attempt_status = 'charge_declined'
            then 'declined' else 'invoiced' end as ar_reason,
       i.preferred_payment_type
from billing.invoices i
join billing.v_invoice_status s on s.qbo_invoice_id = i.qbo_invoice_id
join work_orders w on w.qbo_invoice_id = i.qbo_invoice_id
where s.derived_status = 'open_ar'
  and w.billable = true and w.skipped_at is null
order by i.due_date asc nulls last;

-- 4. public wrappers (PostgREST surface) --------------------------------------

create or replace view public.v_invoice_status as select * from billing.v_invoice_status;
create or replace view public.v_open_ar        as select * from billing.v_open_ar;
grant select on public.v_invoice_status to anon, authenticated, service_role;
grant select on public.v_open_ar        to anon, authenticated, service_role;
-- v_billing_queue / v_needs_attention / v_processed public wrappers already
-- exist (SELECT * pass-throughs, identical column lists preserved).
