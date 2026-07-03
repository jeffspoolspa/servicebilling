# Monthly Maintenance Billing — Flow Map (Layer 3)

> Status: [active]
> Flow: [index](index.md)

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

**Steps (text equivalent — see [decision-map](decision-map.md) for the full rules; steps
3–6 are the stored `processing_status` pipeline, 2026-07-02):**
1. **Ingest** (per day) — `list_day_logs` → `get_log_detail` per log → keep if `time_in` + resolves to an `EventID` → upsert `maintenance.visits` (keyed `LogID`) + `consumables_usage`.
2. **Promise** — `build_task_billing_periods`: one `task_billing_periods` row per `(task, month)` with `expected_labor_cents` + `billable_visit_count`. Status `pending`, updated all month.
3. **ION match** — `match_promises_to_ion`: stamp each promise with its ION invoice number + amount from `ion_task_transactions` → `ion_matched` (or `needs_review: ion_amount_mismatch`). Runs (a) right after the UI's **Refresh bills** button pulls the ION report (`f/ION/transactions_report` — the deliberate MANUAL trigger, usable mid-month; no schedule) and (b) on the hourly reconcile as a backstop.
4. **QBO link** — invoice hits the `billing.invoices` cache (webhook/CDC) → `trg_link_invoice_to_maint_period` matches `doc_number` + customer → sets `qbo_invoice_id` + enqueues the customer-month (`maint_preprocess_queue`).
5. **Preprocess (queued, serial)** — `drain_maint_preprocess_queue` every 2 min runs `preprocess_maint_customer_month` one at a time: customer-scoped credit apply (no email) → projection evaluates HIGH flag / ION amount / subtotal (ION vs QBO total) / reconcile verdict → `needs_review` | `ready_to_process`.
6. **Reconcile (verdicts)** — `reconcile_billing_periods` hourly: labor amount ($1 tol) + consumable quantity per customer-month; verdict changes re-project via `trg_reproject_on_gate_change`. No longer writes the FK.
7. **Phase B** — per `ready_to_process` invoice (report-only gate first cycle, then enforced): autopay decision → charge or invoice-only → send → reflect balance ([monthly-autopay](../monthly-autopay.md)). Paid + sent in the cache → auto-promote to `processed` (also covers invoices processed by hand in QBO).

**Failure modes:**
| Failure | Where | Recovery |
|---|---|---|
| Log has no `EventID` / missing task | ingest | report; pull the task; never silently drop |
| Reconcile mismatch | reconcile | hold the invoice + surface for review (no charge) |
| Natural-key conflict on visit | ingest upsert | dedupe (`DO NOTHING`), don't error |
| On-hold invoice (not synced to QBO) | reconcile | skip until synced (not a mismatch) |
