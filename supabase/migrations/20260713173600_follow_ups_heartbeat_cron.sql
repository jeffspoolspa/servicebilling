-- 15-minute heartbeat for the follow-ups Airtable sync (pg_cron -> Windmill).
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- The follow_ups_wake_sync trigger (migration 20260713173327) pokes
-- f/maintenance/sync_follow_ups_to_airtable on INSERT, but pg_net is
-- at-most-once and has dropped requests before (documented in
-- docs/conventions/SCRIPT_HEADER.md). The plan called for a Windmill
-- schedule, but the app API token lacks schedules:write, so the heartbeat
-- lives in pg_cron instead — the same pattern as the existing
-- voicemail-to-airtable job. The heartbeat also drives the Airtable Status
-- read-back (Done -> closed).
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- One cron.schedule job every 15 minutes POSTing the Windmill run endpoint
-- with the shared vault 'windmill_token'. Idempotent via unschedule-if-exists.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'follow-ups-airtable-heartbeat') THEN
    PERFORM cron.unschedule('follow-ups-airtable-heartbeat');
  END IF;
END $$;

SELECT cron.schedule(
  'follow-ups-airtable-heartbeat',
  '*/15 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://app.windmill.dev/api/w/jps-internal/jobs/run/p/f/maintenance/sync_follow_ups_to_airtable',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'windmill_token' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $job$
);

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'follow-ups-airtable-heartbeat') THEN
    RAISE EXCEPTION 'follow-ups-airtable-heartbeat cron job missing';
  END IF;
END $$;
