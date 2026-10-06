-- A person can skip sending a service invoice (and undo it): delivery_waived {reason: not_wanted}.
--
-- Module: docs/modules/service/billing.md
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- The waiver already exists: delivery_waived / delivery_waiver_revoked events,
-- folded by billing.send_waived() (latest wins), honoured by action_available,
-- compute_billing_status and fn_auto_promote_to_processed. Only a rule writes
-- it (waive_aged_deliveries, reason aged_out). EVENT_VOCABULARY lists "UI
-- action" as an author and the vocabulary as "not possible or not wanted",
-- but no UI exists and the reason CHECK has no "not wanted" value.
-- Carter 2026-10-06: a way to skip sending an unsent invoice so it never
-- gets sent.
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- 1. delivery_waived_reason_vocabulary gains 'not_wanted' (the person's why
--    rides in payload.note). Kept NOT VALID, as it was.
-- 2. public.skip_invoice_send / public.undo_skip_invoice_send: SECURITY
--    DEFINER, append the event, then re-project billing_status (an event
--    insert is not a bell). Refuse an already-sent invoice; idempotent
--    (returns false when there is nothing to change).
-- 3. The send itself refuses in f/billing/_lib/delivery.send_and_record,
--    the one door every service send goes through (queue, forced manual
--    send, payment recovery). That is code, shipped with this migration.
--
-- ─────────────────────────────────────────────────────────────────
-- WHAT WE KEEP / WHAT WE LOSE
-- ─────────────────────────────────────────────────────────────────
-- Keep: every existing reason value (including the pre-adoption backfill
-- reason, which EVENT_VOCABULARY did not list). Nothing is lost.

-- 1. the reason
alter table billing.events drop constraint delivery_waived_reason_vocabulary;
alter table billing.events add constraint delivery_waived_reason_vocabulary
  check (type <> 'delivery_waived'
         or payload ->> 'reason' = any (array[
              'no_email', 'invalid_email', 'aged_out', 'not_wanted',
              'settled outside the system before adoption — no processing attempt, no send log, no charge event by us']))
  not valid;

-- 2. the two actions
create or replace function public.skip_invoice_send(
  p_qbo_invoice_id text, p_note text, p_actor text)
returns boolean
language plpgsql
security definer
set search_path to 'billing', 'public'
as $function$
declare v_inv billing.invoices%rowtype;
begin
  select * into v_inv from billing.invoices where qbo_invoice_id = p_qbo_invoice_id;
  if not found then raise exception 'invoice % not found', p_qbo_invoice_id; end if;
  if v_inv.email_status = 'EmailSent' then
    raise exception 'invoice % was already sent', v_inv.doc_number;
  end if;
  if billing.send_waived(p_qbo_invoice_id) then return false; end if;

  insert into billing.events (aggregate, aggregate_id, type, actor, participants, payload)
  values ('invoice', p_qbo_invoice_id, 'delivery_waived', p_actor,
          array['customer:' || v_inv.qbo_customer_id],
          jsonb_build_object(
            'reason', 'not_wanted',
            'note', nullif(btrim(p_note), ''),
            'balance_at_waiver', v_inv.balance,
            'provenance', jsonb_build_object('source', 'intent',
                                             'intent_ref', 'skip_invoice_send')));
  perform billing.project_billing_status(p_qbo_invoice_id);
  return true;
end $function$;

create or replace function public.undo_skip_invoice_send(
  p_qbo_invoice_id text, p_note text, p_actor text)
returns boolean
language plpgsql
security definer
set search_path to 'billing', 'public'
as $function$
declare v_customer text;
begin
  if not billing.send_waived(p_qbo_invoice_id) then return false; end if;
  select qbo_customer_id into v_customer from billing.invoices
   where qbo_invoice_id = p_qbo_invoice_id;

  insert into billing.events (aggregate, aggregate_id, type, actor, participants, payload)
  values ('invoice', p_qbo_invoice_id, 'delivery_waiver_revoked', p_actor,
          array['customer:' || v_customer],
          jsonb_build_object(
            'note', nullif(btrim(p_note), ''),
            'provenance', jsonb_build_object('source', 'intent',
                                             'intent_ref', 'undo_skip_invoice_send')));
  perform billing.project_billing_status(p_qbo_invoice_id);
  return true;
end $function$;

revoke all on function public.skip_invoice_send(text, text, text) from public, anon;
revoke all on function public.undo_skip_invoice_send(text, text, text) from public, anon;
grant execute on function public.skip_invoice_send(text, text, text) to authenticated, service_role;
grant execute on function public.undo_skip_invoice_send(text, text, text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'delivery_waived_reason_vocabulary'
                    and pg_get_constraintdef(oid) like '%not_wanted%') then
    raise exception 'not_wanted missing from delivery_waived_reason_vocabulary';
  end if;
  if to_regprocedure('public.skip_invoice_send(text,text,text)') is null
     or to_regprocedure('public.undo_skip_invoice_send(text,text,text)') is null then
    raise exception 'skip/undo functions missing';
  end if;
end $$;
