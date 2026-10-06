-- The credit DB functions read public.billing_open_credits; credits_ok becomes the gate's answer.
--
-- Module: docs/modules/service/billing.md
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- 20261006185152 made public.billing_open_credits the one definition of the
-- applicable credit set (unapplied, inside billing.credit_lookback(), no
-- maint). Four functions still repeated that WHERE clause inline, and a
-- fifth, billing.compute_credits_ok, was missed by 20260925123718 and still
-- used a literal 180 days plus the pre-v3 override-date rule.
--
-- credits_ok is read by nothing for its value; it is the BELL:
-- trg_project_billing_status_on_indicator_change recomputes billing_status
-- when it flips (fired by trg_set_credits_ok_from_payment on every
-- customer_payments change). With the 180-day rule it disagreed with the
-- gate on 8 open invoices (2026-10-06), including the six held in
-- credit_review (76148, 76165, 76168, 76176, 76184, 76191): stored true,
-- gate false. When their 6-24 month credits are applied in QBO, credits_ok
-- would not flip, the bell would not ring, and they would stay held.
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- 1-4. invoice_gate_checks, compute_billing_status, fn_reject_credits_on_settle,
--      complete_credit_review select from public.billing_open_credits.
--      Bodies otherwise unchanged (pure refactor; checked below).
-- 5.   compute_credits_ok returns the gate's own credits_settled, so the
--      bell flips exactly when the gate's answer does. The override-date
--      rule goes: v3 decides credits by decision rows, not the timestamp.
-- 6.   Backfill credits_ok where stored disagrees with the gate. This fires
--      the projection trigger; each touched invoice must land on its
--      computed status (the six held still fail credits_settled, the open_ar
--      ones have no action). The sanity check raises and rolls back otherwise.
--
-- ─────────────────────────────────────────────────────────────────
-- WHAT WE KEEP / WHAT WE LOSE
-- ─────────────────────────────────────────────────────────────────
-- Out of scope: the other 63 stale stored statuses (not re-projected here).
-- Lose: credit_review_overridden_at no longer suppresses older credits in
-- credits_ok (the gate already ignored it). Keep: every signature, the
-- triggers, and every computed billing_status (76176 only has its stale
-- stored reason corrected to the computed open_ar).

-- computed (not stored) status: 64 open invoices carry a stale stored
-- billing_status today; this migration must not be judged against those.
create temp table _before as
select i.qbo_invoice_id, c.billing_status, c.needs_review_reason,
       billing.invoice_gate_checks(i.qbo_invoice_id) as checks
  from billing.invoices i
  join public.work_orders w on w.qbo_invoice_id = i.qbo_invoice_id
  cross join lateral billing.compute_billing_status(i.qbo_invoice_id) c
 where i.billing_status <> 'processed' and w.billable and w.skipped_at is null;

-- 1. the gate
create or replace function billing.invoice_gate_checks(p_qbo_invoice_id text)
returns jsonb
language sql
stable
set search_path to 'billing', 'public'
as $function$
  select jsonb_build_object(
    -- something is left to DO (an unmade send, or an unattempted chargeable balance)
    'action_available',  coalesce(billing.action_available(p_qbo_invoice_id), false),
    -- the invoice still exists as far as we are concerned
    'not_voided',        not billing.invoice_voided(i.qbo_invoice_id),
    -- nobody has said hands off
    'not_on_hold',       not billing.invoice_on_hold(i.qbo_invoice_id),
    -- pre-processing ran
    'enriched',          i.pre_processed_at is not null,
    -- QBO carries what the customer will read
    'memo_present',      i.memo is not null,
    'class_present',     i.qbo_class is not null,
    -- we know how they pay
    'route_resolved',    i.preferred_payment_type in ('email','ach','credit_card'),
    -- the two systems agree on the money
    'subtotal_matches',  abs(coalesce(i.subtotal, 0) - coalesce(w.sub_total, 0)) < 0.01,
    -- every open credit has a terminal decision against this invoice
    'credits_settled',   not exists (
        select 1 from public.billing_open_credits cp
        where cp.qbo_customer_id = i.qbo_customer_id
          and not exists (
            select 1 from billing.invoice_credit_decisions d
            where d.qbo_invoice_id = i.qbo_invoice_id
              and d.credit_id = cp.qbo_payment_id
              and d.state in ('applied','rejected')))
  )
  from billing.invoices i
  join public.work_orders w on w.qbo_invoice_id = i.qbo_invoice_id
  where i.qbo_invoice_id = p_qbo_invoice_id
    and w.billable is true and w.skipped_at is null
$function$;

