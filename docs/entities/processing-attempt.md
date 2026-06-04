# Entity: Processing Attempt

> Lives in: `billing.processing_attempts`
> Source: [native]   (we own it; no external leader)
> Status: [active]

## What it is

An append-only log of charge attempts. One row each time [process_work_order](../scripts/service_billing/process_work_order.md) tries to charge a card/ACH. This is the durable record that makes the charge `[write-out]` recoverable: when Intuit Payments times out, the row sits at `charge_uncertain` and [reconcile_payments](../scripts/service_billing/reconcile_payments.md) resolves it later without risking a double-charge.

QBO has no concept of "we tried and don't know if it worked," so this state lives entirely with us. See [Payment](payment.md) for the full attempt lifecycle (the state diagram lives there).

## Connected entities

- [Payment](payment.md) — a succeeded attempt becomes a recorded `customer_payments` row
- [Invoice](invoice.md) / [Work Order](work-order.md) — the attempt is for a specific WO's invoice; status changes here maintain the `attempts_ok` indicator via [set_attempts_ok](../scripts/_triggers/set_attempts_ok.md)

## Flows this entity participates in

- [work-order-to-payment](../flows/work-order-to-payment/index.md) — written on every charge; drives `attempts_ok`

## Common queries

```sql
-- The reconcile_payments queue
SELECT * FROM billing.processing_attempts WHERE status = 'charge_uncertain';

-- Attempts a human needs to look at
SELECT * FROM billing.processing_attempts WHERE status = 'needs_reconcile_review';
```
