-- Drop the dead "Gen-1" lead RPCs that read/write tables which no longer exist.
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- Follow-up to 20260603000000_leads_gen2_make_whole.sql and ADR 004. The audit
-- (~/.claude/plans/snoopy-hugging-lantern.md) classified every lead RPC by the
-- table it touches. The functions below all reference a flat "Gen-1" table that
-- was dropped long ago — `maintenance.leads` or `maintenance.maintenance_leads`
-- (verified absent: to_regclass(...) IS NULL for both). They therefore error on
-- every call today; nothing live depends on them working. The canonical Gen-2
-- equivalents (get_maintenance_leads, get_maintenance_lead_detail,
-- update_maintenance_lead, bulk_update_lead_status, add_lead_note, mark_*,
-- submit_maintenance_onboarding) replace them.
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- Plain DROP FUNCTION IF EXISTS per signature (NOT CASCADE) — if any unexpected
-- dependency exists, this fails loudly rather than silently cascading. add_maintenance_lead_note
-- exists in both public and maintenance and both write the nonexistent
-- maintenance.maintenance_leads; both are dropped.
--
-- ─────────────────────────────────────────────────────────────────
-- WHAT WE KEEP / WHAT WE LOSE
-- ─────────────────────────────────────────────────────────────────
-- KEEP: every Gen-2 RPC, the public-wrapper/maintenance-impl pairs, and all data.
-- LOSE: only broken functions. Their behavior was already 100% error. If the
--   external website repo references any of these, it was already failing on them;
--   dropping changes "table does not exist" into "function does not exist", no
--   functional regression. Recover from git + this file if a Gen-1 path is ever revived.

drop function if exists public.get_lead_by_token(text);
drop function if exists public.get_leads(text, text, text, text, integer, integer);
drop function if exists public.get_onboarding_records(text);
drop function if exists public.link_lead_to_existing_customer(uuid, bigint);
drop function if exists public.submit_onboarding(uuid, text, text, text, text, text, text, text, text, text, text, integer);
drop function if exists public.submit_onboarding(uuid, text, text, text, text, text, text, text, text, text, date);
drop function if exists public.update_lead_contact(uuid, text, text, text, text);
drop function if exists public.update_lead_details(uuid, text, text, boolean, text, text, boolean, boolean, numeric, numeric, text);
drop function if exists public.update_lead_status(uuid, text);
drop function if exists public.add_maintenance_lead_note(uuid, text, text);
drop function if exists maintenance.add_maintenance_lead_note(uuid, text, text);

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK — the dead names are gone; a canonical sample still present.
-- ─────────────────────────────────────────────────────────────────
do $$
declare
  v_dead int;
begin
  select count(*) into v_dead
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname='public'  and p.proname in
          ('get_lead_by_token','get_leads','get_onboarding_records',
           'link_lead_to_existing_customer','submit_onboarding','update_lead_contact',
           'update_lead_details','update_lead_status','add_maintenance_lead_note'))
     or (n.nspname='maintenance' and p.proname='add_maintenance_lead_note');
  if v_dead <> 0 then
    raise exception 'expected 0 dead Gen-1 lead RPCs, found %', v_dead;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='get_maintenance_leads'
  ) then
    raise exception 'canonical get_maintenance_leads missing — over-dropped';
  end if;
end $$;
