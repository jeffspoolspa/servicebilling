-- provides-chems flag is RESIDENTIAL-ONLY (Carter, 2026-07-02).
--
-- The "Customer Tabs (Not to be billed)" reading tagged 45 commercial properties, but for
-- commercial it means the property keeps bulk stock (often bought from us separately) -- their
-- maintenance bills are NOT low (provider median $812 vs $318 non-provider). The low-bill
-- adjustment only holds for residential (provider median $76 vs $125 clean). Clear the flag on
-- commercial (company-filled) customers' tasks; backfills/audits must exclude commercial.
--
-- Also codifies the blessed review rule as billing_audit.v_billing_review_flags:
--   flag = June-style monthly NET consumable bill > 2.5x the group's CLEAN median AND >= $150
--   clean median: residential groups exclude provides_chems pools; commercial uses all
--   provides_chems pools are still flaggable (a provider exceeding the threshold despite own
--   chems is extra signal).

update maintenance.tasks t
set customer_provides_chems = false
from public."Customers" c
where c.id = t.customer_id
  and t.customer_provides_chems
  and nullif(trim(coalesce(c.company,'')),'') is not null;

comment on column maintenance.tasks.customer_provides_chems is
  'RESIDENTIAL ONLY: customer supplies (some) chemicals -- tabs/chems kept on site, used before selling ours. Sources: "Customer Tabs (Not to be billed)" readings + ION recurring notes (exclude commercial when backfilling). Low consumable bills are EXPECTED on these tasks; review rules use clean medians that exclude them.';

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
  and m.total_usd > 2.5 * md.clean_median
  and m.total_usd >= 150;

comment on view billing_audit.v_billing_review_flags is
  'Pre-send review list: monthly net consumable bill > 2.5x the peer group''s clean median (residential medians exclude provides-chems pools; commercial uses all) AND >= $150. Hold these from autopay/sending until reviewed. Simple companion to the z-score audit (customer_month_audit).';
