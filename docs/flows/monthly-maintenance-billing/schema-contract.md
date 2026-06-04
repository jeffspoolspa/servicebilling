# Monthly Maintenance Billing — Schema Contract (Layer 1)

> Status: [active]
> Flow: [index](index.md)

**Reads:**
- ION `home/customerLogDetails.cfm?dayindexsel=<date>` — every service log that day (LogID, calendarID, customer, service, status bullet).
- ION `tasks/addLog.cfm?LogID=<id>` — per-log ground truth: `EventID` (= the task), `TaskInvoiceID` (= the billed QBO invoice → customer), time-in/out, `LocID`, service, consumables (`item{qbo-ish id}=qty`).
- `ion.recurring_tasks` — the task census (one row per `ion_task_id`): `qbo_customer_id`, `service_location_id`, `task_price_cents` (**the authoritative per-visit rate**), `billing_type`, window.
- `maintenance.task_schedules` + `maintenance.tasks` — resolves `ion_task_id` → `task_id` (uuid) + governing rate/billing_method.
- `billing.invoices` — the QBO invoice mirror; `line_items[]` carry `item_id`, `item_name`, `qty`, `amount` per line.
- (`[design]`) `maintenance.service_types` — service → default per-visit rate. (`[design]`) `maintenance.consumable_items` — canonical consumable + unit/conversion + ion↔qbo id.

**Writes:**
- `maintenance.visits` — one row per completed log, keyed by `ion_log_id`. Sets `task_id`, `ion_task_id` (=EventID), `service_location_id`, `scheduled_date`, `is_serviceable`, `service_type`, `price_cents`, `ion_calendar_id`, generated `ion_addlog_url`. Unique index `visits_uniq_log_natural` on `(service_location_id, scheduled_date, service_type, pool_id, started_at)` NULLS NOT DISTINCT.
- `maintenance.consumables_usage` — `(visit_id, item_id, quantity, source='ion')`.
- `billing_audit.task_billing_periods` — one promise per `(task_id, billing_month)`: `expected_labor_cents`, `billable_visit_count`, `qbo_customer_id`, `consumables`, status.

**External calls:** ION (read logs); QBO (charge + send, in Phase B).

**Critical invariants:**
- A log is a real, billable visit iff it has a **time-in** (performed) — not whether it shows a "completed" bullet (a tech who never clocks out still gets billed).
- `ion.recurring_tasks.task_price_cents` is the authoritative per-visit rate. The number in a service *name* ("POOL MAINTENANCE 80") is a tier code, **not** the price.
- One invoice per task — but a task can be split across >1 invoice; reconcile aggregates invoices per task.
- `SALT CELL CLEAN` is a **consumable**, not labor. `QUALITY CONTROL` and `HALF HOUR MAINTENANCE` are non-labor.
