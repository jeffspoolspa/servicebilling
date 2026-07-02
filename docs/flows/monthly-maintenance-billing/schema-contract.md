# Monthly Maintenance Billing — Schema Contract (Layer 1)

> Status: [active]
> Flow: [index](index.md)

**Reads:**
- ION `home/customerLogDetails.cfm?dayindexsel=<date>` — every service log that day (LogID, calendarID, customer, service, status bullet).
- ION `tasks/addLog.cfm?LogID=<id>` — per-log ground truth: `EventID` (= the task), `TaskInvoiceID` (= the billed QBO invoice → customer), time-in/out, `LocID`, service, consumables (`item{qbo-ish id}=qty`).
- `ion.recurring_tasks` — the task census (one row per `ion_task_id`): `qbo_customer_id`, `service_location_id`, `task_price_cents` (**the authoritative per-visit rate**), `billing_type`, window.
- `maintenance.task_schedules` + `maintenance.tasks` — resolves `ion_task_id` → `task_id` (uuid) + governing rate/billing_method.
- `billing.invoices` — the QBO invoice mirror; `line_items[]` carry `item_id`, `item_name`, `qty`, `amount` per line.
- `maintenance.consumables` — the consumable/service item master (one row per `ion_item_id`; `unit_price_cents` = billed/QBO price). The 100%-coverage price lookup for `expected_consumable_cents`. `category` (2026-07-02) buckets every item for consumable-bill breakout: `core_chemical` | `specialty_chemical` | `spa` | `testing` | `replacement_part` | `extra_service` | `discount`. A NEW item lands with `category` NULL on purpose — classify deliberately; name patterns cannot be trusted for part numbers.
- `billing_audit.ion_task_transactions` — ION's "All Transactions" report (TransactionType=Tasks): one row per ION task invoice (`transaction_id` PK; `month`, `ion_task_id`, `amt_cents`, customer, service_name, status, transaction_date). Pulled on demand by `f/ION/transactions_report` (browser form-submit prime; see [integrations/ion.md](../../integrations/ion.md)). The reconcile compares expected vs `sum(amt_cents)` per `(month, ion_task_id)`. Supersedes hand-loaded scratch imports (`billing_audit._ion_june_import`).
- `billing_audit.v_customer_month_cpv` — the PRE-BILLING AUDIT source (billing-audit skill v2): live customer-month rollup from visits. CPV = (core + specialty + spa consumables) / recurring serviceable visit-days; other categories exposed as drill-down columns. Peer groups: `commercial` (Customers.company filled) | `high_freq_residential` (dominant task >2 days/wk) | `low_freq` (dominant monthly/biweekly) | `weekly_residential`. Frequency comes from the customer's DOMINANT task that month (most billable visits) so a closed one-off cannot reclassify a customer.
- `billing_audit.customer_month_audit` — flagged customer-months from the CPV z-score audit (HIGH | WATCH | SELF_SPIKE | PCT_SPIKE; `audit_status` flagged → reviewed/resolved). Runs BEFORE the QBO sync so misbillings are fixed in ION first. HIGH flags are held from autopay/sending until reviewed — enforced in the autopay list builder (`monthly_autopay` build step) and `send_monthly_invoices` via `NOT EXISTS` on unreviewed HIGH rows; reviewed via the `/maintenance/billing/flags` UI (`public.maint_billing_flag_review`).
- `public.maint_billing_*` RPCs (migration `20260702100000`) — the app-facing read surface for the `/maintenance/billing` UI (billing_audit is not PostgREST-exposed): `maint_billing_months` (month rollups), `maint_billing_periods` (promises joined with customer, `maintenance.v_task_class`, ION transaction sums, the `billing.invoices` mirror, and a DERIVED processing status: pending → synced_to_qbo → processed → paid), `maint_billing_flags` + `maint_billing_flag_items` (CPV flag review + per-item drill-down), `maint_billing_flag_review` (the one write: audit_status/audit_notes). SECURITY DEFINER, authenticated-only.
- (`[design]`) `maintenance.service_types` — service → default per-visit rate. (`[design]`) `maintenance.consumable_items` — canonical consumable + unit/conversion + ion↔qbo id.

**Writes:**
- `maintenance.visits` — one row per completed log, keyed by `ion_log_id`. Sets `task_id`, `ion_task_id` (=EventID), `service_location_id`, `scheduled_date`, `is_serviceable`, `service_type`, `price_cents`, `ion_calendar_id`, generated `ion_addlog_url`. Unique index `visits_uniq_log_natural` on `(service_location_id, scheduled_date, service_type, pool_id, started_at)` NULLS NOT DISTINCT.
- `maintenance.consumables_usage` — `(visit_id, item_id, quantity, source='ion')`.
- `billing_audit.task_billing_periods` — one promise per `(task_id, billing_month)`: `expected_labor_cents`, `billable_visit_count`, `qbo_customer_id`, `consumables` (`{item_name: qty}`), `expected_consumable_cents` (Model B: `SUM(qty × unit_price_cents)` priced by `ion_item_id` → `maintenance.consumables`), `unpriced_consumables`, generated `expected_total_cents`, status. See [entity doc](../../entities/task-billing-period.md) for the full rollup.

**External calls:** ION (read logs); QBO (charge + send, in Phase B).

**Critical invariants:**
- A log is a real, billable visit iff it has a **time-in** (performed) — not whether it shows a "completed" bullet (a tech who never clocks out still gets billed).
- `ion.recurring_tasks.task_price_cents` is the authoritative per-visit rate. The number in a service *name* ("POOL MAINTENANCE 80") is a tier code, **not** the price.
- One invoice per task — but a task can be split across >1 invoice; reconcile aggregates invoices per task.
- `SALT CELL CLEAN` is a **consumable**, not labor. `QUALITY CONTROL` and `HALF HOUR MAINTENANCE` are non-labor.
- Billing-type semantics (from `tasks.external_data->>'billing_type'`, June 2026 reconcile): `Do Not Invoice` → ION creates NO task invoice (expected $0); `... (separate consumables)` → the task invoice is **labor-only**, chem bills as separate Consumables transactions outside the Tasks report; `... (list consumables)` → task invoice = labor + consumables (the straight compare).
- Late ION edits are real: techs add/change consumables on a log AFTER our ingest window (3-day lookback by visit date — an edit to an older log escapes it). Before freezing a month, re-scrape that month's visit logs; quantity edits don't change row counts, so compare priced totals, not counts.
