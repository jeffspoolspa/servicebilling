# Entity: Payment Method

> Lives in: cached QBO payment methods per customer (card/ACH on file)
> Source: [cache: QBO]
> Status: [stub]

## What it is

A customer's card or bank account on file, cached from QBO so [process_work_order](../scripts/service_billing/process_work_order.md) can charge without a live QBO round-trip at charge time. The `payment_method_ok` indicator on [Invoice](invoice.md) is true when a billable PM is resolved here.

> This is a stub. Fill in: the exact table/columns, the freshness gate (`Customers.pm_last_checked_at`), and the atomic-claim dedup added after the [pull_customer_payment_methods loop postmortem](../audits/2026-05-27-database.md). The loop happened because a PM-refresh request trigger fired per-row on every 4h invoice refresh — the fix was a 60s atomic-claim guard so each customer is refreshed at most once per minute.

## Connected entities

- [Customer](customer.md) via `qbo_customer_id`
- [Invoice](invoice.md) — resolves the `payment_method_ok` indicator via [set_payment_method_ok](../scripts/_triggers/set_payment_method_ok.md)

## Flows this entity participates in

- [qbo-payment-methods sync](../flows/sync/qbo-payment-methods.md) — keeps PMs current
