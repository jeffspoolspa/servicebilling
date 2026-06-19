-- ADR 005: bulk-collapse residential same-address duplicates surfaced by the
-- full-base resolve. Each duplicate (duplicate_of_location_id set, street EXACTLY
-- matching its canonical, both accounts residential, non-test) folds into its
-- canonical row: repoint every maintenance/billing/ION FK, turn the prior owner
-- into an inactive customer_service_addresses link, delete the duplicate row.
--
-- Deliberately NOT collapsed (left for review): the 67 commercial-involved pairs
-- (could be shared complexes, e.g. THE LODGE vs THE CLOISTER), the 632 different-
-- street artifacts (street-only rows Google lumped onto one coarse place_id —
-- not real duplicates), and test accounts.

do $$
declare r record;
begin
  for r in
    select sl.id as loser, sl.duplicate_of_location_id as survivor, sl.account_id as loser_owner
    from public.service_locations sl
    join public.service_locations can on can.id = sl.duplicate_of_location_id
    join public."Customers" dc on dc.id = sl.account_id
    join public."Customers" cc on cc.id = can.account_id
    where sl.is_active
      and upper(btrim(sl.street)) = upper(btrim(can.street))
      and dc.account_type = 'residential' and cc.account_type = 'residential'
      and dc.display_name not ilike '%test%' and cc.display_name not ilike '%test%'
  loop
    update public.pools                       set service_location_id = r.survivor where service_location_id = r.loser;
    update maintenance.service_bodies         set location_id         = r.survivor where location_id         = r.loser;
    update maintenance.tasks                  set service_location_id = r.survivor where service_location_id = r.loser;
    update maintenance.visits                 set service_location_id = r.survivor where service_location_id = r.loser;
    update billing_audit.task_billing_periods set service_location_id = r.survivor where service_location_id = r.loser;
    update ion.recurring_tasks                set service_location_id = r.survivor where service_location_id = r.loser;

    delete from public.customer_service_addresses where service_location_id = r.loser;
    insert into public.customer_service_addresses (customer_id, service_location_id, is_active)
      values (r.loser_owner, r.survivor, false)
      on conflict (customer_id, service_location_id) do nothing;

    delete from public.service_locations where id = r.loser;
  end loop;
end $$;
