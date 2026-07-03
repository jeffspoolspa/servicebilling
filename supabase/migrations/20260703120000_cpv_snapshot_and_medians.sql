-- Chem-flag pipeline, restructured per Carter (2026-07-03):
--
--   v_customer_month_cpv stays the live source of truth (a view — always
--   current with upserted visits, but recomputes the whole rollup on every
--   reference). refresh_chem_flags(month) materializes it ONCE into:
--
--   1) customer_month_cpv_snapshot — per customer-month: peer group, visits,
--      net consumable total.
--   2) chem_flag_medians — ONE ROW PER (month, peer_group): the PLAIN median
--      of total_usd over ALL the group's customers (simplified per Carter:
--      provides-chems customers are now INCLUDED — the clean-median exclusion
--      is dropped). "What's the median?" is now one indexed query.
--   3) chem_flag_snapshot — the flag set the projection + Bills RPC read:
--      total_usd > 2x the group median AND total_usd >= $150.
--
--   The drainer refreshes once per tick (only when the queue has work), so a
--   500-row drain computes the medians once, not per row. The hourly
--   reconcile and the Refresh-bills pull also refresh.

create table if not exists billing_audit.customer_month_cpv_snapshot (
  customer_id    bigint not null,
  month          date not null,
  peer_group     text,
  provides_chems boolean,
  visits         numeric,
  total_usd      numeric,
  computed_at    timestamptz not null default now(),
  primary key (customer_id, month)
);

create table if not exists billing_audit.chem_flag_medians (
  month        date not null,
  peer_group   text not null,
  median_usd   numeric,
  n_customers  int,
  computed_at  timestamptz not null default now(),
  primary key (month, peer_group)
);

create or replace function billing_audit.refresh_chem_flags(p_month date)
returns int
language plpgsql security definer
set search_path = billing_audit, public
as $$
declare v_n int;
begin
  -- 1) materialize the month's CPV rollup (the one expensive step, ~3.5s)
  delete from customer_month_cpv_snapshot where month = p_month;
  insert into customer_month_cpv_snapshot
    (customer_id, month, peer_group, provides_chems, visits, total_usd)
  select v.customer_id, v.month, v.peer_group, v.provides_chems, v.visits,
         (v.core_usd + v.specialty_usd + v.spa_usd + v.testing_usd
          + v.parts_usd + v.extra_service_usd + v.discount_usd)
  from v_customer_month_cpv v
  where v.month = p_month;

  -- 2) plain median per peer group (ALL customers, provides-chems included)
  delete from chem_flag_medians where month = p_month;
  insert into chem_flag_medians (month, peer_group, median_usd, n_customers)
  select s.month, s.peer_group,
         percentile_cont(0.5) within group (order by s.total_usd),
         count(*)::int
  from customer_month_cpv_snapshot s
  where s.month = p_month and s.peer_group is not null
  group by s.month, s.peer_group;

  -- 3) the flag set: > 2x the group median AND >= $150
  delete from chem_flag_snapshot where month = p_month;
  insert into chem_flag_snapshot (customer_id, month, total_usd, group_clean_median, x_median)
  select s.customer_id, s.month,
         round(s.total_usd, 2),
         round(m.median_usd, 2),
         round(s.total_usd / nullif(m.median_usd, 0), 2)
  from customer_month_cpv_snapshot s
  join chem_flag_medians m on m.month = s.month and m.peer_group = s.peer_group
  where s.month = p_month
    and m.median_usd > 0
    and s.total_usd > 2.0 * m.median_usd
    and s.total_usd >= 150;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- refresh the open months under the simplified rule
select billing_audit.refresh_chem_flags('2026-06-01');
select billing_audit.refresh_chem_flags('2026-07-01');
select billing_audit.project_maint_processing_status('2026-06-01');
select billing_audit.project_maint_processing_status('2026-07-01');
