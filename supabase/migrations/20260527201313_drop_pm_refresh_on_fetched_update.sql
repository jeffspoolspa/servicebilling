-- Revert v2 of the payment-method freshness gate, and fix the AFTER INSERT
-- pg_net trigger so its dedup actually works against bulk inserts.
--
-- ─────────────────────────────────────────────────────────────────
-- BACKGROUND
-- ─────────────────────────────────────────────────────────────────
-- The freshness gate was implemented twice:
--   v1 (20260521000004): coupled payment_method_ok to a freshness check on
--      pm_last_checked_at vs invoices.fetched_at. Reverted same day in
--      20260521000005 because it false-flagged 24 valid invoices.
--   v2 (20260521165405): re-introduced the freshness gate with a "self-healing
--      loop" — stale invoice → AFTER UPDATE OF fetched_at trigger → pg_net
--      webhook → script bumps pm_last_checked_at → cascade flips invoice
--      back to OK.
--
-- The v2 self-healing-loop assumption broke at scale. The root design flaw:
-- the trigger fires on `fetched_at` updates, but `fetched_at` is bumped EVERY
-- TIME any QBO sync touches the row — not only when something meaningful
-- changes. Two scheduled scripts hit this every 4 hours:
--   - pull_qbo_invoices touches every billable WO's invoice
--   - refresh_open_invoices touches every open invoice row
-- Each fires the trigger per-row. The 60s dedup based on pm_last_checked_at
-- couldn't help because pm_last_checked_at is updated by the async script
-- AFTER all the in-statement triggers have already fired.
--
-- Result: 2026-05-23 → 2026-05-25 weekend, ~100 webhook calls per scheduled
-- run × ~12 runs/day × 3 days ≈ ~3,600 full-table PM sweeps. $2,500 compute.
--
-- ─────────────────────────────────────────────────────────────────
-- THE FIX (this migration)
-- ─────────────────────────────────────────────────────────────────
-- 1. Drop the AFTER UPDATE OF fetched_at trigger — wrong signal entirely.
--    We only want a refresh when a genuinely NEW invoice arrives in cache.
-- 2. Drop the Customer-side recompute trigger and its function — without the
--    freshness gate they no longer have a job.
-- 3. Revert trg_set_payment_method_ok_from_invoice back to its pre-v2 form
--    (no `fetched_at` in the trigger columns).
-- 4. Revert compute_payment_method_ok to the pre-freshness logic: a pure
--    resolution check (does a billable PM exist).
-- 5. KEEP trg_request_pm_refresh_on_invoice_insert (AFTER INSERT). That's
--    the correct signal — fire once when a new invoice lands in cache.
-- 6. REPLACE the trigger function's dedup logic with an ATOMIC CLAIM so a
--    bulk insert of N invoices for the same customer only fires the webhook
--    once. The old SELECT-then-fire pattern couldn't dedup within a single
--    transaction; the new UPDATE-WHERE-FOUND pattern serializes on the row
--    lock and skips on the second hit.
--
-- ─────────────────────────────────────────────────────────────────
-- WHAT WE LOSE
-- ─────────────────────────────────────────────────────────────────
-- The auto-detection of "this customer added a card in QBO between our
-- pulls." That feature wasn't actually working — the script was running in
-- full-table mode every call (args=null in 100% of jobs from the runaway
-- forensic data) because the only_customer_id arg was never consumed by
-- the script. So we're not losing functionality, we're stopping a cost
-- sink that was failing silently.
--
-- The need for that PM-freshness check still exists. It's just better
-- handled in one of these ways (out of scope for this migration):
--   * On-demand right before charging: the helper function
--     billing.invoice_pm_freshness_status(qbo_invoice_id) is already in
--     place (added in 20260521000005). Processing scripts call it and
--     trigger a single-customer refresh inline if not 'fresh'.
--   * Off the CDC reconciler: when the CDC sweep detects a Customer
--     entity change in QBO, fan out a per-customer PM refresh. That's
--     deterministic ("only when QBO actually changed"), per-customer
--     (no fanout), and runs at the existing 15-min reconciler cadence.

-- ─────────────────────────────────────────────────────────────────
-- 1. Drop the broken triggers
-- ─────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_request_pm_refresh_on_invoice_fetched_update
  ON billing.invoices;

DROP TRIGGER IF EXISTS trg_recompute_pm_ok_on_customer_pm_check
  ON public."Customers";

DROP FUNCTION IF EXISTS billing.fn_recompute_pm_ok_on_customer_pm_check();

