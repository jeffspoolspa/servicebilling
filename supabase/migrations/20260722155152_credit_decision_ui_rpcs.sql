-- UI surface for the credit decision record (pairs with 20260722150834).
-- Pattern: reads via a public view, writes via SECURITY DEFINER RPCs called
-- with the anon client (same as override_credit_review).

-- 1. read view ----------------------------------------------------------------

create or replace view public.billing_invoice_credit_decisions as
select d.id, d.qbo_invoice_id, d.credit_id, d.amount, d.unapplied_at_decision,
       d.state, d.reason, d.decided_by, d.applied_via,
       d.created_at, d.decided_at, d.applied_at,
       cp.type   as credit_type,
       cp.ref_num, cp.memo, cp.txn_date,
       cp.unapplied_amt as current_unapplied_amt
from billing.invoice_credit_decisions d
left join billing.customer_payments cp on cp.qbo_payment_id = d.credit_id;

grant select on public.billing_invoice_credit_decisions to anon, authenticated, service_role;

-- 2. reject one candidate ------------------------------------------------------

create or replace function public.reject_credit_decision(
  p_qbo_invoice_id text, p_credit_id text, p_note text default null)
returns boolean
language plpgsql security definer
set search_path to 'public', 'billing'
as $$
declare v_hit int;
begin
  update billing.invoice_credit_decisions
     set state = 'rejected', decided_by = 'user', decided_at = now(),
         reason = coalesce(p_note, reason)
   where qbo_invoice_id = p_qbo_invoice_id and credit_id = p_credit_id
     and state = 'candidate';
  get diagnostics v_hit = row_count;
  return v_hit > 0;
end;
$$;

grant execute on function public.reject_credit_decision(text, text, text)
  to anon, authenticated, service_role;

-- 3. mark applied (called by the apply-credit route after QBO acked; the
--    refresh_payment webhook maintenance is the async backstop) ---------------

create or replace function public.mark_credit_decision_applied(
  p_qbo_invoice_id text, p_credit_id text, p_amount numeric default null)
returns boolean
language plpgsql security definer
set search_path to 'public', 'billing'
as $$
declare v_hit int;
begin
  update billing.invoice_credit_decisions
     set state = 'applied', decided_by = 'user', applied_via = 'manual',
         amount = coalesce(p_amount, amount),
         decided_at = now(), applied_at = now()
   where qbo_invoice_id = p_qbo_invoice_id and credit_id = p_credit_id
     and state = 'candidate';
  get diagnostics v_hit = row_count;
  return v_hit > 0;
end;
$$;

grant execute on function public.mark_credit_decision_applied(text, text, numeric)
  to anon, authenticated, service_role;

-- 4. complete review: close remaining candidates, stamp the pre-process row,
--    and reuse the existing override machinery for the status transition ------

create or replace function public.complete_credit_review(
  p_qbo_invoice_id text, p_note text default null)
returns boolean
language plpgsql security definer
set search_path to 'public', 'billing'
as $$
begin
  -- every remaining open candidate ends with an outcome (the sealed snapshot)
  update billing.invoice_credit_decisions
     set state = 'rejected', decided_by = 'review_complete', decided_at = now()
   where qbo_invoice_id = p_qbo_invoice_id and state = 'candidate';

  insert into billing.invoice_pre_process (qbo_invoice_id, state, reviewed_at)
  values (p_qbo_invoice_id, 'deciding', now())
  on conflict (qbo_invoice_id) do update set
    reviewed_at = now(), updated_at = now();

  -- transition machinery: same path the Override button used (sets
  -- credit_review_overridden_at; recheck flips to ready_to_process only if
  -- every other criterion is clean)
  return public.override_credit_review(p_qbo_invoice_id, p_note);
end;
$$;

grant execute on function public.complete_credit_review(text, text)
  to anon, authenticated, service_role;
