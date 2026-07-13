-- Field follow-up tickets: maintenance.follow_ups table (row-as-outbox to
-- Airtable), two org-wide read RPCs, wake trigger, and the follow-ups
-- storage bucket.
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- Techs currently file field follow-ups through an Airtable form feeding the
-- "Maintenance Follow up" table (tbljuRImPDUroQ2yd's sibling tbltojdp1l9k4xmSN
-- in base apppQeFQh1Mi6Mv3p).
-- We are replacing the form with a page on the tech mobile site (next to
-- inventory sign-out). Postgres becomes the source of truth for the ticket;
-- the office keeps triaging in Airtable for now, so each row is mirrored
-- there by a single-writer Windmill script (ADR 008 pattern). Full design in
-- ~/.claude/plans/lets-plan-out-a-validated-hennessy.md.
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- 1. maintenance.follow_ups — the ticket. The row itself is the outbox:
--    airtable_record_id IS NULL means "not yet mirrored". status is led by
--    Airtable while the office triages there (the sync script reads it back);
--    when the app becomes the primary UI, status becomes locally owned.
-- 2. Grants + RLS: techs INSERT own rows only; SELECT is org-wide for any
--    logged-in user (cross-tech history on the form, office UI later).
-- 3. Two SECURITY DEFINER RPCs, EXECUTE granted org-wide to authenticated:
--    list_active_maintenance_customers (customer dropdown + mini-card) and
--    list_customer_follow_ups (history counts + modal). DEFINER because
--    techs have no grants on maintenance.tasks and should not get them.
-- 4. AFTER INSERT wake trigger -> pg_net -> Windmill sync script, reusing the
--    shared vault secret 'windmill_token' (same shape as
--    billing.fn_request_pm_refresh_on_invoice_insert). pg_net is at-most-once;
--    a 15-min Windmill heartbeat schedule is the delivery guarantee.
-- 5. Private storage bucket 'follow-ups'; techs upload only into a folder
--    named after their own auth uid. No tech read policy — the sync script
--    reads via service_role signed URLs.

-- 1. Table
CREATE TABLE maintenance.follow_ups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  tech_employee_id   uuid   NOT NULL REFERENCES public.employees(id),
  customer_id        bigint NOT NULL REFERENCES public."Customers"(id),
  issue              text   NOT NULL CHECK (issue IN (
                       'Equipment Issue', 'Green Pool', 'Zero Chlorine',
                       'Chemical Refill', 'Water Chemistry', 'Re-Schedule Clean',
                       'Access / Site Conditions', 'Unserviceable', 'Other')),
  description        text   NOT NULL,
  -- [{"path": "<bucket object path>", "type": "image" | "video"}]
  media              jsonb  NOT NULL DEFAULT '[]'::jsonb,
  equipment_off      boolean,
  status             text   NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- Sync columns: written only by f/maintenance/sync_follow_ups_to_airtable.
  airtable_record_id text,
  airtable_synced_at timestamptz,
  sync_error         text,
  sync_attempts      int    NOT NULL DEFAULT 0
);

CREATE INDEX follow_ups_unsynced ON maintenance.follow_ups (created_at)
  WHERE airtable_record_id IS NULL;
CREATE INDEX follow_ups_by_customer ON maintenance.follow_ups (customer_id);

-- 2. Grants + RLS
GRANT SELECT, INSERT ON maintenance.follow_ups TO authenticated;
GRANT ALL ON maintenance.follow_ups TO service_role;
ALTER TABLE maintenance.follow_ups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tech_insert_own" ON maintenance.follow_ups
  FOR INSERT TO authenticated
  WITH CHECK (
    tech_employee_id IN (SELECT id FROM public.employees WHERE auth_user_id = auth.uid())
  );

-- Org-wide read: follow-ups are internal operational data.
CREATE POLICY "org_select_all" ON maintenance.follow_ups
  FOR SELECT TO authenticated
  USING (true);

-- 3a. Customer dropdown source: one row per customer with an active recurring
--     maintenance task, with primary service address + phone for the mini-card.
CREATE OR REPLACE FUNCTION public.list_active_maintenance_customers()
RETURNS TABLE (
  customer_id   bigint,
  customer_name text,
  address       text,
  phone         text
) LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT ON (c.id)
    c.id,
    c.display_name,
    NULLIF(TRIM(CONCAT_WS(', ', sl.street, sl.city)), ''),
    c.phone
  FROM maintenance.tasks t
  JOIN public."Customers" c ON c.id = t.customer_id
  LEFT JOIN public.service_locations sl
    ON sl.account_id = c.id AND sl.is_active AND sl.duplicate_of_location_id IS NULL
  WHERE t.status = 'active' AND t.category = 'recurring'
  ORDER BY c.id, sl.is_primary DESC NULLS LAST, sl.id
$$;

REVOKE ALL ON FUNCTION public.list_active_maintenance_customers() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_active_maintenance_customers() TO authenticated;

-- 3b. Follow-up history for one customer (feeds the mini-card open/closed
--     counts and the history modal). DEFINER for the employees join.
CREATE OR REPLACE FUNCTION public.list_customer_follow_ups(p_customer_id bigint)
RETURNS TABLE (
  id            uuid,
  created_at    timestamptz,
  issue         text,
  description   text,
  status        text,
  equipment_off boolean,
  tech_name     text
) LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT
    f.id,
    f.created_at,
    f.issue,
    f.description,
    f.status,
    f.equipment_off,
    NULLIF(TRIM(CONCAT_WS(' ', e.first_name, e.last_name)), '')
  FROM maintenance.follow_ups f
  LEFT JOIN public.employees e ON e.id = f.tech_employee_id
  WHERE f.customer_id = p_customer_id
  ORDER BY f.created_at DESC
$$;

REVOKE ALL ON FUNCTION public.list_customer_follow_ups(bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_customer_follow_ups(bigint) TO authenticated;

-- 4. Wake trigger: poke the Airtable sync script on every new ticket.
--    Latency only — the 15-min heartbeat schedule is the delivery guarantee.
CREATE OR REPLACE FUNCTION maintenance.fn_wake_follow_up_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_token       text;
  v_webhook_url constant text :=
    'https://app.windmill.dev/api/w/jps-internal/jobs/run/p/f/maintenance/sync_follow_ups_to_airtable';
BEGIN
  -- Shared DB-webhook token registered 2026-04-14 — one place to rotate.
  SELECT decrypted_secret INTO v_token
    FROM vault.decrypted_secrets
   WHERE name = 'windmill_token'
   LIMIT 1;

  IF v_token IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := v_webhook_url,
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Content-Type',  'application/json'
    ),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
END;
$function$;

CREATE TRIGGER follow_ups_wake_sync
  AFTER INSERT ON maintenance.follow_ups
  FOR EACH ROW
  EXECUTE FUNCTION maintenance.fn_wake_follow_up_sync();

-- 5. Storage: private bucket, techs write only into their own auth-uid folder.
INSERT INTO storage.buckets (id, name, public)
VALUES ('follow-ups', 'follow-ups', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "techs_upload_follow_up_media" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'follow-ups'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'maintenance' AND tablename = 'follow_ups') THEN
    RAISE EXCEPTION 'maintenance.follow_ups was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'list_active_maintenance_customers') THEN
    RAISE EXCEPTION 'list_active_maintenance_customers RPC missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'follow_ups_wake_sync') THEN
    RAISE EXCEPTION 'follow_ups_wake_sync trigger missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'follow-ups') THEN
    RAISE EXCEPTION 'follow-ups storage bucket missing';
  END IF;
END $$;
