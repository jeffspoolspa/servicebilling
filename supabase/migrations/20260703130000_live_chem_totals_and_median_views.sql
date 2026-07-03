-- LIVE chem-flag pipeline (Carter, 2026-07-03): the median must be current
-- with every ingested visit, not refreshed at checkpoints.
--
-- How this works in Postgres: a median is positional (the middle of an
-- ordered set), so it cannot be incrementally STORED — but it can be
-- instantly RECOMPUTED when its input is small. So:
--
--   maintenance.consumables_usage  --trigger (delta: qty x catalog price)-->
--   billing_audit.customer_month_chem_live   (~500 rows/month, always current)
--   -> v_chem_flag_medians  (plain view: percentile over the small table — ms)
--   -> v_chem_flags         (plain view: total > 2x group median AND >= $150)
--
-- Peer group is derived live from task tags (tasks.frequency/days_per_week
-- are already trigger-maintained) + Customers.company — no monthly rollup
-- needed. Provides-chems customers are INCLUDED in the median (simple rule).
--
-- Drift safety: the trigger maintains deltas; rebuild_customer_month_chem()
-- trues the month up from v_customer_month_cpv (catalog price edits, task
-- recategorization) — called by the hourly reconcile.
--
-- Replaces the checkpoint snapshot chain (chem_flag_snapshot,
-- chem_flag_medians table, customer_month_cpv_snapshot, refresh_chem_flags).

-- ── 1) the live totals table (the only stored layer) ────────────────
create table if not exists billing_audit.customer_month_chem_live (
  customer_id bigint not null,
  month       date not null,
  total_usd   numeric not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (customer_id, month)
);

-- ── 2) delta trigger on consumables_usage ───────────────────────────
create or replace function billing_audit.fn_chem_live_delta()
returns trigger
language plpgsql security definer
set search_path = billing_audit, maintenance, public
as $$
declare
  v_customer bigint;
  v_month    date;
  v_delta    numeric := 0;
  v_price    numeric;
begin
  -- resolve the visit -> recurring task -> customer + month
  select t.customer_id, date_trunc('month', v.visit_date)::date
    into v_customer, v_month
  from maintenance.visits v
  join maintenance.tasks t on t.id = v.task_id
  where v.id = coalesce(NEW.visit_id, OLD.visit_id)
    and t.category = 'recurring' and t.customer_id is not null;
  if v_customer is null then
    return coalesce(NEW, OLD);  -- non-recurring / unlinked: not in the rule
  end if;

  if TG_OP in ('INSERT', 'UPDATE') and NEW.ion_item_id is not null then
    select coalesce(unit_price_cents, 0) / 100.0 into v_price
    from maintenance.consumables where ion_item_id = NEW.ion_item_id;
    v_delta := v_delta + coalesce(NEW.quantity, 0) * coalesce(v_price, 0);
  end if;
  if TG_OP in ('DELETE', 'UPDATE') and OLD.ion_item_id is not null then
    select coalesce(unit_price_cents, 0) / 100.0 into v_price
    from maintenance.consumables where ion_item_id = OLD.ion_item_id;
    v_delta := v_delta - coalesce(OLD.quantity, 0) * coalesce(v_price, 0);
  end if;
  if v_delta <> 0 then
    insert into customer_month_chem_live (customer_id, month, total_usd)
    values (v_customer, v_month, v_delta)
    on conflict (customer_id, month)
    do update set total_usd = customer_month_chem_live.total_usd + excluded.total_usd,
                  updated_at = now();
  end if;
  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists trg_chem_live_delta on maintenance.consumables_usage;
create trigger trg_chem_live_delta
  after insert or update or delete on maintenance.consumables_usage
  for each row execute function billing_audit.fn_chem_live_delta();

