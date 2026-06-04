# Work Order → Payment — Flow Map (Layer 3)

> Status: [active]
> Flow: [index](index.md)

```mermaid
sequenceDiagram
  participant ION
  participant DB as Supabase
  participant W as Windmill
  participant INT as Intuit Payments
  participant QBO as QuickBooks
  participant GM as Gmail
  ION-->>QBO: WO closed -> invoice created + number; manual ION->QBO push
  QBO-->>DB: qbo-invoices sync caches invoice (awaiting_pre_processing)
  W->>QBO: pre_process_invoice — PATCH memo / PM / class / TxnDate
  W->>DB: set enrichment_ok; evaluate subtotal_ok + indicators
  alt any indicator false (e.g. subtotal mismatch)
    W->>DB: invoice -> needs_review (held, not charged)
  else all indicators ok
    DB->>DB: invoice -> ready_to_process; WO -> ready_to_process
    W->>W: process_work_order acquires lock; WO -> processing
    W->>INT: charge card on file
    INT-->>W: CCTransId  (or timeout -> charge_uncertain)
    W->>QBO: record Payment (CCTransId) applied to invoice
    W->>GM: email receipt
    QBO-->>DB: webhook balance=0 + EmailSent -> invoice processed
    W->>DB: WO -> processed
  end
```

**Steps (click for detail):**
1. **Invoice cached** — [pull_qbo_invoices](../../scripts/service_billing/pull_qbo_invoices.md). `[reflection <- QBO]`
2. **Pre-process / enrich** — [pre_process_invoice](../../scripts/service_billing/pre_process_invoice.md). `[write-out -> QBO]`
3. **Indicator gates** — triggers on `billing.invoices`: [set_subtotal_ok](../../scripts/_triggers/set_subtotal_ok.md), [set_payment_method_ok](../../scripts/_triggers/set_payment_method_ok.md), [set_credits_ok](../../scripts/_triggers/set_credits_ok.md), [set_attempts_ok](../../scripts/_triggers/set_attempts_ok.md). `[internal]`
4. **Charge** — [process_work_order](../../scripts/service_billing/process_work_order.md) (lock → Intuit → record QBO Payment → receipt). `[write-out -> Intuit Payments]` then `[write-out -> QBO]`
5. **Reflect to processed** — QBO webhook (`trg_auto_promote_to_processed`); WO follows. `[reflection <- QBO]`

**Failure modes + backstops** (every write-out → reflection edge has a drift window; these scheduled scripts catch what slips):

| Failure | Where | Detected by | Recovery |
|---|---|---|---|
| Line items dropped in the ION→QBO push | invoice sync | `subtotal_ok = false` | `needs_review` hold; human re-pushes / fixes in ION+QBO |
| pre_process `pg_net` trigger dropped | step 2 | invoice stuck `awaiting_pre_processing` | [dispatch_pre_processing](../../scripts/service_billing/dispatch_pre_processing.md) — every 60s |
| Intuit timeout / 5xx | step 4 | payment `charge_uncertain` | [reconcile_payments](../../scripts/service_billing/reconcile_payments.md) — every 5 min, polls QBO |
| QBO webhook never arrives | step 5 reflection | invoice not promoted to `processed` | [cdc_reconciler](../../scripts/service_billing/cdc_reconciler.md) — every 15 min (CDC replay) |

**Concurrency:** the charge + QBO writes run under keys `qbo_api` / `intuit_payments` (the QBO OAuth
refresh token rotates — read the `quickbooks-windmill` skill before any QBO call). See
[CONCURRENCY_KEYS.md](../../conventions/CONCURRENCY_KEYS.md).
