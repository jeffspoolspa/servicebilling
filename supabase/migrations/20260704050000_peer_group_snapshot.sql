-- Peer groups become a snapshot TABLE. v_customer_peer_group recomputes each
-- customer's group from task aggregates on EVERY evaluation — and the median
-- + flag views join it, so every maint_billing_periods call, projection, and
-- Needs Review render re-derived ~480 customers' groups (~1.5s intrinsic,
-- >8s statement timeouts under burst load). Peer groups only change when a
-- task's frequency or the customer's company changes: snapshot them and
-- refresh cheaply (drainer tick + hourly reconcile).
-- v_customer_peer_group (the live derivation) stays for the refresh + audits.

create table if not exists billing_audit.customer_peer_group (
  customer_id  bigint primary key,
  peer_group   text not null,
  refreshed_at timestamptz not null default now()
);

create or replace function billing_audit.refresh_customer_peer_groups()
returns integer
language plpgsql security definer
set search_path = billing_audit, public
as $$
declare v_n int;
begin
  insert into customer_peer_group (customer_id, peer_group, refreshed_at)
  select pg.customer_id, pg.peer_group, now()
  from v_customer_peer_group pg
  on conflict (customer_id) do update
    set peer_group = excluded.peer_group, refreshed_at = now()
    where customer_peer_group.peer_group is distinct from excluded.peer_group;
  get diagnostics v_n = row_count;
  delete from customer_peer_group cpg
  where not exists (select 1 from v_customer_peer_group pg
                    where pg.customer_id = cpg.customer_id);
  return v_n;
end;
$$;

select billing_audit.refresh_customer_peer_groups();

-- medians + flags read the snapshot
create or replace view billing_audit.v_chem_flag_medians as
select l.month, pg.peer_group,
       percentile_cont(0.5) within group (order by l.total_usd) as median_usd,
       count(*)::int as n_customers
from billing_audit.customer_month_chem_live l
join billing_audit.customer_peer_group pg on pg.customer_id = l.customer_id
group by l.month, pg.peer_group;

create or replace view billing_audit.v_chem_flags as
select l.customer_id, l.month, pg.peer_group,
       round(l.total_usd, 2) as total_usd,
       round(m.median_usd::numeric, 2) as median_usd,
       round((l.total_usd / nullif(m.median_usd, 0))::numeric, 2) as x_median
from billing_audit.customer_month_chem_live l
join billing_audit.customer_peer_group pg on pg.customer_id = l.customer_id
join billing_audit.v_chem_flag_medians m on m.month = l.month and m.peer_group = pg.peer_group
where m.median_usd > 0
  and l.total_usd > 2.0 * m.median_usd
  and l.total_usd >= 150;
