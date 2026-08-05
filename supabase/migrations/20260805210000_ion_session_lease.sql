-- ION is ONE shared browser session (f/ION/_lib/session_cache: "Shared across
-- all ION API endpoints"), and EVERY entry point writes server-side context
-- before it reads — enumerated 2026-08-05: customerTabs.cfm priming, the
-- reports set=1 filter chain, customerlist's reset=1. There is no entry point
-- that does not. Two callers interleaving do not merely collide; one silently
-- reads under the other's context, and a transactions report whose window
-- moved mid-pull writes wrong facts into billing.
--
-- A LEASE, not pg_advisory_lock: the app reaches Postgres through PostgREST,
-- so every call is a new connection and a connection-scoped lock would release
-- instantly. Holders RENEW while alive, so a crash frees ION in ~a TTL instead
-- of wedging it for the longest job (the day-grid ingest runs ~45 minutes).
CREATE SCHEMA IF NOT EXISTS ion;

CREATE TABLE IF NOT EXISTS ion.session_lease (
  id text PRIMARY KEY DEFAULT 'ion',
  holder text, purpose text,
  acquired_at timestamptz, renewed_at timestamptz, expires_at timestamptz,
  CONSTRAINT one_session CHECK (id = 'ion')
);
INSERT INTO ion.session_lease (id) VALUES ('ion') ON CONFLICT DO NOTHING;

-- ONE statement, so the row lock decides the winner — no read-then-write race.
-- Re-entrant: the same holder re-acquiring extends, so a retry cannot deadlock
-- against itself.
CREATE OR REPLACE FUNCTION ion.acquire_session_lease(
  p_holder text, p_purpose text, p_ttl_seconds int DEFAULT 60
) RETURNS TABLE (acquired boolean, held_by text, held_for text, expires_at timestamptz)
LANGUAGE plpgsql AS $$
DECLARE r ion.session_lease;
BEGIN
  UPDATE ion.session_lease l
     SET holder = p_holder, purpose = p_purpose,
         acquired_at = CASE WHEN l.holder = p_holder THEN l.acquired_at ELSE now() END,
         renewed_at = now(), expires_at = now() + make_interval(secs => p_ttl_seconds)
   WHERE l.id = 'ion'
     AND (l.holder IS NULL OR l.expires_at < now() OR l.holder = p_holder)
  RETURNING * INTO r;
  IF FOUND THEN RETURN QUERY SELECT true, r.holder, r.purpose, r.expires_at;
  ELSE SELECT * INTO r FROM ion.session_lease WHERE id = 'ion';
       RETURN QUERY SELECT false, r.holder, r.purpose, r.expires_at;
  END IF;
END $$;

-- Fails if the lease was lost — the caller must stop touching ION.
CREATE OR REPLACE FUNCTION ion.renew_session_lease(p_holder text, p_ttl_seconds int DEFAULT 60)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  UPDATE ion.session_lease SET renewed_at = now(), expires_at = now() + make_interval(secs => p_ttl_seconds)
   WHERE id = 'ion' AND holder = p_holder AND expires_at >= now();
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$;

CREATE OR REPLACE FUNCTION ion.release_session_lease(p_holder text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  UPDATE ion.session_lease SET holder = NULL, purpose = NULL, expires_at = NULL
   WHERE id = 'ion' AND holder = p_holder;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$;

CREATE OR REPLACE VIEW ion.v_session_lease AS
SELECT holder, purpose, acquired_at, renewed_at, expires_at,
       expires_at < now() AS expired,
       round(EXTRACT(epoch FROM (now() - acquired_at))::numeric, 1) AS held_seconds
FROM ion.session_lease WHERE id = 'ion';

GRANT USAGE ON SCHEMA ion TO authenticated, service_role;
GRANT SELECT ON ion.v_session_lease TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION ion.acquire_session_lease(text, text, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION ion.renew_session_lease(text, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION ion.release_session_lease(text) TO authenticated, service_role;
