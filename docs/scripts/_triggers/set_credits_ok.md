# trigger: set_credits_ok

> Status: [active]
> Kind: [trigger] Postgres trigger function (defined in a migration, not a Windmill script)
> Fires on: `billing.customer_payments` change (`fn_set_credits_ok_from_payment`)

## Purpose

Maintains the `credits_ok` indicator on [billing.invoices](../../entities/invoice.md). True when there are no unallocated credits flagged for the invoice's customer that should have been applied first.

When [pre_process_invoice](../service_billing/pre_process_invoice.md) auto-applies a credit, it decrements `customer_payments.unapplied_amt`; that UPDATE fires this trigger, which recomputes `credits_ok`, which fires the projection trigger that sets `billing_status`.

## Writes
- `billing.invoices.credits_ok` (the indicator); projection then recomputes `billing_status`

## In which flows
- [work-order-to-payment](../../flows/work-order-to-payment.md) — credit-application gate