-- ── 3) true-up (drift backstop + initial seed) ──────────────────────
create or replace function billing_audit.rebuild_customer_month_chem(p_month date)
returns int
language plpgsql security definer
set search_path = billing_audit, public
as $$
declare v_n int;
begin
  delete from customer_month_chem_live where month = p_month;
  insert into customer_month_chem_live (customer_id, month, total_usd)
  select v.customer_id, v.month,
         (v.core_usd + v.specialty_usd + v.spa_usd + v.testing_usd
          + v.parts_usd + v.extra_service_usd + v.discount_usd)
  from v_customer_month_cpv v
  where v.month = p_month;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ── 4) live peer group from task tags + company (no rollup) ─────────
create or replace view billing_audit.v_customer_peer_group as
select c.id as customer_id,
       case
         when nullif(trim(coalesce(c.company, '')), '') is not null then 'commercial'
         when tg.max_dpw > 2 then 'high_freq_residential'
         when tg.all_lowfreq then 'low_freq'
         else 'weekly_residential'
       end as peer_group
from public."Customers" c
join lateral (
  select max(coalesce(t.days_per_week, 0)) as max_dpw,
         bool_and(t.frequency in ('monthly', 'biweekly')) as all_lowfreq
  from maintenance.tasks t
  where t.customer_id = c.id and t.category = 'recurring'
) tg on true
where exists (select 1 from maintenance.tasks t
              where t.customer_id = c.id and t.category = 'recurring');

-- ── 5) the always-current median + flag views ───────────────────────
create or replace view billing_audit.v_chem_flag_medians as
select l.month, pg.peer_group,
       percentile_cont(0.5) within group (order by l.total_usd) as median_usd,
       count(*)::int as n_customers
from billing_audit.customer_month_chem_live l
join billing_audit.v_customer_peer_group pg on pg.customer_id = l.customer_id
group by l.month, pg.peer_group;

create or replace view billing_audit.v_chem_flags as
select l.customer_id, l.month, pg.peer_group,
       round(l.total_usd, 2) as total_usd,
       round(m.median_usd::numeric, 2) as median_usd,
       round((l.total_usd / nullif(m.median_usd, 0))::numeric, 2) as x_median
from billing_audit.customer_month_chem_live l
join billing_audit.v_customer_peer_group pg on pg.customer_id = l.customer_id
join billing_audit.v_chem_flag_medians m on m.month = l.month and m.peer_group = pg.peer_group
where m.median_usd > 0
  and l.total_usd > 2.0 * m.median_usd
  and l.total_usd >= 150;

