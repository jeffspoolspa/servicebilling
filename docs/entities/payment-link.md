# Entity: Payment-Invoice Link

> Lives in: `billing.payment_invoice_links`
> Source: [native]   (our domain data — the application of a payment to an invoice)
> Status: [active]

## What it is

A join row connecting a [Payment](payment.md) to the [Invoice](invoice.md) it was applied to. One payment can apply to multiple invoices and one invoice can receive multiple payments (including a card charge plus one or more credit-memo applications), so this is a many-to-many link.

This is **our** domain data — it records the allocation decision our pipeline made, distinct from QBO's own internal linkage. Credit-memo applications land here too, pairing a `customer_payments` row of `type='credit_memo'` with the invoice it offset.

## Connected entities

- [Payment](payment.md) (`billing.customer_payments`) — the money
- [Invoice](invoice.md) (`billing.invoices`) — the target

## Flows this entity participates in

- [work-order-to-payment](../flows/work-order-to-payment/index.md) — written when a charge or credit is applied