-- 2. the status reason
create or replace function billing.compute_billing_status(p_qbo_invoice_id text)
returns table(billing_status text, needs_review_reason text)
language plpgsql
stable
as $function$
declare
  v_inv          billing.invoices%rowtype;
  v_wo_subtotal  numeric;
  v_reasons      text[];
  v_credit_count int;
begin
  select * into v_inv from billing.invoices where qbo_invoice_id = p_qbo_invoice_id;
  if not found then return; end if;

  if not exists (select 1 from public.work_orders w
                  where w.qbo_invoice_id = p_qbo_invoice_id
                    and w.billable = true and w.skipped_at is null) then
    billing_status := v_inv.billing_status;
    needs_review_reason := v_inv.needs_review_reason;
    return next; return;
  end if;

  if billing.invoice_voided(p_qbo_invoice_id) then
    billing_status := 'processed'; needs_review_reason := 'invoice_voided';
    return next; return;
  end if;

  -- terminal: settled AND delivered
  if coalesce(v_inv.balance, 0) < 0.01
     and (v_inv.email_status = 'EmailSent' or billing.send_waived(p_qbo_invoice_id)) then
    billing_status := 'processed'; needs_review_reason := null;
    return next; return;
  end if;

  -- NOTHING LEFT TO DO -> A/R. Checked BEFORE enrichment: an invoice already
  -- delivered with no chargeable action is not awaiting pre-processing.
  if not coalesce(billing.action_available(p_qbo_invoice_id), false) then
    billing_status := 'needs_review';
    needs_review_reason := case
      when billing.charge_attempted(p_qbo_invoice_id)
        then 'open_ar (charge attempted, invoice delivered)'
      else 'open_ar (invoice delivered, awaiting payment)' end;
    return next; return;
  end if;

  if v_inv.pre_processed_at is null then
    billing_status := 'awaiting_pre_processing'; needs_review_reason := null;
    return next; return;
  end if;

  if billing.invoice_ready(p_qbo_invoice_id) then
    billing_status := 'ready_to_process'; needs_review_reason := null;
    return next; return;
  end if;

  -- enriched, action available, still not ready: say why (computed, not read)
  v_reasons := array[]::text[];

  select sub_total into v_wo_subtotal from public.work_orders
   where qbo_invoice_id = p_qbo_invoice_id order by wo_number limit 1;
  if abs(coalesce(v_inv.subtotal,0) - coalesce(v_wo_subtotal,0)) >= 0.01 then
    v_reasons := v_reasons || format('subtotal_mismatch (WO $%s vs QBO $%s)',
      to_char(coalesce(v_wo_subtotal,0),'FM999999.00'),
      to_char(coalesce(v_inv.subtotal,0),'FM999999.00'));
  end if;

  select count(*)::int into v_credit_count
    from public.billing_open_credits cp
   where cp.qbo_customer_id = v_inv.qbo_customer_id
     and not exists (select 1 from billing.invoice_credit_decisions d
                      where d.qbo_invoice_id = p_qbo_invoice_id
                        and d.credit_id = cp.qbo_payment_id
                        and d.state in ('applied','rejected'));
  if v_credit_count > 0 then
    v_reasons := v_reasons || format('credit_review (%s undecided credit(s))', v_credit_count);
  end if;

  if v_inv.memo is null or v_inv.qbo_class is null then
    v_reasons := array_append(v_reasons, 'enrichment_failed');
  end if;

  billing_status := 'needs_review';
  needs_review_reason := coalesce(nullif(array_to_string(v_reasons, ', '), ''),
                                  'not ready');
  return next;
end;
$function$;

-- 3. reject the rest when the invoice settles
create or replace function billing.fn_reject_credits_on_settle()
returns trigger
language plpgsql
as $function$
begin
  with newly as (
    insert into billing.invoice_credit_decisions
      (qbo_invoice_id, credit_id, amount, unapplied_at_decision,
       state, reason, decided_by, decided_at)
    select new.qbo_invoice_id, cp.qbo_payment_id, NULL, cp.unapplied_amt,
           'rejected', 'invoice_settled', 'system', now()
      from public.billing_open_credits cp
     where cp.qbo_customer_id = new.qbo_customer_id
       and not exists (select 1 from billing.invoice_credit_decisions d
                        where d.qbo_invoice_id = new.qbo_invoice_id
                          and d.credit_id = cp.qbo_payment_id
                          and d.state in ('applied','rejected'))
    returning credit_id, unapplied_at_decision)
  insert into billing.events (aggregate, aggregate_id, type, actor, participants, payload)
  select 'invoice', new.qbo_invoice_id, 'credit_rejected', 'system',
         array['payment:' || n.credit_id, 'customer:' || new.qbo_customer_id],
         jsonb_build_object('credit_id', n.credit_id, 'reason', 'invoice_settled',
           'unapplied_at_decision', n.unapplied_at_decision,
           'note', 'invoice balance reached zero; credit stays open for other invoices',
           'provenance', jsonb_build_object('source','intent',
                                            'intent_ref','fn_reject_credits_on_settle'))
    from newly n;
  return null;
