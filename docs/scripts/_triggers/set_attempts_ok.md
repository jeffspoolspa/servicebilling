# trigger: set_attempts_ok

> Status: [active]
> Kind: [trigger] Postgres trigger function (defined in a migration, not a Windmill script)
> Fires on: `billing.processing_attempts` status change

## Purpose

Maintains the `attempts_ok` indicator on [billing.invoices](../../entities/invoice.md). True when there is no blocking failed attempt — i.e. the invoice isn't sitting behind a declined or uncertain charge that needs resolution first.

When [process_work_order](../service_billing/process_work_order.md) logs an attempt (or [reconcile_payments](../service_billing/reconcile_payments.md) resolves an uncertain one), the status change fires this trigger, which recomputes `attempts_ok`, which fires the projection trigger that sets `billing_status`.

## Writes
- `billing.invoices.attempts_ok` (the indicator); projection then recomputes `billing_status`

## In which flows
- [work-order-to-payment](../../flows/work-order-to-payment.md) — charge-attempt gate
