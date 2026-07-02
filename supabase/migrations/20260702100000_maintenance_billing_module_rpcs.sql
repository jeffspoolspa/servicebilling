-- Maintenance billing module: public RPC surface for the /maintenance/billing UI.
--
-- The Next.js maintenance section gets a Billing tab over the monthly-maintenance-billing
-- flow: a billing-months view of billing_audit.task_billing_periods (the write-ahead
-- invoice promise), a HIGH-flag review page over billing_audit.customer_month_audit, and
-- autopay/send orchestration hooks. billing_audit is NOT PostgREST-exposed, so — same
-- pattern as public.estimate_maint_chemicals (migration 20260604161204) — the app reads
-- it through public SECURITY DEFINER wrappers. Granted to authenticated only (billing
-- data; the app always calls with a staff session), never anon.
--
-- Processing status is DERIVED, never stored (no new state table):
--   pending        no QBO invoice linked yet (qbo_invoice_id IS NULL)
--   synced_to_qbo  qbo_invoice_id set
--   processed      autopay charge landed (billing.autopay_transactions, non-dry-run,
--                  confirmed-charge status) OR the invoice was emailed
--                  (maintenance_invoices.send_status='sent' / QBO EmailSent)
--   paid           billing.invoices mirror balance <= 0
--
-- HARD RULE surfaced here (enforced in the autopay/send engines, same change):
-- a customer-month with an unreviewed HIGH CPV flag (customer_month_audit,
-- flag_level='HIGH', audit_status='flagged') is held from autopay + sending.

-- 1) Month list: one row per billing month with rollups for the month picker/summary.
create or replace function public.maint_billing_months()
returns table (
  billing_month        date,
  period_count         int,
  expected_total_cents bigint,
  locked               boolean,
  mismatch_count       int,
  high_hold_customers  int
)
language sql stable security definer
set search_path = billing_audit, public
as $$
  select
    tbp.billing_month,
    count(*)::int,
    coalesce(sum(tbp.expected_total_cents), 0)::bigint,
    bool_and(tbp.locked_at is not null),
    (count(*) filter (where tbp.status = 'mismatch'))::int,
    (select count(*)::int from customer_month_audit a
      where a.month = tbp.billing_month
        and a.flag_level = 'HIGH' and a.audit_status = 'flagged')
  from task_billing_periods tbp
  group by tbp.billing_month
  order by tbp.billing_month desc;
$$;

