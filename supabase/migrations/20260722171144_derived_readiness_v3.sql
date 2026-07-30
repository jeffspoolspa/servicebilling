-- Derived readiness v3 (Carter 2026-07-22): pre-processing is an EFFECTOR
-- (refresh + reversible effects + run log); ALL status derives. The rule list
-- lives in ONE function — billing.invoice_ready() — used by the state view,
-- the charge-enqueue trigger, and the claim guard. Per-rule booleans in the
-- view (indicators sit next to the fields they describe); no reasons array.
--
-- Credits: candidates are DERIVED (open credits minus decided), decisions are
-- append-only EVENTS: proposed (matcher recommendation) / applied / rejected.
-- 'candidate' and 'stale' retire (legacy rows keep validity; treated as
-- non-terminal). A credit consumed or applied elsewhere simply drops out of
-- the open-credit set — no maintenance, decision rows are never touched.

-- 1. decisions become events: widen then re-narrow the state vocabulary -----

alter table billing.invoice_credit_decisions
  drop constraint if exists invoice_credit_decisions_state_check;
alter table billing.invoice_credit_decisions
  add constraint invoice_credit_decisions_state_check
  check (state in ('proposed','applied','rejected','candidate','stale'));
-- 'candidate'/'stale' accepted for legacy rows only; writers use
-- proposed/applied/rejected from now on.

-- 2. the one readiness function --------------------------------------------
-- Rule list (Carter):
--   1. a completed pre-process run that didn't fail
--   2. no open credit for the customer lacking a terminal decision here
--   3. invoice subtotal matches the WO subtotal
--   4. memo present, qbo_class present, due_date today or future
--   5. a determined payment route (charge route needs a concrete PM;
--      email route needs none)

create or replace function billing.invoice_ready(p_qbo_invoice_id text)
returns boolean
language sql stable
set search_path to 'billing', 'public'
as $$
  select
    -- 1. completed, non-failed pre-process effects
    i.pre_processed_at is not null
    and coalesce(i.enrichment_ok, false)
    -- 2. credits settled: every live open credit has a terminal decision
    and not exists (
      select 1 from billing.customer_payments cp
      where cp.qbo_customer_id = i.qbo_customer_id
        and cp.unapplied_amt > 0
        and (cp.txn_date is null or cp.txn_date >= (now() - interval '6 months')::date)
        and (cp.memo is null or cp.memo !~* 'maint')
        and not exists (
          select 1 from billing.invoice_credit_decisions d
          where d.qbo_invoice_id = i.qbo_invoice_id
            and d.credit_id = cp.qbo_payment_id
            and d.state in ('applied','rejected')))
    -- 3. subtotal drift check between the two external systems
    and abs(coalesce(i.subtotal, 0) - coalesce(w.sub_total, 0)) < 0.01
    -- 4. enrichment fields present and the invoice is current
    and i.memo is not null
    and i.qbo_class is not null
    and (i.due_date is null or i.due_date >= current_date)
    -- 5. payment route determined
    and (
      billing.resolve_preferred_payment_type(i.qbo_customer_id,
        concat_ws(' ', w.work_description, w.technician_instructions, w.corrective_action))
        = 'email'
      or billing.pick_target_payment_method(i.qbo_customer_id,
           billing.resolve_preferred_payment_type(i.qbo_customer_id,
             concat_ws(' ', w.work_description, w.technician_instructions, w.corrective_action)))
         is not null)
  from billing.invoices i
  join public.work_orders w on w.qbo_invoice_id = i.qbo_invoice_id
  where i.qbo_invoice_id = p_qbo_invoice_id
    and w.billable is true and w.skipped_at is null
$$;

-- 3. state view v3: per-rule booleans (indicators live next to the fields) --

drop view if exists public.service_billing_state;
drop view if exists billing.v_service_billing_state;

