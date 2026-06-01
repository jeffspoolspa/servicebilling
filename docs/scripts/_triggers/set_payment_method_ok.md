# trigger: set_payment_method_ok

> Status: [active]
> Kind: [trigger] Postgres trigger function (defined in a migration, not a Windmill script)
> Fires on: payment-method resolution change (`trg_set_payment_method_ok_from_invoice`)

## Purpose

Maintains the `payment_method_ok` indicator on [billing.invoices](../../entities/invoice.md). True when a billable payment method (card/ACH on file) is resolved for the invoice.

Note: this trigger was at the center of the [pull_customer_payment_methods loop postmortem](../../audits/2026-05-27-database.md) — an earlier version fired on every `fetched_at` UPDATE, re-firing per-row on each 4h refresh and driving a compute-bill spike. The fix removed the `fetched_at` dependency and added an atomic-claim dedup on the PM-refresh request trigger.

## Writes
- `billing.invoices.payment_method_ok` (the indicator); projection then recomputes `billing_status`

## In which flows
- [work-order-to-payment](../../flows/work-order-to-payment.md) — payment-method gate
- [qbo-payment-methods sync](../../flows/sync/qbo-payment-methods.md) — what keeps PMs current
