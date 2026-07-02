-- Review rule v2 (Carter, 2026-07-02): flag at 2x the group's clean median (was 2.5x). Pool volume
-- is the missing normalizer -- until it is captured from ION, cast a wider net and review manually.
-- $150 absolute floor retained (drops sub-$150 low_freq noise); drop it by removing one predicate.

create or replace view billing_audit.v_billing_review_flags as
with m as (
  select customer_id, display_name, month, peer_group, provides_chems, visits,
         (core_usd+specialty_usd+spa_usd+testing_usd+parts_usd+extra_service_usd+discount_usd) as total_usd
  from billing_audit.v_customer_month_cpv),
med as (
  select month, peer_group,
         percentile_cont(0.5) within group (order by total_usd)
           filter (where peer_group = 'commercial' or not provides_chems) as clean_median
  from m group by 1,2)
select m.customer_id, m.display_name, m.month, m.peer_group, m.provides_chems, m.visits,
       round(m.total_usd::numeric,2) as total_usd,
       round(md.clean_median::numeric,2) as group_clean_median,
       round((m.total_usd / nullif(md.clean_median,0))::numeric,2) as x_median
from m
join med md on md.month = m.month and md.peer_group = m.peer_group
where md.clean_median > 0
  and m.total_usd > 2.0 * md.clean_median
  and m.total_usd >= 150;
