-- ADR 005, Phase 2: collapse same-address rows into one canonical service address.
--
-- The 10 place_id collisions resolved (verified with the owner) to: 9 residential
-- owner-changes + 1 data-entry typo. Each owner-change keeps the CURRENT owner's row
-- (survivor) and folds the prior owner's row (loser) into it — repointing EVERY
-- service_location_id reference (incl. non-FK billing/ION) so nothing is stranded,
-- recording the prior owner as an inactive customer_service_addresses link, then
-- deleting the duplicate. Attribution is preserved by the explicit customer_id on
-- tasks/visits added in Phase 3.
--
-- Residual: a collapsed address can carry duplicate pool records (one per former
-- owner's account). Harmless for billing/routing; a pool-dedup pass is future work.

-- Data fix: Island Square is 2400 Demere Rd (mis-entered as 2505, which is Island
-- Retreat). Re-point it at its real, distinct place_id so the collision dissolves.
update public.service_locations
   set street='2400 DEMERE RD', place_id='ChIJi8sb8YLQ5IgRca-Q-eqP224',
       latitude=31.159447, longitude=-81.39263,
       geocode_status='ok', geocode_source='google', geocoded_at=now(), updated_at=now()
 where id=8398;

do $$
declare
  pair record;
  v_prior bigint;
begin
  for pair in select * from (values
      (1222,5803),(6774,4552),(1901,4090),(6228,6833),(9917,1468),
      (4312,4152),(3445,3320),(7622,7417),(8481,8560)
    ) as p(survivor, loser)
  loop
    select account_id into v_prior from public.service_locations where id = pair.loser;

    -- repoint every reference (FK + non-FK) loser -> survivor
    update public.pools                       set service_location_id = pair.survivor where service_location_id = pair.loser;
    update maintenance.service_bodies         set location_id         = pair.survivor where location_id         = pair.loser;
    update maintenance.tasks                  set service_location_id = pair.survivor where service_location_id = pair.loser;
    update maintenance.visits                 set service_location_id = pair.survivor where service_location_id = pair.loser;
    update billing_audit.task_billing_periods set service_location_id = pair.survivor where service_location_id = pair.loser;
    update ion.recurring_tasks                set service_location_id = pair.survivor where service_location_id = pair.loser;

    -- prior owner becomes an INACTIVE link on the survivor address
    delete from public.customer_service_addresses where service_location_id = pair.loser;
    insert into public.customer_service_addresses (customer_id, service_location_id, is_active)
      values (v_prior, pair.survivor, false)
      on conflict (customer_id, service_location_id) do update set is_active = false;

    -- remove the now-duplicate loser address row
    delete from public.service_locations where id = pair.loser;
  end loop;
end $$;

-- place_id is now globally unique. Every collision was an owner-change (collapsed)
-- or a typo (fixed); genuine complexes are modeled as one address with many pools.
create unique index if not exists uq_service_locations_place_id
  on public.service_locations (place_id) where place_id is not null;
