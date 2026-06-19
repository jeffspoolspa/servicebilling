-- Refine v_unresolved_service_addresses: "unresolved" = NO valid address at all
-- (active OR inactive link). A customer linked *inactively* to an already-valid address
-- (the 2nd+ customer at a shared address, e.g. BUTLER at 179 Zellwood that HORNER actively
-- holds) is NOT an address gap — that's the separate active-owner decision. Dropping the
-- `csa.is_active` qualifier on the anti-join excludes them so the review surface stops
-- conflating "needs an address" with "needs an active-owner pick".
create or replace view public.v_unresolved_service_addresses as
with sv as (
  select cu.id, cu.display_name, cu.account_type, cu.qbo_customer_id,
         exists (select 1 from maintenance.tasks t where t.customer_id=cu.id) as serviced
  from public."Customers" cu
  where cu.is_active
    and not exists (
      select 1 from public.customer_service_addresses csa
      join public.service_locations sl on sl.id=csa.service_location_id
      where csa.customer_id=cu.id and sl.geocode_status='ok')   -- active OR inactive
),
r as (
  select distinct on (sv.id)
    sv.id as customer_id, sv.display_name, sv.account_type, sv.serviced,
    sl.street as our_street, sl.city as our_city,
    rt.service_address as ion_street, rt.city as ion_city, rt.zip as ion_zip
  from sv
  left join public.customer_service_addresses csa on csa.customer_id=sv.id and csa.is_active
  left join public.service_locations sl on sl.id=csa.service_location_id
  left join ion.recurring_tasks rt on rt.qbo_customer_id = sv.qbo_customer_id
  order by sv.id, rt.synced_at desc nulls last
)
select *,
  case
    when coalesce(nullif(btrim(ion_street),''), nullif(btrim(our_street),'')) is null then 'no_address_anywhere'
    when (ion_street ~* 'cottage|oceanside') or (our_street ~* 'cottage|oceanside')   then 'resort_cottage'
    when nullif(btrim(ion_street),'') is not null
         and (nullif(btrim(ion_city),'') is not null or nullif(btrim(ion_zip),'') is not null) then 'ion_has_full_address'
    when nullif(btrim(ion_street),'') is not null                                     then 'ion_missing_city_zip'
    else 'ours_only_unresolved'
  end as pattern
from r;
