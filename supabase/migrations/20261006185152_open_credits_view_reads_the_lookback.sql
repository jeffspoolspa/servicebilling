-- public.billing_open_credits becomes the applicable-credit set the gate counts.
--
-- Module: docs/modules/service/billing.md
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- 20260925123718 moved the credit lookback to 24 months behind
-- billing.credit_lookback(), but the app kept its own 6-month literal in
-- lib/queries/dashboard.ts. The gate (invoice_gate_checks /
-- compute_billing_status) counted 6-24 month old credits the WO detail
-- table hid: invoices 8116043, 8116137, 8116125, 8116107, 8116108, 8105809
-- sat in credit_review with an empty Payments & credits table
-- (2026-10-06; hot-fixed in ee4d306 by copying the 24 into the app).
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- The app reads one view whose filter IS the gate's filter, so the UI
-- cannot re-derive the window or the maint exclusion again:
--   unapplied_amt > 0
--   txn_date null or inside billing.credit_lookback()
--   memo null or not matching 'maint'
-- The existing public.billing_open_credits was misnamed (every
-- customer_payments row, open or not) and has no readers (no app code,
-- no dependent views or functions), so it is redefined in place.
-- Owner postgres, no security_invoker: same as its billing_* siblings.
--
-- ─────────────────────────────────────────────────────────────────
-- WHAT WE KEEP / WHAT WE LOSE
-- ─────────────────────────────────────────────────────────────────
-- Lose: the unfiltered columns raw, fetched_at, matched_wo_number,
-- matched_amount, match_reason on this view (still on
-- public.billing_customer_payments). Keep: anon/authenticated SELECT.
--
-- Still debt: the four DB functions repeat this WHERE clause inline
-- (gate, compute_billing_status, reject-on-settle, complete_credit_review).

drop view if exists public.billing_open_credits;

create view public.billing_open_credits as
select cp.id,
       cp.qbo_payment_id,
       cp.qbo_customer_id,
       cp.type,
       cp.unapplied_amt,
       cp.total_amt,
       cp.txn_date,
       cp.ref_num,
       cp.memo
  from billing.customer_payments cp
 where cp.unapplied_amt > 0
   and (cp.txn_date is null or cp.txn_date >= (now() - billing.credit_lookback())::date)
   and (cp.memo is null or cp.memo !~* 'maint');

comment on view public.billing_open_credits is
  'Unapplied credits that count for service billing: the exact set the credit '
  'gate counts (billing.credit_lookback(), maint-scoped excluded). The app reads '
  'this; never re-derive the filter client-side.';

grant select on public.billing_open_credits to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
-- The view and the gate's own count must agree for every customer.
do $$
declare v_diff int;
begin
  select count(*) into v_diff from (
    select qbo_customer_id, count(*) from public.billing_open_credits group by 1
    except
    select cp.qbo_customer_id, count(*) from billing.customer_payments cp
     where cp.unapplied_amt > 0
       and (cp.txn_date is null or cp.txn_date >= (now() - billing.credit_lookback())::date)
       and (cp.memo is null or cp.memo !~* 'maint')
     group by 1) x;
  if v_diff > 0 then
    raise exception 'billing_open_credits disagrees with the gate filter for % customer(s)', v_diff;
  end if;
end $$;
