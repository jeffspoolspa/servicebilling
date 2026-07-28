-- Consolidate the follow-up Airtable sync into a single once-daily job.
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- After the 4,936-row historical backfill (20260714154719) we no longer want
-- an event-driven, 15-minute sync. Per Carter, during the migration window a
-- single daily reconcile is enough: push new app rows to Airtable, ingest any
-- Airtable rows that came in from other sources (e.g. the old form), and
-- refresh open tickets' status + next-steps. The wake-on-insert trigger also
-- flooded the queue with ~5k jobs during the bulk import, so it's removed for
-- good. When our UI becomes the triage surface, the ingest + refresh legs are
-- switched off and only the DB remains authoritative (see the `source` column).
--
-- ─────────────────────────────────────────────────────────────────
-- DESIGN
-- ─────────────────────────────────────────────────────────────────
-- 1. next_steps: pulled from the Airtable "Next Steps" field for open tickets.
-- 2. Drop the wake-on-insert trigger + function (no more event-driven push /
--    no flood vector).
-- 3. Retire the 15-min heartbeat; schedule one daily reconcile that runs
--    f/maintenance/backfill_follow_ups_from_airtable in mode='daily_sync'
--    (push pending + ingest new + refresh open; close on Done OR Scheduled).

-- 1.
ALTER TABLE maintenance.follow_ups ADD COLUMN IF NOT EXISTS next_steps text;

-- 2.
DROP TRIGGER IF EXISTS follow_ups_wake_sync ON maintenance.follow_ups;
DROP FUNCTION IF EXISTS maintenance.fn_wake_follow_up_sync();

-- 3. Reschedule (applied operationally via SQL; recorded here for parity).
SELECT cron.unschedule('follow-ups-airtable-heartbeat')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'follow-ups-airtable-heartbeat');

SELECT cron.schedule('follow-ups-airtable-daily-sync', '0 13 * * *', $cmd$
  SELECT net.http_post(
    url := 'https://app.windmill.dev/api/w/jps-internal/jobs/run/p/f/maintenance/backfill_follow_ups_from_airtable',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'windmill_token' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{"mode":"daily_sync","apply":true}'::jsonb,
    timeout_milliseconds := 5000
  );
$cmd$)
WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'follow-ups-airtable-daily-sync');

-- ─────────────────────────────────────────────────────────────────
-- SANITY CHECK
-- ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='maintenance' AND table_name='follow_ups' AND column_name='next_steps') THEN
    RAISE EXCEPTION 'next_steps missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='follow_ups_wake_sync') THEN
    RAISE EXCEPTION 'wake trigger still present';
  END IF;
END $$;
