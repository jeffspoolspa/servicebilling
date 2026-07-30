-- v_service_billing_state v2 — the ONE row the pre-processing UI reads.
--
-- v1 exposed only the decision-record rollup. The card also needs the
-- indicator facts and the derived status, and today it gets them by reading
-- raw invoice columns and REGEX-PARSING needs_review_reason strings (the old
-- workflow). v2 folds everything into the view so the component reads one
-- typed row: state machine + gates + credit rollup + freshness provenance.
-- Exposed to the app as public.service_billing_state (anon read pattern).

drop view if exists public.service_billing_state;
drop view if exists billing.v_service_billing_state;  -- column set changed (42P16)

create view billing.v_service_billing_state as
select
  i.qbo_invoice_id,
  i.qbo_customer_id,
  i.balance,
  i.subtotal,
  i.fetched_at                          as invoice_verified_at,
  -- the state machine (null = never pre-processed under the new flow)
  pp.state                              as pre_process_state,
  pp.credits_verified_at,
  pp.pm_verified_at,
  pp.reviewed_at,
  -- gates (indicator facts; stamped columns until the projection consolidation)
  i.subtotal_ok,
  i.enrichment_ok,
  i.payment_method,
  i.preferred_payment_type,
  i.pre_processed_at,
  i.pre_process_stage,
  s.derived_status,
  i.needs_review_reason,
  -- credit decision rollup
  coalesce(sel.open_count, 0)           as open_candidate_count,
  coalesce(sel.applied_count, 0)        as applied_count,
  coalesce(sel.rejected_count, 0)       as rejected_count,
  coalesce(sel.stale_count, 0)          as stale_count,
  coalesce(sel.open_count, 0) = 0       as credits_settled,
  coalesce(sel.applied_amount, 0)       as credits_applied_amount
from billing.invoices i
join billing.v_invoice_status s using (qbo_invoice_id)
left join billing.invoice_pre_process pp using (qbo_invoice_id)
left join lateral (
  select
    count(*) filter (where state = 'candidate')                  as open_count,
    count(*) filter (where state = 'applied')                    as applied_count,
    count(*) filter (where state = 'rejected')                   as rejected_count,
    count(*) filter (where state = 'stale')                      as stale_count,
    coalesce(sum(amount) filter (where state = 'applied'), 0)    as applied_amount
  from billing.invoice_credit_decisions d
  where d.qbo_invoice_id = i.qbo_invoice_id
) sel on true;

create view public.service_billing_state as
  select * from billing.v_service_billing_state;

grant select on public.service_billing_state to anon, authenticated, service_role;