end $function$;

-- 4. reviewer completes the review
create or replace function public.complete_credit_review(p_qbo_invoice_id text, p_note text default null::text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'billing'
as $function$
begin
  -- reject every remaining DERIVED-undecided credit: open credits without a
  -- terminal decision get a rejected row; open proposed/candidate rows flip.
  insert into billing.invoice_credit_decisions
    (qbo_invoice_id, credit_id, amount, unapplied_at_decision, state, reason, decided_by, decided_at)
  select p_qbo_invoice_id, cp.qbo_payment_id, cp.unapplied_amt, cp.unapplied_amt,
         'rejected', p_note, 'review_complete', now()
  from public.billing_open_credits cp
  join billing.invoices i on i.qbo_customer_id = cp.qbo_customer_id
  where i.qbo_invoice_id = p_qbo_invoice_id
  on conflict (qbo_invoice_id, credit_id) do update set
    state = 'rejected', decided_by = 'review_complete', decided_at = now()
  where billing.invoice_credit_decisions.state in ('proposed','candidate');

  insert into billing.invoice_pre_process (qbo_invoice_id, state, reviewed_at)
  values (p_qbo_invoice_id, 'deciding', now())
  on conflict (qbo_invoice_id) do update set
    reviewed_at = now(), updated_at = now();

  return public.override_credit_review(p_qbo_invoice_id, p_note);
end;
$function$;

-- 5. the bell rings when the gate's answer changes
create or replace function billing.compute_credits_ok(p_qbo_invoice_id text)
returns boolean
language sql
stable
as $function$
  select (billing.invoice_gate_checks(p_qbo_invoice_id) ->> 'credits_settled')::boolean
$function$;

comment on function billing.compute_credits_ok(text) is
  'The gate''s credits_settled. Stored in billing.invoices.credits_ok only as the '
  'bell for trg_project_billing_status_on_indicator_change; nothing reads the value.';

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK (before the backfill: the refactor changed no gate answer)
-- ─────────────────────────────────────────────────────────────────
do $$
declare v_diff int;
begin
  select count(*) into v_diff
    from _before b
    cross join lateral billing.compute_billing_status(b.qbo_invoice_id) c
   where b.checks is distinct from billing.invoice_gate_checks(b.qbo_invoice_id)
      or (b.billing_status, b.needs_review_reason)
         is distinct from (c.billing_status, c.needs_review_reason);
  if v_diff > 0 then
    raise exception 'refactor changed the gate or status for % invoice(s)', v_diff;
  end if;
end $$;

-- 6. backfill the bell where it disagrees with the gate
create temp table _flipped as
select b.qbo_invoice_id from _before b join billing.invoices i using (qbo_invoice_id)
 where i.credits_ok is distinct from billing.compute_credits_ok(i.qbo_invoice_id);

update billing.invoices i
   set credits_ok = billing.compute_credits_ok(i.qbo_invoice_id)
  from _before b
 where b.qbo_invoice_id = i.qbo_invoice_id
   and i.credits_ok is distinct from billing.compute_credits_ok(i.qbo_invoice_id);

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK (after the backfill: no billing_status moved)
-- ─────────────────────────────────────────────────────────────────
do $$
declare v_moved int; v_stale int;
begin
  -- only rows the backfill touched were re-projected; each must land on the
  -- status the refactor-checked compute gave before (76176: stored
  -- credit_review, computed open_ar, so its reason corrects; no event, no queue)
  select count(*) into v_moved from _before b join billing.invoices i using (qbo_invoice_id)
   where b.qbo_invoice_id in (select qbo_invoice_id from _flipped)
     and (i.billing_status, i.needs_review_reason)
         is distinct from (b.billing_status, b.needs_review_reason);
  if v_moved > 0 then
    raise exception 'credits_ok backfill landed % invoice(s) off their computed status', v_moved;
  end if;
  select count(*) into v_stale from _before b join billing.invoices i using (qbo_invoice_id)
   where i.credits_ok is distinct from billing.compute_credits_ok(i.qbo_invoice_id);
  if v_stale > 0 then
    raise exception 'credits_ok still disagrees with the gate on % invoice(s)', v_stale;
  end if;
end $$;

drop table _flipped;
drop table _before;
