# f/service_billing/reconcile_payments

> Status: [active]
> Source: [f/service_billing/reconcile_payments.py](../../../f/service_billing/reconcile_payments.py)
> Triggered by: [schedule] every 5 minutes
> Concurrency: (none) — read-only to external systems, idempotent

## Purpose

Resolves `billing.processing_attempts` rows stuck at `charge_uncertain`. When a charge call to Intuit Payments returns a 5xx / timeout / network error, we don't know if money moved — [process_work_order](process_work_order.md) writes `charge_uncertain` and halts to avoid double-charging. Without this reconciler, those rows sit forever. This is the backstop that closes the drift window on the Intuit `[write-out]` edge.

For each uncertain attempt in the lookback window (`LOOKBACK_DAYS=7`), it queries Intuit Payments for a charge matching the customer's `cardOnFile` + amount within a time window around `attempted_at`, then:
- **Match found** -> `charge_succeeded` (process_work_order's auto-resume writes the QBO Payment next run)
- **No match, > 24h old** -> `charge_uncertain_expired` (idempotency cache gone; safe to retry with a new key)
- **No match, < 24h old** -> leave at `charge_uncertain` (could still be in flight)
- **No match after 7d** -> `needs_reconcile_review` (human takes a look)

## Reads
- `billing.processing_attempts` (status = `charge_uncertain`, within lookback)
- Intuit Payments `/v4/payments/charges` (read-only)

## Writes
- `billing.processing_attempts` (status transitions only — never writes to QBO or Intuit)

## In which flows
- [work-order-to-payment](../../flows/work-order-to-payment.md) — backstop for the `charge_uncertain` state
