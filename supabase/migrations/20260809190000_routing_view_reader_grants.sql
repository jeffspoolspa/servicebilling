-- Applied via MCP 2026-08-09 (routing_view_authenticated_read + routing_view_anon_read).
-- INCIDENT: the 2026-08-09 UI repoint granted the routing floor to
-- service_role only, but the routes page reads as the SIGNED-IN user
-- (createSupabaseServer -> authenticated/anon). Every read failed and the
-- page 500'd in production. The view is security_invoker, so its
-- underlying tables need the same read grant.
grant usage on schema routing, agreements to authenticated, anon;
grant select on routing.v_current_placements to authenticated, anon;
grant select on agreements.service_agreements to authenticated, anon;
grant select on agreements.terms_versions to authenticated, anon;
grant select on agreements.ion_incarnations to authenticated, anon;
grant select on agreements.intake_translations to authenticated, anon;
grant select on routing.quotas to authenticated, anon;
grant select on routing.placement_versions to authenticated, anon;
notify pgrst, 'reload config';