-- ── 6) projection v5: chem gate reads the live flag view ────────────
create or replace function billing_audit.project_maint_processing_status(
  p_month date,
  p_qbo_customer_id text default null
) returns int
language sql security definer
set search_path = billing_audit, public
as $$
  with target as (
    select tbp.id,
           tbp.processing_status, tbp.needs_review_reason,
           tbp.ion_matched_at, tbp.ion_amt_cents, tbp.expected_total_cents,
           tbp.qbo_invoice_id, tbp.pre_processed_at, tbp.reviewed_at,
           tbp.status as reconcile_status, tbp.qbo_customer_id,
           c.id as cust_id,
           i.balance, i.email_status, i.subtotal
    from task_billing_periods tbp
    left join public."Customers" c on c.qbo_customer_id = tbp.qbo_customer_id
    left join billing.invoices i on i.qbo_invoice_id = tbp.qbo_invoice_id
    where tbp.billing_month = p_month
      and tbp.locked_at is null
      and tbp.processing_status <> 'processed'
      and (p_qbo_customer_id is null or tbp.qbo_customer_id = p_qbo_customer_id)
  ),
  flags as (
    select f.customer_id from v_chem_flags f where f.month = p_month
  ),
  gates as (
    select t.*,
      exists (select 1 from billing.autopay_transactions x
              where x.qbo_customer_id = t.qbo_customer_id
                and x.billing_month = to_char(p_month, 'YYYY-MM')
                and coalesce(x.dry_run, false) = false
                and x.status in ('charge_success','payment_created','completed','verified'))
        as autopay_charged,
      (t.pre_processed_at is not null
        and exists (select 1 from flags f where f.customer_id = t.cust_id)
        and not exists (select 1 from customer_month_audit a
                        where a.customer_id = t.cust_id and a.month = p_month
                          and a.audit_status in ('reviewed', 'resolved')))
        as chem_flag,
      (t.pre_processed_at is not null and t.ion_matched_at is not null
        and abs(coalesce(t.ion_amt_cents, 0) - coalesce(t.expected_total_cents, 0)) > 100)
        as ion_mismatch,
      (t.pre_processed_at is not null
        and t.qbo_invoice_id is not null and t.subtotal is not null
        and abs(coalesce(t.ion_amt_cents, 0) - round(t.subtotal * 100)) > 100)
        as subtotal_mismatch,
      (t.pre_processed_at is not null and t.reconcile_status = 'mismatch')
        as reconcile_mismatch,
      (t.needs_review_reason = 'credit_error' and t.processing_status = 'needs_review')
        as credit_error
    from target t
  ),
  verdict as (
    select g.id,
      case
        when g.qbo_invoice_id is not null
             and ((g.balance is not null and g.balance <= 0
                   and g.email_status = 'EmailSent')
                  or g.autopay_charged)
          then 'processed'
        when g.ion_matched_at is null then 'pending'
        when g.chem_flag
             or (g.reviewed_at is null
                 and (g.ion_mismatch or g.subtotal_mismatch
                      or g.reconcile_mismatch or g.credit_error))
          then 'needs_review'
        when g.qbo_invoice_id is not null and g.pre_processed_at is not null
          then 'ready_to_process'
        else 'ion_matched'
      end as st,
      case
        when g.chem_flag then 'chem_flag'
        when g.reviewed_at is null and g.credit_error then 'credit_error'
        when g.reviewed_at is null and g.ion_mismatch then 'ion_amount_mismatch'
        when g.reviewed_at is null and g.subtotal_mismatch then 'subtotal_mismatch'
        when g.reviewed_at is null and g.reconcile_mismatch then 'reconcile_mismatch'
      end as reason
    from gates g
  ),
  applied as (
    update task_billing_periods tbp
    set processing_status = v.st,
        needs_review_reason = case when v.st = 'needs_review' then v.reason end,
        processed_at = case when v.st = 'processed'
                            then coalesce(tbp.processed_at, now()) end,
        updated_at = now()
    from verdict v
    where tbp.id = v.id
      and (tbp.processing_status is distinct from v.st
           or tbp.needs_review_reason is distinct from
              case when v.st = 'needs_review' then v.reason end)
    returning 1
  )
  select count(*)::int from applied;
$$;

-- ── 7) app-facing: live medians + flag context for the review card ──
create or replace function public.maint_billing_chem_medians(p_month date)
returns table (peer_group text, median_usd numeric, n_customers int)
language sql stable security definer
set search_path = billing_audit, public
as $$
  select m.peer_group, round(m.median_usd::numeric, 2), m.n_customers
  from v_chem_flag_medians m where m.month = p_month order by m.peer_group;
$$;

create or replace function public.maint_billing_chem_flags(p_month date)
returns table (customer_id bigint, peer_group text, total_usd numeric,
               median_usd numeric, x_median numeric)
language sql stable security definer
set search_path = billing_audit, public
as $$
  select f.customer_id, f.peer_group, f.total_usd, f.median_usd, f.x_median
  from v_chem_flags f where f.month = p_month;
$$;

revoke all on function public.maint_billing_chem_medians(date) from public, anon;
revoke all on function public.maint_billing_chem_flags(date) from public, anon;
grant execute on function public.maint_billing_chem_medians(date) to authenticated, service_role;
grant execute on function public.maint_billing_chem_flags(date) to authenticated, service_role;
revoke all on function billing_audit.rebuild_customer_month_chem(date) from public, anon, authenticated;
grant execute on function billing_audit.rebuild_customer_month_chem(date) to service_role;

