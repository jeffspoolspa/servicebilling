-- Sync state machine + webhook ingestion + drift observability.
--
-- Architecture (see CLAUDE.md / Pattern D notes):
--   1. Trust QBO 200 responses for our own writes (cache from response inline)
--   2. Webhooks confirm propagation + catch external changes
--   3. Reconciler diffs cache vs QBO via CDC endpoint as truth backstop
--
-- This migration adds:
--   - sync_state columns on QBO-mirrored tables
--   - webhook_log: every webhook receipt (audit trail + idempotency)
--   - webhook_expectations: track expected vs actual webhook arrivals
--   - drift_log: every reconciler-detected mismatch + resolution
--   - cdc_cursors: per-source change-data-capture watermarks

------------------------------------------------------------------------------
-- 1. sync_state on tables that mirror QBO entities.
------------------------------------------------------------------------------
-- Values:
--   synced               — cache matches QBO (steady state)
--   pending              — write is in flight to QBO (no response yet)
--   awaiting_propagation — got QBO 200, cache updated, waiting on webhook
--   sync_failed          — QBO rejected the write (4xx with explicit error)
--   drift_detected       — reconciler found cache != QBO

ALTER TABLE billing.invoices
  ADD COLUMN IF NOT EXISTS sync_state text NOT NULL DEFAULT 'synced',
  ADD COLUMN IF NOT EXISTS sync_state_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS sync_error text,
  ADD COLUMN IF NOT EXISTS qbo_last_updated_time timestamptz;

ALTER TABLE billing.invoices
  ADD CONSTRAINT invoices_sync_state_check
  CHECK (sync_state IN ('synced', 'pending', 'awaiting_propagation', 'sync_failed', 'drift_detected'));

-- Backfill qbo_last_updated_time from existing raw payloads where possible.
UPDATE billing.invoices
SET qbo_last_updated_time = (raw->'MetaData'->>'LastUpdatedTime')::timestamptz
WHERE qbo_last_updated_time IS NULL
  AND raw->'MetaData'->>'LastUpdatedTime' IS NOT NULL;

-- Partial index for "show me everything that needs attention" queries — stays
-- cheap regardless of overall table growth because synced rows aren't indexed.
CREATE INDEX IF NOT EXISTS idx_invoices_sync_state_problems
  ON billing.invoices (sync_state, sync_state_changed_at)
  WHERE sync_state IN ('pending', 'awaiting_propagation', 'sync_failed', 'drift_detected');

-- Apply same shape to other QBO-mirrored tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'billing' AND table_name = 'customer_payments') THEN
    EXECUTE $sql$
      ALTER TABLE billing.customer_payments
        ADD COLUMN IF NOT EXISTS sync_state text NOT NULL DEFAULT 'synced',
        ADD COLUMN IF NOT EXISTS sync_state_changed_at timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS sync_error text,
        ADD COLUMN IF NOT EXISTS qbo_last_updated_time timestamptz
    $sql$;
    EXECUTE $sql$
      ALTER TABLE billing.customer_payments
        DROP CONSTRAINT IF EXISTS customer_payments_sync_state_check
    $sql$;
    EXECUTE $sql$
      ALTER TABLE billing.customer_payments
        ADD CONSTRAINT customer_payments_sync_state_check
        CHECK (sync_state IN ('synced', 'pending', 'awaiting_propagation', 'sync_failed', 'drift_detected'))
    $sql$;
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_customer_payments_sync_state_problems
        ON billing.customer_payments (sync_state, sync_state_changed_at)
        WHERE sync_state IN ('pending', 'awaiting_propagation', 'sync_failed', 'drift_detected')
    $sql$;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'billing' AND table_name = 'customer_payment_methods') THEN
    EXECUTE $sql$
      ALTER TABLE billing.customer_payment_methods
        ADD COLUMN IF NOT EXISTS sync_state text NOT NULL DEFAULT 'synced',
        ADD COLUMN IF NOT EXISTS sync_state_changed_at timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS sync_error text,
        ADD COLUMN IF NOT EXISTS qbo_last_updated_time timestamptz
    $sql$;
  END IF;
END $$;

------------------------------------------------------------------------------
-- 2. webhook_log: every webhook arrival, persisted forever.
------------------------------------------------------------------------------
-- Used for:
--   - Idempotency (don't re-process a webhook we've already handled)
--   - Audit trail (when did Intuit tell us about this entity?)
--   - Health metrics (how many we got vs expected per hour)

