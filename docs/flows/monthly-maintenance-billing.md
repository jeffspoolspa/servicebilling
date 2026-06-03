# Flow: Monthly Maintenance Billing

> Status: [active]
> Kind: [orchestration]
> Verification: [verified] for log-based ingestion + per-task LABOR reconcile (May 2026, 473/475 tasks exact); [design] for the canonical service-type/consumable tables, the consumables-quantity reconcile, and the full historical re-ingest
> Last verified: 2026-06-03
> Trigger: monthly (after the month closes); ingestion can run daily
> Code location: `f/ION/ingest_day_logs`, `f/ION/api/{list_day_logs,get_log_detail}`, `f/billing_audit/{build_task_billing_periods,reconcile_billing_periods}`, charging via `f/billing/monthly_autopay`
> Entities: [Visit](../entities/visit.md), [Task](../entities/task.md), [Task Billing Period](../entities/task-billing-period.md), [Invoice](../entities/invoice.md), [Autopay Transaction](../entities/autopay-transaction.md)

**One-line purpose:**
> ION services pools all month and bills one invoice per task; we independently rebuild
> each task's expected charge from the service logs and reconcile it against ION's actual
> invoice before charging the customer — so we catch billing errors instead of trusting ION blindly.

## The crux (and what changed 2026-06)

ION is the leader: it logs visits and, at month-end, emits **one invoice per task** (verified
against ION's "All Transactions" report — 527 invoices over 526 tasks, strictly 1 task per
invoice; the only exception is a task that gets a split/supplemental re-bill, so reconcile
**aggregates invoices per task**). Our job is to *independently reproduce* each task's expected
amount from the logs and reconcile.

The big change this session: visit ingestion moved from the lossy bulk report (which inferred
task and customer) to a **canonical log-based pipeline** keyed on each service log's unique
`LogID`. Every field is now read directly instead of inferred — which is what got May's
recurring labor to reconcile **473/475 tasks exactly**.

---

## Layer 0 — System map placement

| Container | Role |
|---|---|
| ION Pool Care | Source of truth. Per-day log list (`customerLogDetails.cfm`) + per-log detail (`addLog.cfm`). Emits the month-end invoices. |
| Windmill | Runs ingestion (enumerate→detail→upsert), promise build, reconcile, and the charge cycle. |
| Supabase | Caches visits/tasks/promises + the QBO invoice mirror; holds the canonical lookups. |
| QBO | The invoices ION syncs to; where we apply credits + charge. |

New to the system map? No — uses existing containers.

---

## Layer 1 — Schema contract

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

---

## Layer 2 — Decision map

### Ingestion (per day, `ingest_day_logs`)
1. **Enumerate** the day's logs (`list_day_logs`).
2. **Detail** each via `get_log_detail` (addLog).
3. **Keep** a log iff it has a `time_in` AND resolves to an `EventID` (a task). No time-in = not performed → skip. No EventID → skip (report as unresolved).
4. **Serviceable** = has time-in AND NOT (time-out present AND time-out == time-in). So missing time-out and reversed times are still serviceable/billable; only an explicit zero-duration is a skip.
5. **Price** = `task_price_cents` (override) → else service-type default (`[design]`) → else number parsed from the service name.
6. **Customer** flows through the task: `EventID` → `task_schedules` → `recurring_tasks.qbo_customer_id` (and `TaskInvoiceID` on the log corroborates it).
7. **Upsert** keyed by `LogID`; `ON CONFLICT (sl, date, service_type, pool_id, started_at) DO NOTHING` — multi-pool same-time logs collapse (billing collapses by (task, day) anyway).
8. Any `EventID` not in the census → pull the customer's tasks and add it (so every visit resolves to a task).

### Promise build (`build_task_billing_periods`, per (task, month))
- `billable_visit_count` = distinct **serviceable, non-QC** service-days (multiple logs/pools on a day collapse to one day).
- `expected_labor_cents` = flat task → the flat monthly amount; per_visit task → SUM over distinct days of that day's price.
- One promise per active task-month even with zero visits (a flat task still bills).

### Reconcile (`reconcile_billing_periods`, per task, against the QBO invoice)
- **Labor (amount):** our `expected_labor` vs the invoice's maintenance-SKU line amounts (POOL MAINTENANCE / FLAT RATE / CHEMICAL TESTING / SPA CLEAN / FOUNTAIN CLEAN / GREEN POOL / ONE TIME CLEAN), **excluding** SALT CELL CLEAN / HALF HOUR / QUALITY CONTROL. Aggregate invoices per task first. $1 tolerance.
- **Consumables (quantity)** (`[design]`): our `consumables_usage` per-item quantity vs the invoice's chemical-line `qty`. **Price not compared** (ION sets it at sync). Higher priority than labor. Needs the ion↔qbo item crosswalk (`maintenance.consumable_items`).
- **Billed visit count check:** the invoice's primary-SKU line `qty` = ION's billed visits; compare to our serviceable days to catch genuine ION↔QBO discrepancies (e.g. a missing log).