create view billing.v_service_billing_state as
select
  i.qbo_invoice_id,
  i.qbo_customer_id,
  i.balance,
  i.subtotal,
  i.fetched_at                            as invoice_verified_at,
  -- per-rule indicators (each named for the field it describes)
  (i.pre_processed_at is not null
     and coalesce(i.enrichment_ok, false)) as run_complete,
  coalesce(open_cr.n, 0) = 0              as credits_settled,
  abs(coalesce(i.subtotal,0) - coalesce(w.sub_total,0)) < 0.01 as subtotal_matches,
  i.memo is not null                      as memo_present,
  i.qbo_class is not null                 as class_present,
  (i.due_date is null or i.due_date >= current_date) as due_date_ok,
  route.preferred                         as payment_route,
  (route.preferred = 'email' or route.target_pm is not null) as pm_resolved,
  billing.invoice_ready(i.qbo_invoice_id) as ready,
  -- credit decision rollup (events)
  coalesce(open_cr.n, 0)                  as undecided_credit_count,
  coalesce(dec.proposed_count, 0)         as proposed_count,
  coalesce(dec.applied_count, 0)          as applied_count,
  coalesce(dec.rejected_count, 0)         as rejected_count,
  coalesce(dec.applied_amount, 0)         as credits_applied_amount,
  -- provenance + context
  pp.credits_verified_at,
  pp.pm_verified_at,
  pp.reviewed_at,
  i.pre_processed_at,
  i.pre_process_stage,
  s.derived_status,
  i.needs_review_reason
from billing.invoices i
join billing.v_invoice_status s using (qbo_invoice_id)
left join public.work_orders w on w.qbo_invoice_id = i.qbo_invoice_id
left join billing.invoice_pre_process pp on pp.qbo_invoice_id = i.qbo_invoice_id
left join lateral (
  select count(*) as n
  from billing.customer_payments cp
  where cp.qbo_customer_id = i.qbo_customer_id
    and cp.unapplied_amt > 0
    and (cp.txn_date is null or cp.txn_date >= (now() - interval '6 months')::date)
    and (cp.memo is null or cp.memo !~* 'maint')
    and not exists (
      select 1 from billing.invoice_credit_decisions d
      where d.qbo_invoice_id = i.qbo_invoice_id
        and d.credit_id = cp.qbo_payment_id
        and d.state in ('applied','rejected'))
) open_cr on true
left join lateral (
  select
    count(*) filter (where state in ('proposed','candidate')) as proposed_count,
    count(*) filter (where state = 'applied')                 as applied_count,
    count(*) filter (where state = 'rejected')                as rejected_count,
    coalesce(sum(amount) filter (where state = 'applied'), 0) as applied_amount
  from billing.invoice_credit_decisions d
  where d.qbo_invoice_id = i.qbo_invoice_id
) dec on true
left join lateral (
  select billing.resolve_preferred_payment_type(i.qbo_customer_id,
           concat_ws(' ', w.work_description, w.technician_instructions, w.corrective_action)) as preferred,
         billing.pick_target_payment_method(i.qbo_customer_id,
           billing.resolve_preferred_payment_type(i.qbo_customer_id,
             concat_ws(' ', w.work_description, w.technician_instructions, w.corrective_action))) as target_pm
) route on true;

create view public.service_billing_state as
  select * from billing.v_service_billing_state;

grant select on public.service_billing_state to anon, authenticated, service_role;

-- 4. transitions: decisions-write enqueues the charge when ready ------------
-- Thin trigger, one insert, mirrors trg_enqueue_service_charge semantics.
-- The charge worker re-verifies at claim (invoice_ready + credit guard +
-- fresh balance) — the queue row is an invitation, not a command.

create or replace function billing.enqueue_charge_if_ready()
returns trigger
language plpgsql security definer
set search_path to 'billing'
as $$
begin
  if billing.invoice_ready(new.qbo_invoice_id) then
    insert into billing.service_charge_queue (qbo_invoice_id)
    values (new.qbo_invoice_id)
    on conflict (qbo_invoice_id) where finished_at is null
    do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enqueue_charge_on_decision on billing.invoice_credit_decisions;
create trigger trg_enqueue_charge_on_decision
  after insert or update of state on billing.invoice_credit_decisions
  for each row
  when (new.state in ('applied','rejected'))
  execute function billing.enqueue_charge_if_ready();