-- ─────────────────────────────────────────────────────────────────
-- 2. Revert trg_set_payment_method_ok_from_invoice (no more fetched_at)
-- ─────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_set_payment_method_ok_from_invoice ON billing.invoices;
CREATE TRIGGER trg_set_payment_method_ok_from_invoice
AFTER UPDATE OF payment_method, target_payment_method_id, preferred_payment_type
ON billing.invoices
FOR EACH ROW
WHEN (
  OLD.payment_method            IS DISTINCT FROM NEW.payment_method
  OR OLD.target_payment_method_id IS DISTINCT FROM NEW.target_payment_method_id
  OR OLD.preferred_payment_type   IS DISTINCT FROM NEW.preferred_payment_type
)
EXECUTE FUNCTION billing.fn_set_payment_method_ok_from_invoice();

-- ─────────────────────────────────────────────────────────────────
-- 3. Revert compute_payment_method_ok to pure resolution check
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION billing.compute_payment_method_ok(p_qbo_invoice_id text)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $function$
DECLARE
  v_pm                text;
  v_target_id         uuid;
  v_preferred_type    text;
  v_customer_id       text;
BEGIN
  SELECT payment_method, target_payment_method_id, preferred_payment_type, qbo_customer_id
    INTO v_pm, v_target_id, v_preferred_type, v_customer_id
    FROM billing.invoices WHERE qbo_invoice_id = p_qbo_invoice_id;

  IF v_customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN v_pm = 'invoice'
      OR v_target_id IS NOT NULL
      OR v_preferred_type IS NOT NULL;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────
-- 4. Replace the AFTER INSERT trigger function's dedup with atomic claim
-- ─────────────────────────────────────────────────────────────────
-- Why atomic claim:
--   The previous logic was "SELECT pm_last_checked_at; if stale, fire pg_net".
--   That can't dedup within a single transaction because all in-statement
--   triggers read pm_last_checked_at before any of them updates it — so 30
--   row triggers in one INSERT all see the same stale value and all fire.
--
--   The new logic UPDATEs pm_last_checked_at to now() if and only if it's
--   stale, then checks FOUND. Postgres serializes UPDATEs on the same row
--   via row locks, so if the second trigger for the same customer arrives,
--   its UPDATE matches zero rows (pm_last_checked_at is no longer stale)
--   and we skip the pg_net call.
--
-- Semantic note: pm_last_checked_at now means "PM refresh requested" rather
-- than "PM refresh completed." Acceptable because nothing depends on it
-- being authoritative anymore (the freshness gate is gone). If we ever
-- reintroduce a freshness check, it should read from a separate column
-- (e.g. pm_last_verified_at) updated by the script when it actually
-- finishes.

CREATE OR REPLACE FUNCTION billing.fn_request_pm_refresh_on_invoice_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_token        text;
  v_webhook_url  constant text :=
    'https://app.windmill.dev/api/w/jps-internal/jobs/run/p/f/service_billing/pull_customer_payment_methods';
BEGIN
  IF NEW.qbo_customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Atomic dedup claim: only proceed if we successfully updated the
  -- customer row (i.e. pm_last_checked_at was NULL or older than 60s).
  -- Postgres row lock serializes concurrent triggers for the same customer
  -- so a burst of inserts in one transaction only fires the webhook once.
  UPDATE public."Customers"
     SET pm_last_checked_at = now()
   WHERE qbo_customer_id = NEW.qbo_customer_id
     AND (pm_last_checked_at IS NULL
          OR pm_last_checked_at < now() - interval '60 seconds');

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Shared windmill_token from Vault (registered 2026-04-14). One place
  -- to rotate; reused by any DB trigger that fans out to Windmill scripts.
  SELECT decrypted_secret INTO v_token
    FROM vault.decrypted_secrets
   WHERE name = 'windmill_token'
   LIMIT 1;

  -- No token configured → silent no-op rather than blocking the insert.
  IF v_token IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := v_webhook_url,
    body    := jsonb_build_object('only_customer_id', NEW.qbo_customer_id),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Content-Type',  'application/json'
    ),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────
-- 5. Recompute payment_method_ok over open invoices
-- ─────────────────────────────────────────────────────────────────
-- The 2 invoices v2 had flagged as freshness-stale will move back to
-- ready_to_process under the simpler resolution-only rule. Downstream
-- trg_project_billing_status_on_indicator_change handles the
-- billing_status transition automatically.

UPDATE billing.invoices
   SET payment_method_ok = billing.compute_payment_method_ok(qbo_invoice_id)
 WHERE billing_status != 'processed'
   AND qbo_customer_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- 6. Sanity check: the AFTER INSERT trigger must still exist
-- ─────────────────────────────────────────────────────────────────
-- If something dropped this trigger between v2 and now, the cleanup would
-- silently leave no PM-refresh path at all. Fail loudly so we notice.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'trg_request_pm_refresh_on_invoice_insert'
       AND tgrelid = 'billing.invoices'::regclass
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_request_pm_refresh_on_invoice_insert is missing; '
                    'the AFTER INSERT PM-refresh path is broken. '
                    'Re-apply 20260521155727 to restore it.';
  END IF;
END $$;
