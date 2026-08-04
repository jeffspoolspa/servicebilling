-- Nightly accrual cadence, phase 1 (docs/flows/nightly-accrual-cadence).
-- The tick is a SQL producer: enqueue every ACTIVE month, wake the worker.
-- Selection is a Specification with one named home (v_active_months);
-- everything the drainer then does goes through the domain.

-- Months leave the active set by their own state change (invoiced) or by an
-- explicit PARK — "stop considering this month" (not a hold; holds stay active).
ALTER TABLE billing.billing_months
  ADD COLUMN IF NOT EXISTS parked_at timestamptz,
  ADD COLUMN IF NOT EXISTS parked_by text;

-- The active predicate reads a partial index that only ever contains live
-- rows, so the tick stays O(active) as closed history accumulates.
CREATE INDEX IF NOT EXISTS idx_billing_months_active
  ON billing.billing_months (month)
  WHERE invoiced_at IS NULL AND parked_at IS NULL;

CREATE OR REPLACE VIEW billing.v_active_months AS
  SELECT id, customer_id, month
  FROM billing.billing_months
  WHERE invoiced_at IS NULL AND parked_at IS NULL;

-- Findings get their true SUBJECT: source_key = task_id:service_date (the
-- visit grain the audit already observes). Identity = (rule, source_key);
-- the observation (cents) decides supersede — see recordFindings.
ALTER TABLE billing.findings ADD COLUMN IF NOT EXISTS source_key text;

-- Runtime switches a person flips; the charge stage checks auto_charge, so a
-- supervised issue-day can create invoices while parking the money step.
CREATE TABLE IF NOT EXISTS billing.policy_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing.policy_flags (key, enabled, note)
VALUES ('auto_charge', true, 'invoice machine may charge cards; set false for a supervised issue-day')
ON CONFLICT (key) DO NOTHING;

-- THE TICK. Enqueue is the correctness half (the queue holds the work even if
-- every wake fails); the wake is latency only. Runs nightly via pg_cron —
-- deliberately NOT scheduled here; arming is an explicit human act:
--   SELECT cron.schedule('billing-nightly-tick', '30 7 * * *', $c$SELECT billing.tick_nightly()$c$);
CREATE OR REPLACE FUNCTION billing.tick_nightly()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'billing', 'public'
AS $$
BEGIN
  PERFORM billing.enqueue_billing_months(
    ARRAY(SELECT id FROM billing.v_active_months), 3);
  -- One relay wakes the whole nightly orchestration (the tick route drains
  -- months, issues closed clean ones, and drains the invoice machine).
  PERFORM billing.wake_queue_worker('f/billing/wake_invoice_drainer',
                                    jsonb_build_object('tick', true));
END;
$$;