-- ── 8) the Bills RPC's hold indicator reads the live flag view ──────
-- (same body as 20260703110000 except the hold lateral)
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
  ion_invoice_numbers       text,
  ion_match                 text,
  qbo_invoice_id            text,
  qbo_doc_number            text,
  qbo_total                 numeric,
  qbo_balance               numeric,
  reconcile_status          text,
  labor_ok                  boolean,
  consumables_ok            boolean,
  locked                    boolean,
  on_autopay                boolean,
  autopay_charged           boolean,
  invoice_sent              boolean,
  high_flag_hold            boolean,
  processing_status         text,
  needs_review_reason       text,
  reviewed_at               timestamptz,
  office                    text,
  segment                   text
)
language sql stable security definer
set search_path = billing_audit, public
as $$
  select
    tbp.id, tbp.task_id, tbp.billing_month,
    c.id, c.display_name, tbp.qbo_customer_id,
    vc.ion_task_id, vc.service_name, vc.category, vc.frequency,
    vc.days_per_week::int, vc.billing_type,
    tbp.billing_method, tbp.billable_visit_count,
    tbp.expected_labor_cents, tbp.expected_consumable_cents, tbp.expected_total_cents,
    (select count(*) from jsonb_object_keys(coalesce(tbp.unpriced_consumables, '{}'::jsonb)))::int,
    tbp.ion_amt_cents, tbp.ion_invoice_number,
    case when tbp.ion_matched_at is null then 'missing'
         when abs(coalesce(tbp.ion_amt_cents, 0) - coalesce(tbp.expected_total_cents, 0)) <= 100
           then 'match'
         else 'mismatch' end,
    tbp.qbo_invoice_id, i.doc_number, i.total_amt, i.balance,
    tbp.status, tbp.labor_ok, tbp.consumables_ok,
    (tbp.locked_at is not null),
    (tbp.autopay_customer_id is not null or ac.qbo_customer_id is not null),
    (apt.charged is true),
    (mi.send_status = 'sent' or i.email_status = 'EmailSent'),
    (hold.held is true),
    tbp.processing_status,
    tbp.needs_review_reason,
    tbp.reviewed_at,
    b.name,
    case when nullif(c.company, '') is not null then 'commercial' else 'residential' end
  from task_billing_periods tbp
  left join public."Customers" c on c.qbo_customer_id = tbp.qbo_customer_id
  left join public.branches b on b.id = c.office_id
  left join maintenance.v_task_class vc on vc.task_id = tbp.task_id
  left join billing.invoices i on i.qbo_invoice_id = tbp.qbo_invoice_id
  left join maintenance_invoices mi on mi.qbo_invoice_id = tbp.qbo_invoice_id
  left join billing.autopay_customers ac
    on ac.qbo_customer_id = tbp.qbo_customer_id and ac.is_active
  left join lateral (
    select true as charged
    from billing.autopay_transactions t
    where t.qbo_customer_id = tbp.qbo_customer_id
      and t.billing_month = to_char(p_month, 'YYYY-MM')
      and coalesce(t.dry_run, false) = false
      and t.status in ('charge_success', 'payment_created', 'completed', 'verified')
    limit 1
  ) apt on true
  left join lateral (
    select true as held
    from v_chem_flags f
    where f.customer_id = c.id and f.month = p_month
      and not exists (select 1 from customer_month_audit a
                      where a.customer_id = c.id and a.month = p_month
                        and a.audit_status in ('reviewed', 'resolved'))
    limit 1
  ) hold on true
  where tbp.billing_month = p_month;
$$;

revoke all on function public.maint_billing_periods(date) from public, anon;
grant execute on function public.maint_billing_periods(date) to authenticated, service_role;

-- ── 9) retire the checkpoint chain; seed the live table ─────────────
drop function if exists billing_audit.refresh_chem_flags(date);
drop table if exists billing_audit.chem_flag_snapshot;
drop table if exists billing_audit.chem_flag_medians;
drop table if exists billing_audit.customer_month_cpv_snapshot;

select billing_audit.rebuild_customer_month_chem('2026-06-01');
select billing_audit.rebuild_customer_month_chem('2026-07-01');
select billing_audit.project_maint_processing_status('2026-06-01');
select billing_audit.project_maint_processing_status('2026-07-01');

notify pgrst, 'reload schema';
