-- The two ION clocks, moved into pg_cron alongside every other JPS schedule.
--
-- WHY THIS EXISTS
--   The Windmill schedule for f/ION/recurring_tasks stopped firing on
--   2026-07-24 08:00 UTC and nothing noticed: every task created afterwards
--   reached maintenance.tasks only via the visit ingester's orphan-recovery
--   fallback, i.e. never before a customer's first service. Worse, the ION
--   link sweep (LinkIonService.linkDue) had no caller at all, so
--   Customers.ion_cust_id was only ever written as a side effect of that same
--   ingester -- and upsert_tasks drops any ION task whose ionCustId does not
--   resolve to a Customer. HELTON, KATHY (ION 2583735, task 6061323) is the
--   worked example: onboarded 2026-08-19, serviced 2026-08-25, invisible in
--   maintenance.tasks the whole time.
--
--   The Windmill schedule cannot be read or repaired from here -- the API token
--   in the vault is jobs:run-scoped and 403s on schedules:read -- so the clock
--   moves to pg_cron, which is where billing.tick_nightly and the Airtable
--   follow-up sync already live and which is queryable from SQL.
--
-- ORDER MATTERS: link first, sync second. A task whose customer is still
-- unlinked is skipped by upsert_tasks as unresolved_new, so the sweep has to
-- have run before the task sync asks the question.

-- 03:40 ET -- resolve ION ids for everyone still awaiting (ADR 006, fuzzy-match-once).
-- Authenticated with the vault's `windmill_token`, which is byte-identical to the
-- app's WINDMILL_TOKEN env var and is what /api/billing/tick already accepts. Using
-- a secret BOTH sides already hold is the whole point: OPERATOR_TOKEN was set on
-- only one side and had silently drifted out of sync by the time anything used it.
select cron.unschedule('ion-link-sweep-daily')
where exists (select 1 from cron.job where jobname = 'ion-link-sweep-daily');

select cron.schedule('ion-link-sweep-daily', '40 7 * * *', $job$
  select net.http_post(
    url     := 'https://internal.jeffspoolspa.com/api/customers/link-ion/sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'windmill_token' limit 1)
    ),
    body    := '{"dryRun": false}'::jsonb,
    timeout_milliseconds := 300000
  );
$job$);

-- 04:00 ET -- the slot the Windmill schedule held until 2026-07-24. Two things
-- the URL and body have to get right, both of which fail silently otherwise:
--   * recurring_tasks is a FLOW, so the endpoint is jobs/run/f/<path>, not
--     jobs/run/p/<path> (that is the script endpoint -- see lib/windmill.ts);
--   * dry_run must be passed explicitly, because the flow's schema defaults it
--     to true and a dry run rolls its whole transaction back.
select cron.unschedule('ion-recurring-tasks-daily')
where exists (select 1 from cron.job where jobname = 'ion-recurring-tasks-daily');

select cron.schedule('ion-recurring-tasks-daily', '0 8 * * *', $job$
  select net.http_post(
    url     := 'https://app.windmill.dev/api/w/jps-internal/jobs/run/f/f/ION/recurring_tasks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'windmill_token' limit 1)
    ),
    body    := '{"dry_run": false}'::jsonb,
    timeout_milliseconds := 10000
  );
$job$);
