-- PostgREST exposes only public, graphql_public, app_checks, maintenance,
-- billing_audit and billing — so functions in `ion` are unreachable from the
-- app, which has no PG driver and can only call RPCs. The lease TABLE stays in
-- `ion` (it is ION's session, not maintenance's); the callable face moves here.
CREATE OR REPLACE FUNCTION maintenance.acquire_ion_session_lease(
  p_holder text, p_purpose text, p_ttl_seconds int DEFAULT 60
) RETURNS TABLE (acquired boolean, held_by text, held_for text, expires_at timestamptz)
LANGUAGE sql AS $$ SELECT * FROM ion.acquire_session_lease(p_holder, p_purpose, p_ttl_seconds) $$;

CREATE OR REPLACE FUNCTION maintenance.renew_ion_session_lease(p_holder text, p_ttl_seconds int DEFAULT 60)
RETURNS boolean LANGUAGE sql AS $$ SELECT ion.renew_session_lease(p_holder, p_ttl_seconds) $$;

CREATE OR REPLACE FUNCTION maintenance.release_ion_session_lease(p_holder text)
RETURNS boolean LANGUAGE sql AS $$ SELECT ion.release_session_lease(p_holder) $$;

GRANT EXECUTE ON FUNCTION maintenance.acquire_ion_session_lease(text, text, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION maintenance.renew_ion_session_lease(text, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION maintenance.release_ion_session_lease(text) TO authenticated, service_role;

-- The event log was append-only in principle and not in practice: authenticated
-- held INSERT, UPDATE and DELETE, so history could be rewritten by anything
-- with a user session. The append RPC was assumed to be the guarantee; it was
-- not. Correcting a fact means appending another, never editing the old one —
-- otherwise the log cannot be replayed and its projections are not reproducible.
REVOKE UPDATE, DELETE ON maintenance.events FROM authenticated;
REVOKE UPDATE, DELETE ON maintenance.events FROM anon;

COMMENT ON TABLE maintenance.events IS
  'Append-only fact log. UPDATE/DELETE revoked from authenticated (2026-08-05) — correcting a fact means appending another, never editing history.';
