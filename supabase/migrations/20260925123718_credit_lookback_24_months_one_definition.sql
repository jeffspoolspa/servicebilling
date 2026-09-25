-- Credit lookback: 6 months -> 24 months, and ONE definition (2026-09-25).
--
-- Daryl Miller inv 8089802 ($150) was card-charged while a $150 credit from
-- 2026-01-23 sat unapplied: the 6-month window hid it from both the auto-apply
-- (f/billing/_lib/payments.load_applicable_credits) and the gate. The same
-- literal was copied into four DB functions; they now all read
-- billing.credit_lookback(). Python mirrors moved in the same change:
-- load_applicable_credits(max_age_months=24), pull_qbo_credits and
-- refresh_customer_credits lookback 730 days.
--
-- Bodies below are the live definitions with only the interval replaced.

create or replace function billing.credit_lookback()
returns interval
language sql
immutable
as $$ select interval '24 months' $$;

comment on function billing.credit_lookback() is
  'How far back an unapplied credit still counts for service billing (auto-apply, '
  'gate, review, settle). Ruled 24 months 2026-09-25. Python mirrors: '
  'load_applicable_credits(max_age_months=24), pull_qbo_credits LOOKBACK_DAYS=730.';

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
        select 1 from billing.customer_payments cp
        where cp.qbo_customer_id = i.qbo_customer_id
          and cp.unapplied_amt > 0
          and (cp.txn_date is null or cp.txn_date >= (now() - billing.credit_lookback())::date)
          and (cp.memo is null or cp.memo !~* 'maint')
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
    from billing.customer_payments cp
   where cp.qbo_customer_id = v_inv.qbo_customer_id and cp.unapplied_amt > 0
     and (cp.txn_date is null or cp.txn_date >= (now() - billing.credit_lookback())::date)
     and (cp.memo is null or cp.memo !~* 'maint')
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
      from billing.customer_payments cp
     where cp.qbo_customer_id = new.qbo_customer_id
       and cp.unapplied_amt > 0
       and (cp.txn_date is null or cp.txn_date >= (now() - billing.credit_lookback())::date)
       and (cp.memo is null or cp.memo !~* 'maint')
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
  from billing.customer_payments cp
  join billing.invoices i on i.qbo_customer_id = cp.qbo_customer_id
  where i.qbo_invoice_id = p_qbo_invoice_id
    and cp.unapplied_amt > 0
    and (cp.txn_date is null or cp.txn_date >= (now() - billing.credit_lookback())::date)
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
$function$;
