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

**Steps (text equivalent — see [decision-map](decision-map.md) for the full rules):**
1. **Ingest** (per day) — `list_day_logs` → `get_log_detail` per log → keep if `time_in` + resolves to an `EventID` → upsert `maintenance.visits` (keyed `LogID`) + `consumables_usage`.
2. **Promise** — `build_task_billing_periods`: one `task_billing_periods` row per `(task, month)` with `expected_labor_cents` + `billable_visit_count`.
3. **Reconcile** — `reconcile_billing_periods`: per task, aggregate its QBO invoices, compare labor amount ($1 tolerance) + (design) consumable quantity + billed-visit count.
4. **Gate** — `labor_ok` (+ `consumables_ok`) → Phase B charges; `mismatch`/missed → hold + flag, no charge.
5. **Phase B** — per reconciled invoice: credits → autopay decision → charge or invoice-only → send → reflect balance ([monthly-autopay](../monthly-autopay.md)).

**Failure modes:**
| Failure | Where | Recovery |
|---|---|---|
| Log has no `EventID` / missing task | ingest | report; pull the task; never silently drop |
| Reconcile mismatch | reconcile | hold the invoice + surface for review (no charge) |
| Natural-key conflict on visit | ingest upsert | dedupe (`DO NOTHING`), don't error |
| On-hold invoice (not synced to QBO) | reconcile | skip until synced (not a mismatch) |
