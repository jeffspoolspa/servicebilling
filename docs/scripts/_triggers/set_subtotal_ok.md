# trigger: set_subtotal_ok

> Status: [active]
> Kind: [trigger] Postgres trigger function (defined in a migration, not a Windmill script)
> Fires on: UPDATE OF `subtotal` on `billing.invoices` (and the matching WO `sub_total` change)

## Purpose

Maintains the `subtotal_ok` indicator on [billing.invoices](../../entities/invoice.md). True when the work order's `sub_total` (ION's view, cached) matches the invoice subtotal (QBO's view, cached) within $0.02.

This is a **drift check between two external systems** using our cache as the comparison point. A mismatch means line items were lost during the manual ION-to-QBO invoice push — see [work-order-to-payment](../../flows/work-order-to-payment/index.md) "Why subtotal_ok matters". When it flips false, the projection trigger holds the invoice at `needs_review` instead of charging.

## Writes
- `billing.invoices.subtotal_ok` (the indicator); the projection trigger then recomputes `billing_status`

## In which flows
- [work-order-to-payment](../../flows/work-order-to-payment/index.md) — the line-item-loss guard