-- 2) The billing-months view rows: one per invoice promise for the month, joined with
--    customer, task class, ION invoice total (ion_task_transactions summed per task),
--    the QBO invoice mirror, and the derived processing status + HIGH-flag hold.
create or replace function public.maint_billing_periods(p_month date)
returns table (
  id                        uuid,
  task_id                   uuid,
  billing_month             date,
  customer_id               bigint,
  customer_name             text,
  qbo_customer_id           text,
  ion_task_id               text,
  service_name              text,
  category                  text,
  frequency                 text,
  days_per_week             int,
  billing_type              text,
  billing_method            text,
  billable_visit_count      int,
  expected_labor_cents      int,
  expected_consumable_cents int,
  expected_total_cents      int,
  unpriced_count            int,
  ion_amt_cents             bigint,
  ion_txn_count             int,
  ion_match                 text,     -- match | mismatch | missing
  qbo_invoice_id            text,
  qbo_doc_number            text,
  qbo_total                 numeric,
  qbo_balance               numeric,
  reconcile_status          text,     -- task_billing_periods.status
  labor_ok                  boolean,
  consumables_ok            boolean,
  locked                    boolean,
  on_autopay                boolean,
  autopay_charged           boolean,
  invoice_sent              boolean,
  high_flag_hold            boolean,
  processing_status         text      -- pending | synced_to_qbo | processed | paid
)
language sql stable security definer
set search_path = billing_audit, public
as $$
  with ion as (
    -- ION's month-end task invoices; a split re-bill means >1 row per task, so SUM
    select itt.ion_task_id::text as ion_task_id,
           sum(itt.amt_cents)::bigint as amt_cents,
           count(*)::int as txn_count
    from ion_task_transactions itt
    where itt.month::date = p_month
    group by 1
  )
  select
    tbp.id, tbp.task_id, tbp.billing_month,
    c.id, c.display_name, tbp.qbo_customer_id,
    vc.ion_task_id, vc.service_name, vc.category, vc.frequency,
    vc.days_per_week::int, vc.billing_type,
    tbp.billing_method, tbp.billable_visit_count,
    tbp.expected_labor_cents, tbp.expected_consumable_cents, tbp.expected_total_cents,
    (select count(*) from jsonb_object_keys(coalesce(tbp.unpriced_consumables, '{}'::jsonb)))::int,
    ion.amt_cents, ion.txn_count,
    case when ion.amt_cents is null then 'missing'
         -- $1 tolerance, same as the labor reconcile
         when abs(ion.amt_cents - coalesce(tbp.expected_total_cents, 0)) <= 100 then 'match'
         else 'mismatch' end,
    tbp.qbo_invoice_id, i.doc_number, i.total_amt, i.balance,
    tbp.status, tbp.labor_ok, tbp.consumables_ok,
    (tbp.locked_at is not null),
    (ac.qbo_customer_id is not null),
    (apt.charged is true),
    (mi.send_status = 'sent' or i.email_status = 'EmailSent'),
    (hold.held is true),
    case
      when tbp.qbo_invoice_id is not null and i.balance is not null and i.balance <= 0
        then 'paid'
      when apt.charged is true
        or mi.send_status = 'sent' or i.email_status = 'EmailSent'
        then 'processed'
      when tbp.qbo_invoice_id is not null then 'synced_to_qbo'
      else 'pending'
    end
  from task_billing_periods tbp
  left join public."Customers" c on c.qbo_customer_id = tbp.qbo_customer_id
  left join maintenance.v_task_class vc on vc.task_id = tbp.task_id
  left join ion on ion.ion_task_id = vc.ion_task_id
  left join billing.invoices i on i.qbo_invoice_id = tbp.qbo_invoice_id
  left join maintenance_invoices mi on mi.qbo_invoice_id = tbp.qbo_invoice_id
  left join billing.autopay_customers ac on ac.qbo_customer_id = tbp.qbo_customer_id
  left join lateral (
    -- confirmed autopay charge for this customer-month (autopay charges per customer,
    -- sweeping all the customer's unpaid maint invoices — so it covers this period)
    select true as charged
    from billing.autopay_transactions t
    where t.qbo_customer_id = tbp.qbo_customer_id
      -- autopay_transactions.billing_month is 'YYYY-MM' text; left() also tolerates a date
      and left(t.billing_month::text, 7) = to_char(p_month, 'YYYY-MM')
      and coalesce(t.dry_run, false) = false
      and t.status in ('charge_success', 'payment_created', 'completed', 'verified')
    limit 1
  ) apt on true
  left join lateral (
    select true as held
    from customer_month_audit a
    where a.customer_id = c.id and a.month = p_month
      and a.flag_level = 'HIGH' and a.audit_status = 'flagged'
    limit 1
  ) hold on true
  where tbp.billing_month = p_month;
$$;

-- 3) Flag review list: the month's CPV-audit flags (HIGH always; WATCH opt-in),
--    all audit_status values so reviewed/resolved history stays visible.
create or replace function public.maint_billing_flags(
  p_month date,
  p_include_watch boolean default false
)
returns table (
  customer_id     bigint,
  customer_name   text,
  qbo_customer_id text,
  month           date,
  peer_group      text,
  season          text,
  visits          numeric,
  chem_usd        numeric,
  cpv             numeric,
  peer_median     numeric,
  self_mean       numeric,
  fleet_z         numeric,
  self_z          numeric,
  pct_vs_self     numeric,
  flag_level      text,
  audit_status    text,
  audit_notes     text,
  computed_at     timestamptz
)
language sql stable security definer
set search_path = billing_audit, public
as $$
  select a.customer_id, c.display_name, c.qbo_customer_id, a.month, a.peer_group,
         a.season, a.visits, a.chem_usd, a.cpv, a.peer_median, a.self_mean,
         a.fleet_z, a.self_z, a.pct_vs_self, a.flag_level, a.audit_status,
         a.audit_notes, a.computed_at
  from customer_month_audit a
  join public."Customers" c on c.id = a.customer_id
  where a.month = p_month
    and (a.flag_level = 'HIGH' or (p_include_watch and a.flag_level = 'WATCH'))
  order by case a.flag_level when 'HIGH' then 0 else 1 end,
           a.fleet_z desc nulls last;
