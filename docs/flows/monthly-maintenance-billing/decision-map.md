# Monthly Maintenance Billing — Decision Map (Layer 2)

> Status: [active]
> Flow: [index](index.md)

## Ingestion (per day, `ingest_day_logs`)

1. **Enumerate** the day's logs (`list_day_logs`).
2. **Detail** each via `get_log_detail` (addLog).
3. **Keep** a log iff it has a `time_in` AND resolves to an `EventID` (a task). No time-in = not performed → skip. No EventID → skip (report as unresolved).
4. **Serviceable** = has time-in AND NOT (time-out present AND time-out == time-in). So missing time-out and reversed times are still serviceable/billable; only an explicit zero-duration is a skip.
5. **Price** = `task_price_cents` (override) → else service-type default (`[design]`) → else number parsed from the service name.
6. **Customer** flows through the task: `EventID` → `task_schedules` → `recurring_tasks.qbo_customer_id` (and `TaskInvoiceID` on the log corroborates it).
7. **Upsert** keyed by `LogID`; `ON CONFLICT (sl, date, service_type, pool_id, started_at) DO NOTHING` — multi-pool same-time logs collapse (billing collapses by (task, day) anyway).
8. Any `EventID` not in the census → pull the customer's tasks and add it (so every visit resolves to a task).

## Promise build (`build_task_billing_periods`, per (task, month))

- `billable_visit_count` = distinct **serviceable, non-QC** service-days (multiple logs/pools on a day collapse to one day).
- `expected_labor_cents` = flat task → the flat monthly amount; per_visit task → SUM over distinct days of that day's price.
- One promise per active task-month even with zero visits (a flat task still bills).

## Reconcile (`reconcile_billing_periods`, per task, against the QBO invoice)

- **Labor (amount):** our `expected_labor` vs the invoice's maintenance-SKU line amounts (POOL MAINTENANCE / FLAT RATE / CHEMICAL TESTING / SPA CLEAN / FOUNTAIN CLEAN / GREEN POOL / ONE TIME CLEAN), **excluding** SALT CELL CLEAN / HALF HOUR / QUALITY CONTROL. Aggregate invoices per task first. $1 tolerance.
- **Consumables (quantity)** (`[design]`): our `consumables_usage` per-item quantity vs the invoice's chemical-line `qty`. **Price not compared** (ION sets it at sync). Higher priority than labor. Needs the ion↔qbo item crosswalk (`maintenance.consumable_items`).
- **Billed visit count check:** the invoice's primary-SKU line `qty` = ION's billed visits; compare to our serviceable days to catch genuine ION↔QBO discrepancies (e.g. a missing log).

## Categories that are NOT a labor mismatch

- **One-time jobs** (GREEN POOL / ONE TIME CLEAN / FOUNTAIN CLEAN / SPA CLEAN): job-priced, separate invoices — don't expect visits×rate.
- **On-hold** invoices: not synced to QBO yet → genuinely absent, skip until synced.
- **QC**: non-billable labor; its consumables still bill.

## Failure handling

- Unresolved log (no EventID) / missing task → report; pull the task; never silently drop.
- Reconcile `mismatch` → hold the invoice + surface for review (do not charge).
- Ingest conflict on the natural key → dedupe (DO NOTHING), don't error.

## Post-conditions

- Every completed, performed log → exactly one visit linked to a task.
- Every active task-month → one promise; reconciled `labor_ok` (+ `consumables_ok` when the quantity check lands) before Phase B charges it.

## Phase B — processing (unchanged; mirrors per-WO [work-order-to-payment](../work-order-to-payment/index.md))

Per reconciled invoice: apply credits → autopay decision → charge (card/ACH) or invoice-only → send →
reflect balance. Engine: [monthly-autopay](../monthly-autopay.md). Autopay roster is per-customer;
processing is per-invoice (per task).

**HIGH-flag hold (hard rule):** a customer-month with an unreviewed HIGH flag in
`billing_audit.customer_month_audit` (`flag_level='HIGH'`, `audit_status='flagged'`) is excluded
from the autopay charge list AND from `send_monthly_invoices` until someone marks it reviewed
(via `/maintenance/billing/review`). The hold is per invoice-month: the flagged month is held,
the customer's other unpaid months still process. Held invoices stay `pending` and are picked
up by the next run after review — no state to reset. The `/api/maintenance-billing/process`
route ALSO re-checks holds server-side before triggering the engine (defense in depth).

**Processing status (STORED, 2026-07-02):** `task_billing_periods.processing_status` is the
per-period state machine, mirroring the work-order pipeline:

```
pending -> ion_matched -> [QBO link -> serial preprocess queue] -> needs_review | ready_to_process -> processed
```