CREATE TABLE IF NOT EXISTS billing.webhook_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,                    -- 'qbo'
  event_type text,                         -- 'invoice.update', 'payment.create', etc
  entity_type text,                        -- 'Invoice', 'Payment', 'Customer'
  entity_id text,
  realm_id text,                           -- QBO company id
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'received', -- received | processing | succeeded | failed
  error_message text,
  retry_count int NOT NULL DEFAULT 0,
  CONSTRAINT webhook_log_status_check
    CHECK (status IN ('received', 'processing', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_log_received_at
  ON billing.webhook_log (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_log_entity
  ON billing.webhook_log (entity_type, entity_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_log_failed
  ON billing.webhook_log (received_at DESC)
  WHERE status = 'failed';

------------------------------------------------------------------------------
-- 3. webhook_expectations: track outbound writes that should produce webhooks.
------------------------------------------------------------------------------
-- When the app POSTs to QBO, we insert a row here. When the matching webhook
-- arrives (matched by entity_id + a recent triggered_at), we mark confirmed.
-- A cron flips overdue pending rows to 'missing' for monitoring.

CREATE TABLE IF NOT EXISTS billing.webhook_expectations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  expected_by timestamptz NOT NULL,       -- triggered_at + grace window (e.g. 5 min)
  webhook_received_at timestamptz,
  source text NOT NULL,                    -- 'self_initiated' | 'reconciler'
  status text NOT NULL DEFAULT 'pending',  -- pending | confirmed | missing
  idempotency_key uuid,                    -- matches the QBO Request-Id we used
  CONSTRAINT webhook_expectations_status_check
    CHECK (status IN ('pending', 'confirmed', 'missing'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_expectations_pending
  ON billing.webhook_expectations (entity_id, expected_by)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_webhook_expectations_missing
  ON billing.webhook_expectations (triggered_at DESC)
  WHERE status = 'missing';

------------------------------------------------------------------------------
-- 4. drift_log: every reconciler-detected mismatch + how we resolved it.
------------------------------------------------------------------------------
-- Three severity tiers:
--   soft     — cache stale relative to QBO; auto-heal silently (logged for trend)
--   hard     — webhook missed AND value disagrees; auto-heal but flag in UI
--   critical — cache appears NEWER than QBO (our write didn't land), or large
--              drift volumes; requires human investigation

CREATE TABLE IF NOT EXISTS billing.drift_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at timestamptz NOT NULL DEFAULT now(),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  kind text NOT NULL,        -- 'cache_stale' | 'cache_ahead' | 'webhook_missing' | 'value_mismatch'
  severity text NOT NULL,    -- 'soft' | 'hard' | 'critical'
  cache_state jsonb,         -- snapshot of cache at detection time
  qbo_state jsonb,           -- snapshot of QBO at detection time
  resolution text,           -- 'auto_healed' | 'flagged_for_review' | 'blocked' | 'manually_resolved'
  resolution_at timestamptz,
  resolved_by text,
  CONSTRAINT drift_log_severity_check
    CHECK (severity IN ('soft', 'hard', 'critical'))
);

CREATE INDEX IF NOT EXISTS idx_drift_log_detected_at
  ON billing.drift_log (detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_drift_log_unresolved
  ON billing.drift_log (entity_type, entity_id, detected_at DESC)
  WHERE resolution IS NULL OR resolution = 'flagged_for_review';

------------------------------------------------------------------------------
-- 5. cdc_cursors: per-source watermarks for the change-data-capture reconciler.
------------------------------------------------------------------------------
-- The reconciler stores its position so each run only fetches QBO entities
-- changed since the last run. This is what makes reconciliation O(deltas)
-- instead of O(table_size).

CREATE TABLE IF NOT EXISTS billing.cdc_cursors (
  source text PRIMARY KEY,
  cursor_timestamp timestamptz NOT NULL,
  last_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_status text NOT NULL DEFAULT 'pending',
  entities_processed int DEFAULT 0,
  drift_detected_count int DEFAULT 0,
  notes text
);

-- Initialize the QBO cursor at "1 hour ago" so the first reconciler run only
-- scans recent changes (not the entire history). Adjust if you want a deeper
-- initial sweep.
INSERT INTO billing.cdc_cursors (source, cursor_timestamp)
VALUES ('qbo', now() - interval '1 hour')
ON CONFLICT (source) DO NOTHING;

------------------------------------------------------------------------------
-- 6. Helper view for the global "issues needing attention" badge.
------------------------------------------------------------------------------
-- Counts every record across QBO-mirrored tables that's not in the synced state,
-- plus pending webhook expectations that have gone past their window.

CREATE OR REPLACE VIEW billing.v_sync_issues_summary AS
SELECT
  (SELECT count(*) FROM billing.invoices
   WHERE sync_state IN ('sync_failed', 'drift_detected')) AS invoice_problems,
  (SELECT count(*) FROM billing.invoices
   WHERE sync_state IN ('pending', 'awaiting_propagation')
     AND sync_state_changed_at < now() - interval '2 minutes') AS invoice_stuck_pending,
  (SELECT count(*) FROM billing.webhook_expectations
   WHERE status = 'missing'
     AND triggered_at > now() - interval '24 hours') AS missing_webhooks_24h,
  (SELECT count(*) FROM billing.drift_log
   WHERE resolution IS NULL OR resolution = 'flagged_for_review') AS unresolved_drift;

-- Mirror as a public view so anon clients can read it (no PII, just counts).
CREATE OR REPLACE VIEW public.v_sync_issues_summary AS
SELECT * FROM billing.v_sync_issues_summary;

GRANT SELECT ON public.v_sync_issues_summary TO anon, authenticated;

------------------------------------------------------------------------------
-- 7. Realtime publication: include the new tables so the UI can subscribe.
------------------------------------------------------------------------------
-- billing.invoices is presumably already in the publication (used by the
-- pre-process activity toast). Add the new ones so the sync issues badge
-- updates live without polling.

DO $$
BEGIN
  -- Add tables to supabase_realtime publication if not already members.
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'billing'
      AND tablename = 'webhook_expectations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE billing.webhook_expectations;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'billing'
      AND tablename = 'drift_log'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE billing.drift_log;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not modify supabase_realtime publication: %', SQLERRM;
END $$;

COMMENT ON TABLE billing.webhook_log IS
  'Audit trail of every QBO webhook arrival. Used for idempotency, debugging, and health metrics.';
COMMENT ON TABLE billing.webhook_expectations IS
  'Tracks outbound writes that should produce QBO webhooks. Used to detect missing webhooks and trigger investigation.';
COMMENT ON TABLE billing.drift_log IS
  'Every cache-vs-QBO mismatch detected by the CDC reconciler. Soft drift auto-heals; hard/critical surfaces in UI.';
COMMENT ON TABLE billing.cdc_cursors IS
  'Per-source watermarks for incremental reconciliation. Only fetches changes since the last cursor.';
