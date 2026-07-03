-- Two ops fixes from the June batch run:
--
-- 1. maint_billing_months timed out (8s statement limit) under burst load:
--    the per-month correlated subquery on customer_month_audit re-scanned
--    per group. Rewritten as one grouped LEFT JOIN + a covering partial
--    index; ~10x cheaper, so CPU spikes no longer push it past the limit.
-- 2. maint_billing_enqueue_preprocess: immediate retry for a customer-month
--    whose preprocess hit a sticky op error (enrichment/credit) — the
--    Needs Review "Retry preprocessing" button enqueues NOW instead of
--    waiting for the drainer's 30-minute self-heal spacing.

create index if not exists idx_cma_high_flagged
  on billing_audit.customer_month_audit (month)
  where flag_level = 'HIGH' and audit_status = 'flagged';

create or replace function public.maint_billing_months()
returns table (
  billing_month date, period_count integer, expected_total_cents bigint,
  locked boolean, mismatch_count integer, high_hold_customers integer
)
language sql stable security definer
set search_path = billing_audit, public
as $$
  with agg as (
    select tbp.billing_month,
           count(*)::int as period_count,
           coalesce(sum(tbp.expected_total_cents), 0)::bigint as expected_total_cents,
           bool_and(tbp.locked_at is not null) as locked,
           (count(*) filter (where tbp.status = 'mismatch'))::int as mismatch_count
    from task_billing_periods tbp
    group by tbp.billing_month
  ),
  holds as (
    select a.month, count(*)::int as high_hold_customers
    from customer_month_audit a
    where a.flag_level = 'HIGH' and a.audit_status = 'flagged'
    group by a.month
  )
  select agg.billing_month, agg.period_count, agg.expected_total_cents,
         agg.locked, agg.mismatch_count, coalesce(h.high_hold_customers, 0)
  from agg
  left join holds h on h.month = agg.billing_month
  order by agg.billing_month desc;
$$;

create or replace function public.maint_billing_enqueue_preprocess(
  p_qbo_customer_id text,
  p_month date
)
returns boolean
language sql security definer
set search_path = billing_audit, public
as $$
  insert into maint_preprocess_queue (qbo_customer_id, billing_month)
  values (p_qbo_customer_id, p_month)
  on conflict (qbo_customer_id, billing_month) where finished_at is null
  do nothing;
  select true;
$$;

revoke all on function public.maint_billing_enqueue_preprocess(text, date) from public, anon;
grant execute on function public.maint_billing_enqueue_preprocess(text, date) to authenticated, service_role;

notify pgrst, 'reload schema';
