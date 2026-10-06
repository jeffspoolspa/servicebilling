-- Skip sending can be placed on a WORK ORDER before its invoice exists; the invoice inherits it.
--
-- Module: docs/modules/service/billing.md
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- 20261006193350 made a delivery waiver per INVOICE. The 2026-10-06 credit
-- cleanup closes old work orders whose payment already sits in QBO; their
-- invoices do not exist yet (ION has not pushed them). When one syncs,
-- pre-processing auto-applies the waiting credit, the invoice is paid and
-- unsent, and the queue emails the paid copy within minutes: too fast to
-- waive by hand. Holds solved the same problem by subjecting the work order
-- ("it exists before the invoice does").
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- 1. billing.send_waived(invoice) folds delivery_waived / _revoked on the
--    invoice AND on every work order linked to it; latest wins across both.
--    Every reader (action_available, compute_billing_status,
--    fn_auto_promote_to_processed, v_invoice_state, send_and_record) gets
--    the work-order waiver for free.
-- 2. public.skip_work_order_send / undo_skip_work_order_send: append the
--    event on aggregate work_order; if an invoice is already linked,
--    re-project its status. Refuse when the linked invoice was already sent.
--
-- ─────────────────────────────────────────────────────────────────
-- WHAT WE KEEP / WHAT WE LOSE
-- ─────────────────────────────────────────────────────────────────
-- Keep: send_waived's signature and every invoice-level waiver (their
-- answer is unchanged: no work_order waiver events exist yet; checked).

-- 1. the fold
create or replace function billing.send_waived(p_qbo_invoice_id text)
returns boolean
language sql
stable security definer
set search_path to 'billing', 'public'
as $function$
  select coalesce((
    select e.type = 'delivery_waived'
      from billing.events e
     where e.type in ('delivery_waived', 'delivery_waiver_revoked')
       and (   (e.aggregate = 'invoice' and e.aggregate_id = p_qbo_invoice_id)
            or (e.aggregate = 'work_order' and e.aggregate_id in (
                  select w.wo_number from public.work_orders w
                   where w.qbo_invoice_id = p_qbo_invoice_id)))
     order by e.seq desc limit 1), false)
$function$;

-- 2. the work-order actions
create or replace function public.skip_work_order_send(
  p_wo_number text, p_note text, p_actor text)
returns boolean
language plpgsql
security definer
set search_path to 'billing', 'public'
as $function$
declare v_inv text; v_sent boolean;
begin
  select w.qbo_invoice_id into v_inv from public.work_orders w where w.wo_number = p_wo_number;
  if not found then raise exception 'work order % not found', p_wo_number; end if;
  if v_inv is not null then
    select i.email_status = 'EmailSent' into v_sent from billing.invoices i where i.qbo_invoice_id = v_inv;
    if v_sent then raise exception 'work order %: invoice already sent', p_wo_number; end if;
  end if;
  if coalesce((select e.type = 'delivery_waived' from billing.events e
                where e.aggregate = 'work_order' and e.aggregate_id = p_wo_number
                  and e.type in ('delivery_waived', 'delivery_waiver_revoked')
                order by e.seq desc limit 1), false) then
    return false;
  end if;

  insert into billing.events (aggregate, aggregate_id, type, actor, participants, payload)
  values ('work_order', p_wo_number, 'delivery_waived', p_actor,
          case when v_inv is not null then array['invoice:' || v_inv] else array[]::text[] end,
          jsonb_build_object(
            'reason', 'not_wanted',
            'note', nullif(btrim(p_note), ''),
            'provenance', jsonb_build_object('source', 'intent',
                                             'intent_ref', 'skip_work_order_send')));
  if v_inv is not null then perform billing.project_billing_status(v_inv); end if;
  return true;
end $function$;

create or replace function public.undo_skip_work_order_send(
  p_wo_number text, p_note text, p_actor text)
returns boolean
language plpgsql
security definer
set search_path to 'billing', 'public'
as $function$
declare v_inv text;
begin
  if not coalesce((select e.type = 'delivery_waived' from billing.events e
                    where e.aggregate = 'work_order' and e.aggregate_id = p_wo_number
                      and e.type in ('delivery_waived', 'delivery_waiver_revoked')
                    order by e.seq desc limit 1), false) then
    return false;
  end if;
  select w.qbo_invoice_id into v_inv from public.work_orders w where w.wo_number = p_wo_number;

  insert into billing.events (aggregate, aggregate_id, type, actor, participants, payload)
  values ('work_order', p_wo_number, 'delivery_waiver_revoked', p_actor,
          case when v_inv is not null then array['invoice:' || v_inv] else array[]::text[] end,
          jsonb_build_object(
            'note', nullif(btrim(p_note), ''),
            'provenance', jsonb_build_object('source', 'intent',
                                             'intent_ref', 'undo_skip_work_order_send')));
  if v_inv is not null then perform billing.project_billing_status(v_inv); end if;
  return true;
end $function$;

revoke all on function public.skip_work_order_send(text, text, text) from public, anon;
revoke all on function public.undo_skip_work_order_send(text, text, text) from public, anon;
grant execute on function public.skip_work_order_send(text, text, text) to authenticated, service_role;
grant execute on function public.undo_skip_work_order_send(text, text, text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
-- No work_order waiver events exist yet, so the widened fold must give
-- every invoice the same answer as the invoice-only fold.
do $$
declare v_diff int;
begin
  select count(*) into v_diff from billing.invoices i
   where billing.send_waived(i.qbo_invoice_id) is distinct from coalesce((
     select e.type = 'delivery_waived' from billing.events e
      where e.aggregate = 'invoice' and e.aggregate_id = i.qbo_invoice_id
        and e.type in ('delivery_waived', 'delivery_waiver_revoked')
      order by e.seq desc limit 1), false);
  if v_diff > 0 then
    raise exception 'widened send_waived changed the answer for % invoice(s)', v_diff;
  end if;
end $$;