### Categories that are NOT a labor mismatch
- **One-time jobs** (GREEN POOL / ONE TIME CLEAN / FOUNTAIN CLEAN / SPA CLEAN): job-priced, separate invoices — don't expect visits×rate.
- **On-hold** invoices: not synced to QBO yet → genuinely absent, skip until synced.
- **QC**: non-billable labor; its consumables still bill.

### Failure handling
- Unresolved log (no EventID) / missing task → report; pull the task; never silently drop.
- Reconcile `mismatch` → hold the invoice + surface for review (do not charge).
- Ingest conflict on the natural key → dedupe (DO NOTHING), don't error.

### Post-conditions
- Every completed, performed log → exactly one visit linked to a task.
- Every active task-month → one promise; reconciled `labor_ok` (+ `consumables_ok` when the quantity check lands) before Phase B charges it.

### Phase B — processing (unchanged; mirrors per-WO [work-order-to-payment](work-order-to-payment.md))
Per reconciled invoice: apply credits → autopay decision → charge (card/ACH) or invoice-only → send → reflect balance. Engine: [monthly-autopay](monthly-autopay.md). Autopay roster is per-customer; processing is per-invoice (per task).

---

## Layer 3 — Flow map

```mermaid
sequenceDiagram
  participant ION as ION Pool Care
  participant W as Windmill
  participant DB as Supabase
  participant QBO as QuickBooks

  loop each day in range
    W->>ION: customerLogDetails (day) — list logs
    ION-->>W: logs (LogID, calendarID, service, status)
    W->>ION: addLog per log — detail
    ION-->>W: EventID, TaskInvoiceID, times, consumables
    W->>W: keep if time_in; serviceable rule; price=task_price_cents
    W->>DB: upsert maintenance.visits (key LogID) + consumables_usage
    Note over W,DB: ON CONFLICT(sl,date,service,pool,start) DO NOTHING
  end
  W->>DB: build_task_billing_periods (promises per task-month)
  W->>DB: read billing.invoices (QBO mirror)
  W->>W: reconcile per task — labor (aggregate invoices/task), consumables qty
  alt labor_ok (+ consumables_ok)
    W->>QBO: Phase B — credits, charge (if autopay), send
  else mismatch / missed
    W->>DB: hold + flag for review (no charge)
  end
```

---

## Status & open questions (the "as we decide" log)

**Verified (May 2026):** log-based ingestion + per-task LABOR reconcile = **473/475** recurring tasks exact. The 5 fixes that got it there: (1) ingest on time-in, not the completed bullet; (2) serviceable = not-zero-duration (reversed/missing times still count); (3) price from `task_price_cents`; (4) SALT CELL CLEAN → consumable; (5) aggregate invoices per task.

**Open / design (tomorrow's build):**
- `maintenance.service_types` (canonical service + default per-visit rate; task's custom amount overrides). Closes the one no-rate mismatch (COOK chem $30 → 475/475). Pattern: the existing `ion.task_definitions`/`task_aliases` + `normalize.py` alias-with-fallback approach, in the `maintenance` schema, fed into the **log-based** ingestion (not just the old `normalize.py`).
- `maintenance.consumable_items` (canonical consumable + unit + conversion + ion↔qbo id), so the **consumables-quantity reconcile** can run across all tasks (QC + one-time included). Today our `consumables_usage.item_id` is ION's addLog id with no name; the invoice carries QBO ids + names — different id spaces, no join yet.
- Full historical re-ingest 2025→2026 (same runner, wider range).
- Fold the per-task reconcile (invoice-aggregation, SALT CELL CLEAN exclusion) permanently into `reconcile_billing_periods.py`; sync the new ION scripts into the repo per [changing-the-system](../runbooks/changing-the-system.md).
- Resolved this session: the old "no recurring task sync" prerequisite gap — `ion.recurring_tasks` is now the census, and ingestion pulls any missing task on the fly.

## Cross-references
- Input logs: ION via `list_day_logs` + `get_log_detail`. Invoice mirror: [qbo-maintenance-invoices](sync/qbo-maintenance-invoices.md) / [load_month](../scripts/billing_audit/load_month.md).
- Charging engine: [monthly-autopay](monthly-autopay.md). Sibling (per-WO): [work-order-to-payment](work-order-to-payment.md).
- Entities: [Visit](../entities/visit.md), [Task](../entities/task.md), [Task Billing Period](../entities/task-billing-period.md), [Invoice](../entities/invoice.md).
- Decisions: [ADR 002 (ION API)](../adrs/002-ion-api-layer.md), [ADR 003 (unify invoice)](../adrs/003-unify-invoice-table.md), [ADR 001 (platform)](../adrs/001-platform-architecture.md).
