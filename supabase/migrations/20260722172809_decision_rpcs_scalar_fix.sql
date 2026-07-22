-- Live definitions of the per-credit decision RPCs (supersedes the bodies in
-- 20260722172736): INSERT for derived-undecided credits, resolve open
-- proposed/candidate rows on conflict; scalar subqueries for the frozen
-- unapplied_at_decision context.

create or replace function public.reject_credit_decision(
  p_qbo_invoice_id text, p_credit_id text, p_note text default null)
returns boolean
language plpgsql security definer
set search_path to 'public', 'billing'
as $$
begin
  insert into billing.invoice_credit_decisions
    (qbo_invoice_id, credit_id, amount, unapplied_at_decision, state, reason, decided_by, decided_at)
  values (p_qbo_invoice_id, p_credit_id,
          coalesce((select unapplied_amt from billing.customer_payments
                    where qbo_payment_id = p_credit_id), 0),
          (select unapplied_amt from billing.customer_payments
           where qbo_payment_id = p_credit_id),
          'rejected', p_note, 'user', now())
  on conflict (qbo_invoice_id, credit_id) do update set
    state = 'rejected', reason = coalesce(p_note, billing.invoice_credit_decisions.reason),
    decided_by = 'user', decided_at = now()
  where billing.invoice_credit_decisions.state in ('proposed','candidate');
  return found;
end;
$$;

create or replace function public.mark_credit_decision_applied(
  p_qbo_invoice_id text, p_credit_id text, p_amount numeric default null)
returns boolean
language plpgsql security definer
set search_path to 'public', 'billing'
as $$
begin
  insert into billing.invoice_credit_decisions
    (qbo_invoice_id, credit_id, amount, unapplied_at_decision, state,
     decided_by, applied_via, decided_at, applied_at)
  values (p_qbo_invoice_id, p_credit_id,
          coalesce(p_amount,
                   (select unapplied_amt from billing.customer_payments
                    where qbo_payment_id = p_credit_id), 0),
          (select unapplied_amt from billing.customer_payments
           where qbo_payment_id = p_credit_id),
          'applied', 'user', 'manual', now(), now())
  on conflict (qbo_invoice_id, credit_id) do update set
    state = 'applied', amount = coalesce(p_amount, billing.invoice_credit_decisions.amount),
    decided_by = 'user', applied_via = 'manual', decided_at = now(), applied_at = now()
  where billing.invoice_credit_decisions.state in ('proposed','candidate');
  return found;
end;
$$;
