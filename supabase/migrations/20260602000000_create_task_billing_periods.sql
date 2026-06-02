-- billing_audit.task_billing_periods — the write-ahead "invoice promise".
--
-- One row per (task, billing_month): the middleman between ION (visits trickle in
-- over the month) and QBO (the task's invoice lands later). Created from the task,
-- it accrues the month's billable visits (labor) + consumable usage (quantity),
-- then links 1:1 to the QBO invoice and reconciles. See
-- docs/entities/task-billing-period.md + docs/flows/monthly-maintenance-billing.md.
--
-- Grain UNIQUE (task_id, billing_month). billing_month is the first of the month.
-- expected_labor_cents: per_visit -> SUM(visit price) ; flat_rate_monthly -> the
-- task's monthly flat. consumables: {item_name: total_quantity} for the month.
-- Reconciliation (later) sets labor_ok (amount) + consumables_ok (per-item qty).

CREATE TABLE IF NOT EXISTS billing_audit.task_billing_periods (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id                uuid NOT NULL REFERENCES maintenance.tasks(id) ON DELETE CASCADE,
  billing_month          date NOT NULL,              -- first day of the month
  qbo_customer_id        text,                        -- for the customer-month rollup
  service_location_id    bigint,
  billing_method         text,                        -- per_visit | flat_rate_monthly | ...
  per_visit_rate_cents   integer,
  flat_rate_monthly_cents integer,
  visit_count            integer NOT NULL DEFAULT 0,  -- all visits in the month
  billable_visit_count   integer NOT NULL DEFAULT 0,  -- visits with price > 0
  expected_labor_cents   integer NOT NULL DEFAULT 0,
  consumables            jsonb,                        -- {item_name: total_qty}
  qbo_invoice_id         text,                         -- matched invoice (1:1, nullable)
  invoice_labor_cents    integer,                      -- set at reconcile
  status                 text NOT NULL DEFAULT 'visits_accruing'
                           CHECK (status IN ('promised','visits_accruing','invoiced','reconciled','mismatch','missed')),
  labor_ok               boolean,
  consumables_ok         boolean,
  opened_at              timestamptz NOT NULL DEFAULT now(),
  reconciled_at          timestamptz,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, billing_month)
);

CREATE INDEX IF NOT EXISTS tbp_customer_month ON billing_audit.task_billing_periods (qbo_customer_id, billing_month);
CREATE INDEX IF NOT EXISTS tbp_month_status   ON billing_audit.task_billing_periods (billing_month, status);
CREATE INDEX IF NOT EXISTS tbp_qbo_invoice    ON billing_audit.task_billing_periods (qbo_invoice_id) WHERE qbo_invoice_id IS NOT NULL;

COMMENT ON TABLE billing_audit.task_billing_periods IS
  'Write-ahead invoice promise: one row per (task, billing_month). Accrues the '
  'month''s billable maintenance.visits (labor) + consumables_usage (per-item qty), '
  'links 1:1 to the task''s QBO invoice, reconciles labor (amount) + consumables '
  '(quantity). Populated by f/billing_audit/build_task_billing_periods. '
  'See docs/entities/task-billing-period.md.';