1. **ION match (stage 1):** `billing_audit.match_promises_to_ion(month)` stamps each promise
   with its ION invoice number + amount from `ion_task_transactions` (SUM over split re-bills;
   the max-amount txn is the representative number). STAMP ONLY — no gating: nothing holds a
   period before preprocessing (ION-side misbillings are assumed fixed by billing time; the
   pre-billing CPV audit workflow catches them earlier). Runs after the UI's Refresh-bills
   report pull and on the hourly reconcile.
2. **QBO link (stage 2):** `trg_link_invoice_to_maint_period` on `billing.invoices` — a new
   cached invoice (webhook/CDC) whose `doc_number` = a promise's `ion_invoice_number` AND
   whose customer matches (WO and task invoices share ION's number space — the customer guard
   prevents mislinks) gets `qbo_invoice_id` set and the customer-month enqueued in
   `maint_preprocess_queue`. The link is the pipeline trigger; the trigger is the ONLY
   `qbo_invoice_id` writer (reconcile no longer links).
3. **Preprocess (stage 3, queued serially):** `drain_maint_preprocess_queue` (2-min schedule,
   one at a time — month-end is a ~520-invoice burst, no fan-out) runs
   `preprocess_maint_customer_month`: customer-scoped credit apply (NO invoice email — sending
   would mark EmailSent and let auto-promote skip a hold), stamps `pre_processed_at` +
   `credits_applied`, then projects.
4. **Projection owns every transition — and every review gate evaluates AT PREPROCESS
   (`pre_processed_at` set), never earlier:** `billing_audit.project_maint_processing_status`
   checks — `chem_flag` (the simple rule: month's net consumable bill > 2x the peer group's
   PLAIN median AND >= $150, unreviewed; provides-chems customers INCLUDED. LIVE, no refresh
   step (Carter 2026-07-03): a trigger on `consumables_usage` maintains
   `billing_audit.customer_month_chem_live` (qty x catalog price deltas, ~500 rows/month);
   `v_chem_flag_medians` (one row per month+peer_group — THE median query) and
   `v_chem_flags` are plain views over it, current with every ingested visit. Peer group
   derives live from task tags (`tasks.frequency`/`days_per_week`) + `Customers.company`
   via `v_customer_peer_group`. Drift backstop: `rebuild_customer_month_chem` trues up
   from `v_customer_month_cpv` on the hourly reconcile. App surface:
   `maint_billing_chem_medians` / `maint_billing_chem_flags`; the Needs Review card shows
   "chems $X vs $Y median (Zx)". Remediation = apply a DISCOUNT on the QBO invoice,
   leaving ION's record of what was sold intact),
   ion amount vs expected, subtotal (per-row: ION amount vs the linked invoice's
   QBO SUBTOTAL — pre-tax, pre-discount, so tax and QBO-side discounts never trip it;
   catches line items lost in the ION→QBO sync), reconcile verdict, sticky
   `credit_error` — and writes needs_review/ready_to_process. Never demotes `processed`;
   skips locked months. `reviewed_at` (manual mark-ready) passes the data-mismatch gates;
   `chem_flag` releases only via flag review (`customer_month_audit` reviewed/resolved).
   The CPV z-score audit (`customer_month_audit` HIGH) is NO LONGER a pipeline gate — it
   stays the pre-billing analysis tool (its autopay-builder NOT EXISTS remains as the
   enforced charge gate until the strict status gate is switched on).
5. **Auto-promote (stage 4):** linked invoice at `balance <= 0` AND `EmailSent` (or a
   confirmed autopay charge) → `processed` — via `trg_promote_maint_period_on_invoice_paid`
   (DISTINCT-guarded; CDC rewrites rows every 15-min tick) and inside every projection call,
   which also catches invoices already paid+sent BEFORE linking. Covers invoices manually
   processed outside the app: the cache self-updates, so nothing double-processes.
   `paid` is a derived UI overlay (balance <= 0), not a stored state.

**Review queues (two, different purposes):** the primary manual-review queue AND the
pipeline's HOLD source (2026-07-02) is `billing_audit.v_billing_review_flags` (Carter's
rule: month's net consumable bill > 2x the peer group's CLEAN median AND >= $150;
residential medians exclude provides-chems pools; intentionally wide — pool volume is a
known missing normalizer). The projection evaluates it at preprocess time as `chem_flag`.
The CPV z-score audit (`customer_month_audit` HIGH) is the pre-billing analysis tool —
no longer a pipeline hold (its NOT EXISTS in the autopay builder remains the enforced
charge gate until the strict status gate is switched on). Both lists surface on
`/maintenance/billing/flags`. Review state for both lives in ONE table
(`customer_month_audit`): reviewing upserts a `REVIEW_2X` row (or updates a z-audit row);
`audit_status` reviewed/resolved releases `chem_flag` via re-projection.
