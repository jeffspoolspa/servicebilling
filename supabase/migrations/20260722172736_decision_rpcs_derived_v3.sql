-- Decision RPCs under derived readiness v3: undecided credits have NO stored
-- row, so user decisions INSERT (or resolve an open proposed/candidate row);
-- complete_credit_review closes every DERIVED-undecided credit for the
-- invoice's customer (rejected rows), stamps reviewed_at, and reuses the
-- override machinery. NOTE: reject/mark bodies as first applied used a
-- union-all/limit-1 fallback with unspecified ordering; superseded in the
-- SAME deploy by 20260722172809_decision_rpcs_scalar_fix (scalar subqueries)
-- — see that file for the live definitions of reject_credit_decision and
-- mark_credit_decision_applied.

create or replace function public.complete_credit_review(
  p_qbo_invoice_id text, p_note text default null)
returns boolean
language plpgsql security definer
set search_path to 'public', 'billing'
as $$
begin
  insert into billing.invoice_credit_decisions
    (qbo_invoice_id, credit_id, amount, unapplied_at_decision, state, reason, decided_by, decided_at)
  select p_qbo_invoice_id, cp.qbo_payment_id, cp.unapplied_amt, cp.unapplied_amt,
         'rejected', p_note, 'review_complete', now()
  from billing.customer_payments cp
  join billing.invoices i on i.qbo_customer_id = cp.qbo_customer_id
  where i.qbo_invoice_id = p_qbo_invoice_id
    and cp.unapplied_amt > 0
    and (cp.txn_date is null or cp.txn_date >= (now() - interval '6 months')::date)
    and (cp.memo is null or cp.memo !~* 'maint')
  on conflict (qbo_invoice_id, credit_id) do update set
    state = 'rejected', decided_by = 'review_complete', decided_at = now()
  where billing.invoice_credit_decisions.state in ('proposed','candidate');

  insert into billing.invoice_pre_process (qbo_invoice_id, state, reviewed_at)
  values (p_qbo_invoice_id, 'deciding', now())
  on conflict (qbo_invoice_id) do update set
    reviewed_at = now(), updated_at = now();

  return public.override_credit_review(p_qbo_invoice_id, p_note);
end;
$$;
