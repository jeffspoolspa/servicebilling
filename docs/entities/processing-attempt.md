# Entity: Processing Attempt

> Lives in: `billing.processing_attempts`
> Source: [native]   (we own it; no external leader)
> Status: [active]

## What it is

An append-only log of CHARGE ATTEMPTS — our fact that we tried to collect.
One row each time `f/billing/_lib/payments.charge_and_record` (the shared
payment service; both the service and maintenance engines route through it)
tries to charge a card/ACH. This is the durable record that makes the charge
`[write-out]` recoverable: the row + its idempotency key COMMIT BEFORE the
external call; when Intuit times out, the row sits at `charge_uncertain` and
[reconcile_payments](../scripts/service_billing/reconcile_payments.md)
resolves it later without risking a double-charge.

## Target model (decided 2026-07-13 — the attempt/charge split)

Two rules, being migrated toward:

1. **Charge attempts ONLY.** No email-send rows, no pre-charge-halt rows, no
   error stubs — those outcomes live on the work-queue row (retry/dead-letter/
   error) and the cache echoes (`email_status`). The maintenance worker is
   already pure; `process_invoice` still writes a few non-charge rows because
   the WO detail timeline reads them — they narrow when the timeline moves to
   the queue + facts read-model (planned with the Open AR tab wiring).
2. **The attempt is OUR fact; the charge is INTUIT's fact — separate
   entities.** An attempt REFERS to a charge but is not one: Intuit assigns a
   charge its own identity (charge_id, amount, auth, card, CAPTURED/DECLINED
   — declines get ids too), and an attempt can exist with no charge at all.
   Today the attempt row embeds the charge (`charge_id`, `charge_result`
   jsonb) — the same leader-state blur ADR 008 §5 fixed on the cache side.
   Step 1 SHIPPED 2026-07-13 (migration `20260713190000`): `billing.charges`
   (reflection keyed by Intuit's charge_id, upserted by charge_and_record for
   success AND declines — which also fixed the same-PM decline gate, since
   declined attempts now carry their charge id) + `processing_attempts.lines`
   jsonb stamped on every fresh attempt. Remaining: reconcile_payments as a
   reflection writer; read models onto lines-joins; legacy columns relax.
   Attempt : charge is 1 : 0..1 (the persisted key means one attempt can
   never produce two charges).

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