$$;

-- 4) Flag drill-down: per-item usage this month vs the customer's usual month
--    (their avg over the prior 12 months) and the peer-group average among
--    customers who used the item that month. Recurring tasks only — same scope
--    as v_customer_month_cpv, so the numbers reconcile with the flag.
create or replace function public.maint_billing_flag_items(
  p_customer_id bigint,
  p_month date
)
returns table (
  item_name    text,
  category     text,
  month_qty    numeric,
  month_usd    numeric,
  usual_qty    numeric,
  usual_usd    numeric,
  peer_avg_usd numeric
)
language sql stable security definer
set search_path = billing_audit, public
as $$
  -- ponytail: scans 13 months of usage on every call; fine for a hand-driven
  -- drill-down page. Materialize if it ever backs a list view.
  with usage as (
    select t.customer_id,
           date_trunc('month', v.visit_date)::date as month,
           cc.item_name, cc.category,
           sum(cu.quantity) as qty,
           sum(cu.quantity * cc.unit_price_cents) / 100.0 as usd
    from maintenance.visits v
    join maintenance.tasks t on t.id = v.task_id
    join maintenance.consumables_usage cu on cu.visit_id = v.id
    join maintenance.consumables cc on cc.ion_item_id = cu.ion_item_id
    where t.category = 'recurring'
      and v.visit_date >= (p_month - interval '12 months')::date
      and v.visit_date <  (p_month + interval '1 month')::date
    group by 1, 2, 3, 4
  ),
  cur as (
    select * from usage where customer_id = p_customer_id and month = p_month
  ),
  hist as (
    select u.item_name, avg(u.qty) as usual_qty, avg(u.usd) as usual_usd
    from usage u
    where u.customer_id = p_customer_id and u.month <> p_month
    group by 1
  ),
  peer as (
    select u.item_name, avg(u.usd) as peer_avg_usd
    from usage u
    join v_customer_month_cpv p
      on p.customer_id = u.customer_id and p.month = p_month
    where u.month = p_month
      and u.customer_id <> p_customer_id
      and p.peer_group = (select peer_group from v_customer_month_cpv
                          where customer_id = p_customer_id and month = p_month)
    group by 1
  )
  select cur.item_name, cur.category, cur.qty, cur.usd,
         hist.usual_qty, hist.usual_usd, peer.peer_avg_usd
  from cur
  left join hist using (item_name)
  left join peer using (item_name)
  order by cur.usd desc nulls last;
$$;

-- 5) Review action: mark a flagged customer-month reviewed/resolved (with a note),
--    or re-flag it. Reviewing releases the autopay/send hold.
create or replace function public.maint_billing_flag_review(
  p_customer_id bigint,
  p_month date,
  p_status text,
  p_note text default null
)
returns boolean
language plpgsql security definer
set search_path = billing_audit, public
as $$
begin
  if p_status not in ('flagged', 'reviewed', 'resolved') then
    raise exception 'invalid audit_status: %', p_status;
  end if;
  update customer_month_audit
     set audit_status = p_status,
         audit_notes  = coalesce(p_note, audit_notes)
   where customer_id = p_customer_id and month = p_month;
  return found;
end;
$$;

-- Billing data: authenticated staff only, never anon.
revoke all on function public.maint_billing_months() from public, anon;
revoke all on function public.maint_billing_periods(date) from public, anon;
revoke all on function public.maint_billing_flags(date, boolean) from public, anon;
revoke all on function public.maint_billing_flag_items(bigint, date) from public, anon;
revoke all on function public.maint_billing_flag_review(bigint, date, text, text) from public, anon;
grant execute on function public.maint_billing_months() to authenticated, service_role;
grant execute on function public.maint_billing_periods(date) to authenticated, service_role;
grant execute on function public.maint_billing_flags(date, boolean) to authenticated, service_role;
grant execute on function public.maint_billing_flag_items(bigint, date) to authenticated, service_role;
grant execute on function public.maint_billing_flag_review(bigint, date, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
