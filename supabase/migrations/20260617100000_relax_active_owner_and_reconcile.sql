-- ADR 005: relax "one active customer per address" and reconcile active owners from
-- the maintenance.tasks status. "Active" now lives on the customer (a customer is active
-- when they have a status='active', not-ended task); the link's is_active just reflects
-- which linked customer is current at a shared address. During this messy 20-year-history
-- migration we allow multiple active links and decide ambiguous shared addresses later.

-- 1. Relax the constraint.
drop index if exists public.uq_csa_one_active_per_location;

-- 2. Easy cleanup: at a MULTI-customer address with exactly ONE active-task customer,
--    that customer is the active owner; the rest become inactive. (e.g. 179 Zellwood:
--    BUTLER has the active task and becomes active; HORNER's task is closed -> inactive.)
--    Single-customer addresses are untouched; multi-customer addresses with zero or >1
--    active-task customers are left for the later rules pass.
with per_link as (
  select csa.service_location_id as loc, csa.customer_id,
         exists(select 1 from maintenance.tasks t
                where t.customer_id=csa.customer_id and t.status='active'
                  and (t.ends_on is null or t.ends_on>=current_date)) as has_active
  from public.customer_service_addresses csa
),
per_addr as (
  select loc, count(*) ncust, count(*) filter (where has_active) nactive,
         (array_agg(customer_id) filter (where has_active))[1] as winner
  from per_link group by loc
),
targets as (select loc, winner from per_addr where ncust>1 and nactive=1)
update public.customer_service_addresses csa
set is_active = (csa.customer_id = t.winner), updated_at = now()
from targets t
where csa.service_location_id = t.loc
  and is_active is distinct from (csa.customer_id = t.winner);
