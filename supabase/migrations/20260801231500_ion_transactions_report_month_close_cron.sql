-- Automate the ION "All Transactions" report pull for month-close so the
-- Reconciler can run on its own: pg_cron -> Windmill (the app token lacks
-- schedules:write; same pattern as follow-ups-airtable-heartbeat). Runs daily
-- at 07:10 UTC (~3:10am ET) on days 1-5 of each month, pulling the JUST-ENDED
-- month with load=true (replaces that month in billing_audit.ion_task_
-- transactions — the script's own idempotent semantics). Manual mid-month
-- pulls stay exactly as they are.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ion-transactions-month-close') THEN
    PERFORM cron.unschedule('ion-transactions-month-close');
  END IF;
END $$;

SELECT cron.schedule(
  'ion-transactions-month-close',
  '10 7 1-5 * *',
  $job$
  SELECT net.http_post(
    url := 'https://app.windmill.dev/api/w/jps-internal/jobs/run/p/f/ION/transactions_report',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'windmill_token' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'month', to_char((date_trunc('month', now() AT TIME ZONE 'America/New_York') - interval '1 month')::date, 'YYYY-MM'),
      'dry_run', false,
      'load', true
    ),
    timeout_milliseconds := 10000
  );
  $job$
);
