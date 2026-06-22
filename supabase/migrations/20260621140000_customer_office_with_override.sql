-- ADR 007 §9: office is an attribute of the CUSTOMER (geography-derived from the service
-- address, manually overridable) and, separately, of the TECH (employees.branch_id). Routes
-- are tech x day, so a route's office is the TECH's office (handled in the routing views, next
-- PR). This migration makes the CUSTOMER side authoritative + overridable and keeps it fresh.
--
-- Before: Customers.office_id was a ONE-TIME backfill from the representative service location
-- (migration 20260621130000 §4) with no ongoing sync and no override -- it went stale on every
-- re-geocode / merge. Now it self-heals via a trigger and supports a sticky manual override.

alter table public."Customers"
  add column if not exists office_overridden boolean not null default false,
  add column if not exists office_set_by uuid,
  add column if not exists office_set_at timestamptz;

comment on column public."Customers".office_overridden is
  'true = office_id was set manually and must NOT be auto-recomputed from the service address (ADR 007 §9).';

-- Recompute a customer's office from their REPRESENTATIVE active service location (primary
-- first, then most-recently geocoded). No-op when manually overridden. office_id is the nearest
-- branch to that location''s rooftop coordinate (already computed on service_locations.office_id
-- by trg_set_sl_office).
create or replace function public.recompute_customer_office(p_customer_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_office uuid;
  v_dist numeric;
begin
  if p_customer_id is null then return; end if;
  if exists (select 1 from public."Customers" where id = p_customer_id and office_overridden) then
    return;
  end if;
  select sl.office_id, sl.office_distance_mi
    into v_office, v_dist
  from public.service_locations sl
  where sl.account_id = p_customer_id and sl.is_active and sl.office_id is not null
  order by sl.is_primary desc nulls last, sl.geocoded_at desc nulls last
  limit 1;
  -- office_out_of_range is a generated column (from office_distance_mi) -- never set directly.
  update public."Customers"
     set office_id = v_office,
         office_distance_mi = v_dist,
         office_resolved_at = now()
   where id = p_customer_id
     and (office_id is distinct from v_office or office_distance_mi is distinct from v_dist);
end
$function$;

-- Keep it fresh: when a service location's office changes (re-geocode / edit / merge) or it
-- moves accounts / (de)activates, recompute the owning customer's office (unless overridden).
create or replace function public.sync_customer_office_from_sl()
returns trigger
language plpgsql
as $function$
begin
  if tg_op = 'UPDATE' and old.account_id is distinct from new.account_id and old.account_id is not null then
    perform public.recompute_customer_office(old.account_id);
  end if;
  perform public.recompute_customer_office(new.account_id);
  return null;
end
$function$;

drop trigger if exists trg_sync_customer_office on public.service_locations;
create trigger trg_sync_customer_office
  after insert or update of office_id, account_id, is_primary, is_active
  on public.service_locations
  for each row execute function public.sync_customer_office_from_sl();

-- Manual override (sticky): set the office by hand and lock it from auto-recompute.
create or replace function public.set_customer_office(p_customer_id bigint, p_office_id uuid, p_user uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  update public."Customers"
     set office_id = p_office_id,
         office_overridden = true,
         office_set_by = p_user,
         office_set_at = now(),
         office_resolved_at = now(),
         office_distance_mi = null
   where id = p_customer_id;
end
$function$;

-- Release the override -> fall back to the geographic office.
create or replace function public.clear_customer_office_override(p_customer_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  update public."Customers"
     set office_overridden = false, office_set_by = null, office_set_at = null
   where id = p_customer_id;
  perform public.recompute_customer_office(p_customer_id);
end
$function$;

grant execute on function public.recompute_customer_office(bigint) to authenticated, service_role, anon;
grant execute on function public.set_customer_office(bigint, uuid, uuid) to authenticated, service_role, anon;
grant execute on function public.clear_customer_office_override(bigint) to authenticated, service_role, anon;

-- Backfill: refresh every non-overridden customer from its current representative service
-- location (the prior one-time backfill is stale after this session's re-geocodes + merges).
with rep as (
  select distinct on (sl.account_id)
         sl.account_id as cid, sl.office_id, sl.office_distance_mi
  from public.service_locations sl
  where sl.account_id is not null and sl.is_active and sl.office_id is not null
  order by sl.account_id, sl.is_primary desc nulls last, sl.geocoded_at desc nulls last
)
update public."Customers" c
   set office_id = rep.office_id,
       office_distance_mi = rep.office_distance_mi,
       office_resolved_at = now()
from rep
where rep.cid = c.id
  and not c.office_overridden
  and (c.office_id is distinct from rep.office_id or c.office_distance_mi is distinct from rep.office_distance_mi);
