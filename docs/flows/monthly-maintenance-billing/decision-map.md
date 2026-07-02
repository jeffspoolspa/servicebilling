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
(via `/maintenance/billing/flags`). The hold is per invoice-month: the flagged month is held,
the customer's other unpaid months still process. Held invoices stay `pending` and are picked
up by the next run after review — no state to reset.

**Processing status (derived, UI-only):** the `/maintenance/billing` view derives
pending → synced_to_qbo (`qbo_invoice_id` set) → processed (confirmed non-dry-run
`autopay_transactions` charge OR invoice emailed) → paid (`billing.invoices.balance <= 0`)
in `public.maint_billing_periods`. Nothing stores this — the sources of truth stay where they are.
