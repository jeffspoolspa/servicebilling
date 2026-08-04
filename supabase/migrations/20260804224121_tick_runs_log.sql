-- The nightly tick's run log: one row per tick-route invocation with the
-- summary that otherwise evaporates when pg_net fires the wake (nobody
-- reads the HTTP response). The domain trail stays in events/history;
-- this is the run-level "what happened last night" a person checks.
CREATE TABLE IF NOT EXISTS billing.tick_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  trigger text NOT NULL,               -- 'machine' (pg_cron wake) | 'person'
  summary jsonb NOT NULL
);
GRANT SELECT ON billing.tick_runs TO authenticated;
