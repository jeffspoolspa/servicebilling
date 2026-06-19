-- ADR 005 — ADDRESS-LIST cleanup (dedupe). The guarded resolve pass produced 132
-- rows whose corrected place_id already exists as a canonical 'ok' address
-- (Google-confirmed same building) — i.e. duplicate ADDRESS rows. This is purely
-- about the address list: fold each duplicate into its canonical so the list holds
-- one row per real address.
--
-- The customer link is NOT a merge decision here. The link table holds many
-- customers per address (owners over time, property managers, etc.); the only
-- constraint is one ACTIVE customer per address. So we just move the duplicate's
-- customer link onto the canonical as INACTIVE and repoint history; which customer
-- is active at each multi-customer address is determined separately.
do $$
declare r record;
begin
  for r in
    select dup.id as loser, dup.duplicate_of_location_id as survivor, dup.account_id as loser_owner
    from public.service_locations dup
    join public.service_locations can on can.id = dup.duplicate_of_location_id
    where dup.geocode_status = 'needs_review'
      and dup.duplicate_of_location_id is not null
      and can.geocode_status = 'ok'
  loop
    -- repoint all history onto the surviving canonical address row
    update public.pools                       set service_location_id = r.survivor where service_location_id = r.loser;
    update maintenance.service_bodies         set location_id         = r.survivor where location_id         = r.loser;
    update maintenance.tasks                  set service_location_id = r.survivor where service_location_id = r.loser;
    update maintenance.visits                 set service_location_id = r.survivor where service_location_id = r.loser;
    update billing_audit.task_billing_periods set service_location_id = r.survivor where service_location_id = r.loser;
    update ion.recurring_tasks                set service_location_id = r.survivor where service_location_id = r.loser;

    -- move the customer link onto the canonical (inactive; active owner decided later)
    delete from public.customer_service_addresses where service_location_id = r.loser;
    insert into public.customer_service_addresses (customer_id, service_location_id, is_active)
      values (r.loser_owner, r.survivor, false)
      on conflict (customer_id, service_location_id) do nothing;

    -- drop the duplicate address row
    delete from public.service_locations where id = r.loser;
  end loop;
end $$;
