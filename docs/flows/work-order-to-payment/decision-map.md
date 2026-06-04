# Work Order → Payment — Business Rules (Decision Map, Layer 2)

> Status: [active]
> Flow: [index](index.md)
> Architecture rationale: [ADR 001](../../adrs/001-platform-architecture.md)

Three entities each run their own state machine — `work_orders.billing_status`,
`billing.invoices.billing_status`, and the payment (`customer_payments` + `processing_attempts`).
This flow is the coordination between them, plus the writes back to the external leaders. Edge
types per [ADR 001](../../adrs/001-platform-architecture.md): `[internal]` = our state; `[write-out]`
= we push to a leader; `[reflection]` = a leader change flows back via a sync flow.

## Pre-conditions (maintained by sync flows, not this flow)

- A closed, billable WO with `invoice_number` set — [ion-work-orders sync](../sync/ion-work-orders.md).
- The invoice cached from QBO — [qbo-invoices sync](../sync/qbo-invoices.md).
- The customer's payment methods cached — [qbo-payment-methods sync](../sync/qbo-payment-methods.md).

## Decision sequence

1. **Invoice lands** ([pull_qbo_invoices](../../scripts/service_billing/pull_qbo_invoices.md)) →
   `invoices.billing_status = awaiting_pre_processing`. `[reflection <- QBO]`
2. **Pre-process / enrich** ([pre_process_invoice](../../scripts/service_billing/pre_process_invoice.md)) →
   PATCH QBO memo / `PaymentMethodRef` / `ClassRef` / `TxnDate = wo.completed`; set `enrichment_ok`.
   `[write-out -> QBO]` + `[internal]`
3. **Indicator gates** — when all of `enrichment_ok`, `subtotal_ok`, `payment_method_ok`, `credits_ok`,
   `attempts_ok` are true → `invoices: awaiting_pre_processing → ready_to_process`, and a trigger
   promotes the linked `WO → ready_to_process`. Any gate false (especially `subtotal_ok`) →
   `needs_review` (held out of the charge path). `[internal]`
4. **Charge** ([process_work_order](../../scripts/service_billing/process_work_order.md) acquires a lock;
   `WO → processing`) → Intuit Payments charges the card → `charge_succeeded`.
   `[write-out -> Intuit Payments]`
5. **Record** → QBO Payment (`CCTransId`) applied to the invoice; receipt emailed. `[write-out -> QBO]`
6. **Reflect** → QBO webhook (`balance=0`, `EmailSent`) promotes `invoices → processed`
   (`trg_auto_promote_to_processed`); the final step moves `WO → processed`. `[reflection <- QBO]`

## The `subtotal_ok` gate (why it exists)

The manual ION-to-QBO invoice push (pre-condition above) can **drop line items**. `subtotal_ok`
compares the WO `sub_total` (ION's view) against the invoice subtotal (QBO's view) — a **drift check
between two external systems, using our cache as the comparison point**. A mismatch means line items
were lost in the sync, so the invoice is held at `needs_review` and never charged. Invisible from the
code without this context.

## Failure handling

- **subtotal mismatch / any indicator false** → `needs_review`; surfaced for a human; never charged.
- **Intuit times out / 5xx** → `charge_uncertain` (no reflection yet) →
  [reconcile_payments](../../scripts/service_billing/reconcile_payments.md) polls QBO (every 5 min)
  to confirm whether the charge actually landed.
- **Dropped pre_process `pg_net` trigger** →
  [dispatch_pre_processing](../../scripts/service_billing/dispatch_pre_processing.md) re-fires (every 60s).
- **Missing QBO webhook** → [cdc_reconciler](../../scripts/service_billing/cdc_reconciler.md) replays
  state via the CDC endpoint (every 15 min; [qbo-drift-reconciliation](../sync/qbo-drift-reconciliation.md)).

## Post-conditions

- `invoices.billing_status = processed` (balance 0, receipt emailed); `work_orders.billing_status = processed`.
- A `customer_payments` row + a QBO Payment recorded against the invoice.

## Invariants

- `needs_review` holds an invoice out of the charge path until a human clears it.
- The charge is idempotent + recoverable — one `processing_attempts` row per attempt; a retry never
  double-charges.
- We never write to ION; the WO mirror is read-only.
